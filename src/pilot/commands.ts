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
import type { ShadowRecord, ShadowState } from '../shadow/types.js';
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
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,199}$/;

function oldestUnresolved(host: PilotHost): ShadowRecord | undefined {
  return host.queue
    .snapshot()
    .map((entry) => entry.record)
    .find((record) => record.state !== 'applied' && record.state !== 'source_cancelled');
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

export async function previewCommand(host: PilotHost, id: string): Promise<CommandResult> {
  const prepared = prepareOldest(host, id);
  if ('error' in prepared) return refuse(prepared.error);
  const hash = previewHash(host, prepared.record, prepared.request);
  const dir = join(host.directory, 'previews');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ hash, createdAt: host.now(), osUser: host.osUser() }), {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
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
  const first = prepareOldest(host, id);
  if ('error' in first) return refuse(first.error);
  const gate = await host.checkGate(id);
  if (!gate.ok) return refuse(`write gate: ${gate.reason}`);

  let file: { hash?: unknown; createdAt?: unknown; osUser?: unknown };
  try {
    file = JSON.parse(readFileSync(join(host.directory, 'previews', `${id}.json`), 'utf8'));
  } catch {
    return refuse('no preview for this record; run preview first');
  }
  const age = host.now() - Number(file.createdAt);
  if (file.hash !== hash) return refuse('hash does not match the stored preview');
  if (!Number.isFinite(age) || age < 0 || age >= PREVIEW_MAX_AGE_MS)
    return refuse('preview is stale; run preview again');
  if (file.osUser !== host.osUser()) return refuse('preview was made by another OS user');
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
    const adapter = host.adapterFor(record.operation);
    if (!adapter?.verify) return refuse(`no read-only verifier for ${record.operation}`);
    try {
      host.beginMutation();
    } catch {
      return refuse('backup marker could not be made durable');
    }
    let matched = false;
    let failure: string | undefined;
    try {
      matched = await host.queue.reconcileTarget(id, adapter);
    } catch (error) {
      failure = error instanceof Error ? error.name : 'Error';
    } finally {
      const backup = await host.afterMutation();
      if (!backup.ok) failure = `${failure ? `${failure}; ` : ''}backup failed: ${backup.reason}`;
    }
    const state = host.queue.get(id)!.state;
    if (matched && state === 'applied')
      return { ok: true, state, message: `${id}: applied (target read back and matched)` };
    return {
      ok: false,
      state,
      message: `${id}: still ${state}${failure ? ` (${failure})` : ' (target does not match)'}; nothing was sent`,
    };
  });
}

export async function backupCommand(host: PilotHost): Promise<CommandResult> {
  const result = await host.backup();
  return result.ok
    ? { ok: true, message: `backup written to ${result.directory}` }
    : { ok: false, message: `Refused: ${result.reason}` };
}
