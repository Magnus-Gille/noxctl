/**
 * Operator commands for the unpublished pilot host (NOX-214). Each is one explicit step; nothing
 * drains, retries or reconciles automatically. Results are returned (not printed) so tests and the
 * CLI share one implementation.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalEncode, decode } from '../shadow/codec.js';
import { isOperatorRefused } from '../shadow/operator-refusal.js';
import { PAYMENT_OPERATIONS } from '../shadow/payment-queue-plan.js';
import type { SourceEvidenceKind } from '../shadow/queue.js';
import { creditNoteNumber, paymentVoucherRef } from '../shadow/source-evidence.js';
import type { ShadowPaymentGroup, ShadowRecord, ShadowState } from '../shadow/types.js';
import type { PilotHost } from './host.js';
import { PilotLockError } from './lock.js';

export interface CommandResult {
  ok: boolean;
  message: string;
  hash?: string;
  request?: unknown;
  state?: ShadowState;
  warnings?: string[];
}
const refuse = (message: string): CommandResult => ({ ok: false, message: `Refused: ${message}` });

/** Whole-command exclusion across processes; a held lock is a refusal, never a wait or a takeover. */
async function locked(
  host: PilotHost,
  command: string,
  fn: () => Promise<CommandResult>,
): Promise<CommandResult> {
  try {
    return await host.withLock(command, fn);
  } catch (error) {
    if (error instanceof PilotLockError) return refuse(error.message);
    throw error;
  }
}

const PREVIEW_MAX_AGE_MS = 15 * 60_000;
const DRAINABLE_OPERATIONS = new Set([
  'createCustomer',
  'baselineCustomer',
  'baselineArticle',
  'createInvoice',
  'creditInvoice',
  'markInvoicePrinted',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,199}$/;

function oldestUnresolved(host: PilotHost): ShadowRecord | undefined {
  return host.queue
    .snapshot()
    .map((entry) => entry.record)
    .find(
      (record) =>
        record.state !== 'applied' &&
        record.state !== 'source_cancelled' &&
        !isOperatorRefused(record),
    );
}
const isDrainable = (record: ShadowRecord) =>
  record.state === 'pending' || record.state === 'retry_wait';

/** Hash binds the exact request to the intent, the two companies and the reviewed host revision. */
export function previewHash(host: PilotHost, record: ShadowRecord, request: unknown): string {
  return createHash('sha256')
    .update(
      canonicalEncode({
        id: record.id,
        operation: record.operation,
        requestHash: record.requestHash,
        request,
        binding: {
          sourceCompany: host.config.sourceCompany,
          targetCompany: host.config.targetCompany,
        },
        revision: host.config.revision,
      }),
    )
    .digest('hex');
}

type Prepared = { record: ShadowRecord; request: unknown } | { error: string };
/** The next drainable record, prepared (pure, no network). */
function prepareOldest(host: PilotHost, id: string): Prepared {
  if (!ID.test(id)) return { error: 'invalid record id' };
  const record = host.queue.get(id);
  if (!record) return { error: 'unknown record id' };
  const oldest = oldestUnresolved(host);
  if (oldest?.id !== id)
    return { error: `${id} is not the oldest unresolved record (that is ${oldest?.id ?? 'none'})` };
  if (!isDrainable(record)) return { error: `record is ${record.state}, not pending` };
  if (!DRAINABLE_OPERATIONS.has(record.operation))
    return { error: `operation ${record.operation} is outside the pilot` };
  const adapter = host.adapterFor(record.operation);
  if (!adapter) return { error: `operation ${record.operation} has no adapter` };
  let prepared: ReturnType<typeof adapter.prepare>;
  try {
    prepared = adapter.prepare(decode(canonicalEncode(record)) as ShadowRecord);
  } catch (error) {
    return { error: `mapping failed (${error instanceof Error ? error.name : 'Error'})` };
  }
  if ('blocked' in prepared) return { error: `mapping refuses this record: ${prepared.blocked}` };
  return { record, request: prepared.request };
}

export async function statusCommand(host: PilotHost): Promise<CommandResult> {
  const status = host.queue.status();
  const lines: string[] = [
    `binding: Fortnox ${status.binding.sourceCompany} -> Accounted ${status.binding.targetCompany}`,
    `counts: ${
      Object.entries(status.counts)
        .filter(([, n]) => n > 0)
        .map(([state, n]) => `${state}=${n}`)
        .join(' ') || 'empty'
    }`,
    `oldest unapplied age: ${
      status.oldestUnappliedAgeMs === null
        ? 'none'
        : `${Math.round(status.oldestUnappliedAgeMs / 1000)}s`
    }`,
    `storage: ${host.isStorageOk() ? 'ok' : 'NOT OK (backup pending/failed)'}`,
  ];
  const open = status.items.filter((i) => i.state !== 'applied' && i.state !== 'source_cancelled');
  lines.push(open.length ? 'not applied:' : 'not applied: none');
  for (const item of open)
    lines.push(
      `  ${item.id} ${item.operation} ${item.state}${item.reason ? ` - ${item.reason}` : ''}`,
    );
  lines.push('applied (source number -> target id):');
  for (const { record } of host.queue.snapshot()) {
    if (record.state !== 'applied') continue;
    const source = record.sourceResult as Record<string, unknown> | undefined;
    const field: Record<string, string> = {
      createCustomer: 'CustomerNumber',
      baselineCustomer: 'CustomerNumber',
      baselineArticle: 'ArticleNumber',
      createInvoice: 'DocumentNumber',
    };
    const key = field[record.operation];
    if (key && source && typeof source[key] === 'string')
      lines.push(`  ${record.operation} ${source[key] as string} -> ${record.targetId}`);
  }
  host.acknowledge();
  return { ok: true, message: lines.join('\n') };
}

/** Hash of a payment group preview: members (id, operation, request hash), the plan, binding, revision. */
export function paymentPreviewHash(
  host: PilotHost,
  group: ShadowPaymentGroup,
  request: unknown,
): string {
  return createHash('sha256')
    .update(
      canonicalEncode({
        kind: 'invoice-payment-group',
        members: group.members.map(({ record }) => [
          record.id,
          record.operation,
          record.requestHash,
        ]),
        request,
        binding: {
          sourceCompany: host.config.sourceCompany,
          targetCompany: host.config.targetCompany,
        },
        revision: host.config.revision,
      }),
    )
    .digest('hex');
}
/** The oldest unresolved record is part of a payment chain: preview/drain-one take its whole group. */
function paymentAtHead(host: PilotHost, id: string): boolean {
  const oldest = oldestUnresolved(host);
  return oldest !== undefined && PAYMENT_OPERATIONS.has(oldest.operation) && ID.test(id);
}
async function previewPaymentGroup(host: PilotHost, id: string) {
  return host.queue.drainPaymentGroupExpected(
    host.paymentAdapter,
    { memberId: id, digestOf: (group, request) => paymentPreviewHash(host, group, request) },
    'preview',
  );
}
function writePreview(host: PilotHost, id: string, hash: string): void {
  const dir = join(host.directory, 'previews');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ hash, createdAt: host.now(), osUser: host.osUser() }), {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}
/** The stored preview of `id` must carry `hash`, be fresh and come from this OS user. */
function storedPreviewProblem(host: PilotHost, id: string, hash: string): string | undefined {
  let file: { hash?: unknown; createdAt?: unknown; osUser?: unknown };
  try {
    file = JSON.parse(readFileSync(join(host.directory, 'previews', `${id}.json`), 'utf8'));
  } catch {
    return 'no preview for this record; run preview first';
  }
  const age = host.now() - Number(file.createdAt);
  if (file.hash !== hash) return 'hash does not match the stored preview';
  if (!Number.isFinite(age) || age < 0 || age >= PREVIEW_MAX_AGE_MS)
    return 'preview is stale; run preview again';
  if (file.osUser !== host.osUser()) return 'preview was made by another OS user';
  return undefined;
}

export async function previewCommand(host: PilotHost, id: string): Promise<CommandResult> {
  if (paymentAtHead(host, id)) {
    const preview = await previewPaymentGroup(host, id);
    if (!('preview' in preview))
      return refuse('reason' in preview ? preview.reason : 'payment group is not previewable');
    writePreview(host, id, preview.digest);
    const members = preview.group.members.map(({ record }) => record.id).join(', ');
    return {
      ok: true,
      hash: preview.digest,
      request: preview.request,
      message: `payment group ${preview.group.id}\nmembers: ${members}\n${JSON.stringify(preview.request, null, 2)}\nhash = ${preview.digest}\nnext: drain-one ${id} ${preview.digest}`,
    };
  }
  const prepared = prepareOldest(host, id);
  if ('error' in prepared) return refuse(prepared.error);
  const hash = previewHash(host, prepared.record, prepared.request);
  writePreview(host, id, hash);
  return {
    ok: true,
    hash,
    request: prepared.request,
    message: `${JSON.stringify(prepared.request, null, 2)}\nhash = ${hash}\nnext: drain-one ${id} ${hash}`,
  };
}

function populated(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('@'))
        .map(([key, entry]) => [key, normalize(entry)] as const)
        .filter(([, entry]) => populated(entry)),
    );
  return value;
}
/** Names (never values) of top-level keys whose normalized value differs. */
function changedKeys(stored: unknown, current: unknown): string[] {
  const a = normalize(stored) as Record<string, unknown>;
  const b = normalize(current) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !isDeepStrictEqual(a[key], b[key]))
    .sort();
}
function invoiceNumber(record: ShadowRecord): string | undefined {
  const value = (record.sourceResult as Record<string, unknown> | undefined)?.DocumentNumber;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : undefined;
}
function lifecycleFlags(invoice: Record<string, unknown>): string[] {
  return ['Booked', 'Sent', 'Cancelled'].filter((key) => invoice[key] === true);
}

export async function drainOneCommand(
  host: PilotHost,
  id: string,
  hash: string,
): Promise<CommandResult> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return refuse('hash must be 64 lowercase hex characters');
  return locked(host, 'drain-one', () => drainOneLocked(host, id, hash));
}

async function drainOneLocked(host: PilotHost, id: string, hash: string): Promise<CommandResult> {
  if (paymentAtHead(host, id)) return drainPaymentGroupLocked(host, id, hash);
  const first = prepareOldest(host, id);
  if ('error' in first) return refuse(first.error);
  const gate = await host.checkGate(id);
  if (!gate.ok) return refuse(`write gate: ${gate.reason}`);

  const stale = storedPreviewProblem(host, id, hash);
  if (stale) return refuse(stale);
  if (previewHash(host, first.record, first.request) !== hash)
    return refuse('the request changed since preview (drift); run preview again');

  const isInvoice = first.record.operation === 'createInvoice';
  const number = isInvoice ? invoiceNumber(first.record) : undefined;
  if (isInvoice) {
    if (!number) return refuse('stored invoice has no usable DocumentNumber');
    let current: Record<string, unknown>;
    try {
      current = await host.operations.getInvoice(number);
    } catch {
      return refuse('Fortnox invoice could not be read before the drain');
    }
    const flags = lifecycleFlags(current);
    if (flags.length) return refuse(`Fortnox invoice is now ${flags.join(', ')}`);
    const changed = changedKeys(first.record.sourceResult, current);
    if (changed.length)
      return refuse(`Fortnox invoice changed since creation (${changed.join(', ')})`);
  }

  const adapter = host.adapterFor(first.record.operation)!;
  const warnings: string[] = [];
  try {
    host.beginMutation();
  } catch {
    return refuse('nothing was dispatched: backup marker could not be made durable');
  }
  let refusal: string | undefined;
  try {
    // Claims only the previewed record AND request, decided inside the claim transaction.
    const outcome = await host.queue.drainExpected(adapter, {
      id,
      expectedDigest: hash,
      digestOf: (record, request) => previewHash(host, record, request),
      beforeApply: (record) => host.journalTarget(record),
    });
    if (!outcome.claimed) refusal = outcome.reason;
  } finally {
    const backup = await host.afterMutation();
    if (!backup.ok) warnings.push(`backup failed: ${backup.reason}`);
    rmSync(join(host.directory, 'previews', `${id}.json`), { force: true });
  }
  if (refusal !== undefined)
    return refuse(`nothing was dispatched: ${refusal}${warnings.map((w) => `; ${w}`).join('')}`);
  const after = host.queue.get(id)!;
  if (isInvoice && after.state === 'applied') {
    try {
      const current = await host.operations.getInvoice(number!);
      const flags = lifecycleFlags(current);
      const changed = changedKeys(first.record.sourceResult, current);
      if (flags.length || changed.length)
        warnings.push(
          `Fortnox invoice changed during the drain (${[...flags, ...changed].join(', ')}); nothing was undone`,
        );
    } catch {
      warnings.push('Fortnox invoice could not be re-read after the drain');
    }
  }
  const applied = after.state === 'applied';
  const lines = [`${id}: ${after.state}${after.reason ? ` - ${after.reason}` : ''}`];
  if (after.targetId) lines.push(`target id: ${after.targetId}`);
  if (after.state === 'target_unknown')
    lines.push('Outcome unknown. Do not retry. Reconcile read-only or abandon the pilot company.');
  lines.push(...warnings.map((w) => `warning: ${w}`));
  return { ok: applied, state: after.state, message: lines.join('\n'), warnings };
}

const PAYMENT_FIELDS = [
  'Number',
  'InvoiceNumber',
  'Amount',
  'PaymentDate',
  'VoucherYear',
  'VoucherSeries',
  'VoucherNumber',
];
/** The booked payment in Fortnox must still be the one in the group's receipt. */
async function paymentDrift(
  host: PilotHost,
  group: ShadowPaymentGroup,
): Promise<string | undefined> {
  let current: Record<string, unknown>;
  try {
    current = await host.operations.getInvoicePayment(group.sourcePaymentId);
  } catch {
    return `Fortnox payment ${group.sourcePaymentId} could not be read before the drain`;
  }
  const receipt = group.sourceResult as Record<string, unknown>;
  const changed = PAYMENT_FIELDS.filter(
    (key) => !isDeepStrictEqual(receipt?.[key], current?.[key]),
  );
  if (current?.Booked !== true) changed.unshift('Booked');
  return changed.length
    ? `Fortnox payment ${group.sourcePaymentId} changed since bookkeeping (${changed.join(', ')})`
    : undefined;
}

async function drainPaymentGroupLocked(
  host: PilotHost,
  id: string,
  hash: string,
): Promise<CommandResult> {
  const first = await previewPaymentGroup(host, id);
  if (!('preview' in first))
    return refuse('reason' in first ? first.reason : 'payment group is not drainable');
  const memberIds = first.group.members.map(({ record }) => record.id);
  const gate = await host.checkGate(memberIds);
  if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
  const stale = storedPreviewProblem(host, id, hash);
  if (stale) return refuse(stale);
  if (first.digest !== hash)
    return refuse('the payment group changed since preview (drift); run preview again');
  const drift = await paymentDrift(host, first.group);
  if (drift) return refuse(drift);
  const warnings: string[] = [];
  try {
    host.beginMutation();
  } catch {
    return refuse('nothing was dispatched: backup marker could not be made durable');
  }
  let refusal: string | undefined;
  let state: string | undefined;
  try {
    const outcome = await host.queue.drainPaymentGroupExpected(
      host.paymentAdapter,
      {
        memberId: id,
        expectedDigest: hash,
        digestOf: (group, request) => paymentPreviewHash(host, group, request),
        // One durable journal row per member before any Accounted request.
        beforeApply: (group) => {
          for (const { record } of group.members) host.journalTarget(record);
        },
      },
      'drain',
    );
    if ('reason' in outcome) refusal = outcome.reason;
    else if (outcome.claimed) state = outcome.state;
  } finally {
    const backup = await host.afterMutation();
    if (!backup.ok) warnings.push(`backup failed: ${backup.reason}`);
    rmSync(join(host.directory, 'previews', `${id}.json`), { force: true });
  }
  if (refusal !== undefined)
    return refuse(`nothing was dispatched: ${refusal}${warnings.map((w) => `; ${w}`).join('')}`);
  const lines = memberIds.map((memberId) => {
    const record = host.queue.get(memberId)!;
    return `${memberId}: ${record.state}${record.reason ? ` - ${record.reason}` : ''}`;
  });
  const after = host.queue.get(id)!;
  if (after.targetId) lines.push(`target id: ${after.targetId}`);
  if (state === 'unknown')
    lines.push('Outcome unknown. Do not retry. Reconcile read-only or abandon the pilot company.');
  lines.push(...warnings.map((w) => `warning: ${w}`));
  return {
    ok: state === 'applied' && warnings.length === 0,
    state: after.state,
    message: lines.join('\n'),
    warnings,
  };
}

function nextStep(host: PilotHost, id: string): string {
  const oldest = oldestUnresolved(host);
  return oldest?.id === id
    ? `next: preview ${id}`
    : `queued behind ${oldest?.id}; preview ${oldest?.id} first`;
}
const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

async function stagedBaseline(
  host: PilotHost,
  operation: 'baselineCustomer' | 'baselineArticle',
  identityKind: 'customer' | 'article',
  sourceNumber: string,
  id: string,
  args: unknown[],
  read: () => Promise<Record<string, unknown>>,
): Promise<CommandResult> {
  return locked(host, operation, async () => {
    // The gate is evaluated under the lock so it sees every completed mutation and its backup.
    const gate = await host.checkGate();
    if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
    if (host.queue.resolveIdentity(identityKind, sourceNumber).state !== 'missing')
      return refuse(`${identityKind} ${sourceNumber} already has a queue record`);
    try {
      host.beginMutation();
    } catch {
      return refuse('nothing was done: backup marker could not be made durable');
    }
    try {
      await host.queue.execute({ id, operation, args }, read);
    } finally {
      const backup = await host.afterMutation();
      if (!backup.ok) host.log(`pilot: ${backup.reason}`);
    }
    return {
      ok: true,
      message: `recorded ${id} (pending); no Accounted request was made\n${nextStep(host, id)}`,
    };
  });
}

export async function baselineCustomerCommand(
  host: PilotHost,
  customerNumber: string,
): Promise<CommandResult> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(customerNumber)) return refuse('invalid CustomerNumber');
  return stagedBaseline(
    host,
    'baselineCustomer',
    'customer',
    customerNumber,
    `baseline-c-${customerNumber}-${host.now()}`,
    [{ CustomerNumber: customerNumber }],
    () => host.operations.getCustomer(customerNumber),
  );
}

export async function linkArticleCommand(
  host: PilotHost,
  articleNumber: string,
  targetArticleId: string,
): Promise<CommandResult> {
  if (
    !articleNumber ||
    articleNumber.length > 200 ||
    articleNumber.trim() !== articleNumber ||
    /[\u0000-\u001f\u007f-\u009f]/.test(articleNumber)
  )
    return refuse('invalid ArticleNumber');
  if (!UUID.test(targetArticleId)) return refuse('target article id must be a lowercase UUID');
  return stagedBaseline(
    host,
    'baselineArticle',
    'article',
    articleNumber,
    `link-a-${sha12(articleNumber)}-${host.now()}`,
    [{ ArticleNumber: articleNumber, targetArticleId }],
    () => host.operations.getArticle(articleNumber),
  );
}

/**
 * Read-only reconciliation of a `target_unknown` record that kept its target identity and receipt
 * (e.g. a create whose readback failed). It only reads the target (adapter verify); it never sends
 * another mutation. On a match the record becomes `applied`; otherwise it stays unknown.
 */
export async function reconcileCommand(host: PilotHost, id: string): Promise<CommandResult> {
  return locked(host, 'reconcile', async () => {
    const record = host.queue.get(id);
    if (!record) return refuse(`no record ${id}`);
    if (record.state !== 'target_unknown')
      return refuse(`record is ${record.state}; only target_unknown can be reconciled`);
    if (!record.targetId || !record.targetReceipt)
      return refuse(
        'the unknown outcome has no durable target identity; reconcile by hand against Accounted and Fortnox',
      );
    if (record.paymentGroup) return reconcilePaymentLocked(host, record);
    const adapter = host.adapterFor(record.operation);
    if (!adapter?.verify) return refuse(`no read-only verifier for ${record.operation}`);
    // Every other gate condition still applies (storage, journal, restore ack, Fortnox company).
    const gate = await host.checkGate(id, ['target_unknown']);
    if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
    try {
      host.beginMutation();
    } catch {
      return refuse('backup marker could not be made durable');
    }
    let matched = false;
    let failure: string | undefined;
    let backupFailure: string | undefined;
    try {
      matched = await host.queue.reconcileTarget(id, adapter);
    } catch (error) {
      failure = error instanceof Error ? error.name : 'Error';
    } finally {
      const backup = await host.afterMutation();
      if (!backup.ok) backupFailure = `backup failed: ${backup.reason}`;
    }
    const state = host.queue.get(id)!.state;
    if (matched && state === 'applied')
      return backupFailure
        ? {
            ok: false,
            state,
            message: `${id}: applied (target read back and matched), but ${backupFailure}; further writes stay gated until \`backup\` succeeds`,
          }
        : { ok: true, state, message: `${id}: applied (target read back and matched)` };
    if (backupFailure) failure = `${failure ? `${failure}; ` : ''}${backupFailure}`;
    return {
      ok: false,
      state,
      message: `${id}: still ${state}${failure ? ` (${failure})` : ' (target does not match)'}; nothing was sent`,
    };
  });
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sameId = (a: unknown, b: unknown) =>
  (typeof a === 'string' || typeof a === 'number') && String(a) === String(b);

/**
 * Reads, read-only, the Fortnox object that a record's source receipt only refers to and pins it as
 * evidence: the voucher of a booked payment, or the credit note of a credit. Nothing is sent to
 * Accounted. A later read that differs from the pinned copy is refused and the copy is kept.
 */
export async function captureCommand(host: PilotHost, id: string): Promise<CommandResult> {
  if (!ID.test(id)) return refuse('invalid record id');
  return locked(host, 'capture', async () => {
    const record = host.queue.get(id);
    if (!record) return refuse(`no record ${id}`);
    const source = record.sourceResult;
    let kind: SourceEvidenceKind;
    let key: string;
    let read: () => Promise<Record<string, unknown>>;
    let matches: (data: Record<string, unknown>) => boolean;
    let what: string;
    if (PAYMENT_OPERATIONS.has(record.operation)) {
      const ref = paymentVoucherRef(source);
      if (!ref)
        return refuse(
          `${id} has no booked voucher reference in its Fortnox receipt; capture after bookkeeping`,
        );
      const invoice = (source as Record<string, unknown>).InvoiceNumber;
      kind = 'payment-voucher';
      key = ref.key;
      what = 'payment';
      read = () => host.operations.getVoucher(ref.series, ref.number, Number(ref.year));
      matches = (data) =>
        sameId(data.Year, ref.year) &&
        data.VoucherSeries === ref.series &&
        sameId(data.VoucherNumber, ref.number) &&
        data.ReferenceType === 'INVOICEPAYMENT' &&
        sameId(data.ReferenceNumber, invoice);
    } else if (record.operation === 'creditInvoice') {
      const original = plainObject(source) ? source.DocumentNumber : undefined;
      const number = plainObject(source)
        ? creditNoteNumber(source.CreditInvoiceReference)
        : undefined;
      if (!number || typeof original !== 'string')
        return refuse(`${id} has no credit note number in its Fortnox receipt`);
      kind = 'credit-note';
      key = number;
      what = 'credit';
      read = () => host.operations.getInvoice(number);
      matches = (data) =>
        data.DocumentNumber === number &&
        data.Credit === 'true' &&
        data.InvoiceReference === original;
    } else return refuse(`operation ${record.operation} has no source evidence to capture`);
    const gate = await host.checkIntegrity();
    if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
    let data: Record<string, unknown>;
    try {
      data = await read();
    } catch (error) {
      return refuse(
        `${kind} ${key} could not be read from Fortnox; nothing was stored (${error instanceof Error ? error.name : 'Error'})`,
      );
    }
    if (!plainObject(data) || !matches(data))
      return refuse(
        `the ${kind} ${key} read from Fortnox does not match the ${what}; nothing was stored`,
      );
    try {
      host.beginMutation();
    } catch {
      return refuse('nothing was stored: backup marker could not be made durable');
    }
    let outcome: ReturnType<typeof host.queue.recordEvidence> | undefined;
    let failure: string | undefined;
    try {
      outcome = host.queue.recordEvidence(kind, key, data);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Error';
    } finally {
      const backup = await host.afterMutation();
      if (!backup.ok) failure = `${failure ? `${failure}; ` : ''}backup failed: ${backup.reason}`;
    }
    if (!outcome?.ok) return refuse(outcome ? outcome.reason : `nothing was stored: ${failure}`);
    const message = `${id}: ${outcome.created ? 'captured' : 'already captured'} ${kind} ${key} (sha256 ${outcome.sha256}); no Accounted request was made`;
    return failure
      ? { ok: false, message: `${message}; but ${failure}; further writes stay gated` }
      : { ok: true, message };
  });
}

export async function backupCommand(host: PilotHost): Promise<CommandResult> {
  const result = await host.backup();
  return result.ok
    ? { ok: true, message: `backup written to ${result.directory}` }
    : { ok: false, message: `Refused: ${result.reason}` };
}

/**
 * Closes the OLDEST unresolved record when the adapter still refuses to map it (e.g. a Fortnox write
 * whose arguments the mapping rejects). It becomes `blocked` with an `OPERATOR_REFUSED:` reason, a
 * `refused` journal entry is appended, and a backup is taken. No Fortnox or Accounted request is made.
 */
export async function refuseCommand(
  host: PilotHost,
  id: string,
  reason: string,
): Promise<CommandResult> {
  if (!ID.test(id)) return refuse('invalid record id');
  if (
    typeof reason !== 'string' ||
    reason.trim() !== reason ||
    reason.length === 0 ||
    reason.length > 300 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(reason)
  )
    return refuse('reason must be 1-300 characters on one line without surrounding whitespace');
  return locked(host, 'refuse', async () => {
    const record = host.queue.get(id);
    if (!record) return refuse('unknown record id');
    if (PAYMENT_OPERATIONS.has(record.operation)) return refusePaymentLocked(host, id, reason);
    const adapter = host.adapterFor(record.operation);
    if (!adapter) return refuse(`operation ${record.operation} has no adapter`);
    const gate = await host.checkGate(id, ['pending']);
    if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
    try {
      host.beginMutation();
    } catch {
      return refuse('nothing was done: backup marker could not be made durable');
    }
    const warnings: string[] = [];
    let outcome: ReturnType<typeof host.queue.refuseUnmappable> | undefined;
    try {
      outcome = host.queue.refuseUnmappable(id, reason, adapter);
      if (outcome.ok) {
        try {
          host.journalRefused(id);
        } catch {
          warnings.push(
            'the refusal could not be journaled; the record stays blocked and the gate keeps refusing',
          );
        }
      }
    } finally {
      const backup = await host.afterMutation();
      if (!backup.ok) warnings.push(`backup failed: ${backup.reason}`);
    }
    if (!outcome.ok)
      return refuse(
        `nothing was changed: ${outcome.reason}${warnings.map((w) => `; ${w}`).join('')}`,
      );
    return {
      ok: warnings.length === 0,
      state: 'blocked',
      message: [
        `${id}: blocked - refused by the operator (mapping: ${outcome.mappingReason}); no Fortnox or Accounted request was made`,
        ...warnings.map((w) => `warning: ${w}`),
      ].join('\n'),
      warnings,
    };
  });
}

/** `refuse` for the payment chain at the head of the queue: every member, journaled one by one. */
async function refusePaymentLocked(
  host: PilotHost,
  id: string,
  reason: string,
): Promise<CommandResult> {
  const gate = await host.checkGate();
  if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
  try {
    host.beginMutation();
  } catch {
    return refuse('nothing was done: backup marker could not be made durable');
  }
  const warnings: string[] = [];
  let outcome: ReturnType<typeof host.queue.refusePaymentChain> | undefined;
  try {
    outcome = host.queue.refusePaymentChain(id, reason, host.paymentAdapter);
    if (outcome.ok)
      for (const member of outcome.ids) {
        try {
          host.journalRefused(member);
        } catch {
          warnings.push(
            `the refusal of ${member} could not be journaled; it stays blocked and the gate keeps refusing`,
          );
        }
      }
  } finally {
    const backup = await host.afterMutation();
    if (!backup.ok) warnings.push(`backup failed: ${backup.reason}`);
  }
  if (!outcome.ok)
    return refuse(
      `nothing was changed: ${outcome.reason}${warnings.map((w) => `; ${w}`).join('')}`,
    );
  return {
    ok: warnings.length === 0,
    state: 'blocked',
    message: [
      `${outcome.ids.join(', ')}: blocked - refused by the operator (mapping: ${outcome.mappingReason}); no Fortnox or Accounted request was made`,
      ...warnings.map((w) => `warning: ${w}`),
    ].join('\n'),
    warnings,
  };
}

/** Read-only reconciliation of a whole `target_unknown` payment group via its verifier. */
async function reconcilePaymentLocked(
  host: PilotHost,
  record: ShadowRecord,
): Promise<CommandResult> {
  if (!host.paymentAdapter.verify) return refuse('the payment adapter has no read-only verifier');
  const members = host.queue
    .snapshot()
    .map((entry) => entry.record)
    .filter((other) => other.paymentGroup?.id === record.paymentGroup!.id)
    .map((other) => other.id);
  const gate = await host.checkGate(members, ['target_unknown']);
  if (!gate.ok) return refuse(`write gate: ${gate.reason}`);
  try {
    host.beginMutation();
  } catch {
    return refuse('backup marker could not be made durable');
  }
  let matched = false;
  let failure: string | undefined;
  try {
    matched = await host.queue.reconcilePaymentGroup(record.id, host.paymentAdapter);
  } catch (error) {
    failure = error instanceof Error ? error.name : 'Error';
  } finally {
    const backup = await host.afterMutation();
    if (!backup.ok) failure = `${failure ? `${failure}; ` : ''}backup failed: ${backup.reason}`;
  }
  const state = host.queue.get(record.id)!.state;
  const ids = members.join(', ');
  if (matched && state === 'applied' && !failure)
    return { ok: true, state, message: `${ids}: applied (payment read back and matched)` };
  return {
    ok: false,
    state,
    message: `${ids}: ${state}${failure ? ` (${failure})` : matched ? '' : ' (target does not match)'}; nothing was sent`,
  };
}
