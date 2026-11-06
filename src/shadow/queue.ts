import { canonicalEncode, decode } from './codec.js';
import {
  copy,
  digest,
  managed,
  describeGroup,
  restoreGroup,
  planPaymentQueue,
  PAYMENT_OPERATIONS,
} from './payment-queue-plan.js';
import {
  READ_ONLY_TARGET_OPERATIONS,
  competingIdentitySources,
  resolveShadowIdentity,
} from './identity.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from './identity.js';
export { canonicalEncode } from './codec.js';
import {
  TargetBlockedError,
  TargetNotDispatchedError,
  TargetReceiptPendingError,
} from './types.js';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ShadowAdapter,
  ShadowBinding,
  ShadowIntent,
  ShadowRecord,
  ShadowSnapshotEntry,
  ShadowState,
  ShadowStatus,
  ShadowPaymentAdapter,
  ShadowPaymentGroup,
  PaymentDrainResult,
  ShadowTargetReceipt,
} from './types.js';

const states: ShadowState[] = [
  'prepared',
  'source_in_flight',
  'source_unknown',
  'pending',
  'retry_wait',
  'target_in_flight',
  'target_unknown',
  'blocked',
  'applied',
  'deferred',
  'source_cancelled',
];
function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name)
    ? error.name
    : 'UnknownError';
}

function identity(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value))
    throw new Error('Invalid shadow identity');
}

export class SourceReceiptPersistenceError extends Error {
  constructor(
    readonly sourceResult: unknown,
    options: ErrorOptions,
  ) {
    super(
      'Fortnox succeeded but its receipt could not be persisted. Do not repeat this intent; reconcile the source outcome.',
      options,
    );
    this.name = 'SourceReceiptPersistenceError';
  }
}

/** SQLite supplies crash-safe commits and cross-process claims, without stale lock reclamation. */
/** What an operator previewed: the single record and the digest of the exact request. */
export interface DrainExpectation {
  id: string;
  expectedDigest: string;
  /** Digest of the freshly prepared (canonical) request; computed inside the claim transaction. */
  digestOf: (record: ShadowRecord, request: unknown) => string;
  /** Runs after the claim, before any target request. Throw TargetNotDispatchedError to abort safely. */
  beforeApply?: (record: ShadowRecord, request: unknown) => void | Promise<void>;
}
export type DrainExpectedResult =
  { claimed: true; applied: boolean } | { claimed: false; reason: string };

export class ShadowQueue {
  constructor(
    private readonly db: DatabaseSync,
    readonly binding: Readonly<ShadowBinding>,
    private readonly now: () => number,
  ) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private save(record: ShadowRecord): void {
    record.updatedAt = this.now();
    this.db
      .prepare('UPDATE intents SET state=?, record=? WHERE id=?')
      .run(record.state, canonicalEncode(record), record.id);
  }
  get(id: string): ShadowRecord | undefined {
    const row = this.db.prepare('SELECT record FROM intents WHERE id=?').get(id);
    return row ? (decode(row.record as string) as ShadowRecord) : undefined;
  }
  /** Read-only ordered evidence for host-owned projections. */
  snapshot(): ShadowSnapshotEntry[] {
    return this.db
      .prepare('SELECT seq, record FROM intents ORDER BY seq')
      .all()
      .map((row) => ({
        sequence: Number(row.seq),
        record: decode(row.record as string) as ShadowRecord,
      }));
  }
  /** Read-only projection of durable creator receipts; missing never authorizes a create. */
  resolveIdentity(resource: ShadowResourceKind, sourceId: string): ShadowIdentityResolution {
    const records = this.db
      .prepare('SELECT record FROM intents ORDER BY seq')
      .all()
      .map((row) => decode(row.record as string) as ShadowRecord);
    return resolveShadowIdentity(records, this.binding, resource, sourceId);
  }
  async execute<T>(intent: ShadowIntent, invoke: () => Promise<T>): Promise<T> {
    identity(intent.id);
    identity(intent.operation);
    const args = decode(canonicalEncode(intent.args)) as unknown[];
    const hash = createHash('sha256')
      .update(canonicalEncode({ version: 1, ...this.binding, operation: intent.operation, args }))
      .digest('hex');
    const claimed = this.transaction(() => {
      const existing = this.get(intent.id);
      if (existing) {
        if (existing.requestHash !== hash) throw new Error('Shadow intent identity conflict');
        if (
          [
            'pending',
            'retry_wait',
            'target_in_flight',
            'target_unknown',
            'blocked',
            'applied',
            'deferred',
            'source_cancelled',
          ].includes(existing.state)
        )
          return { replay: true, record: existing };
        if (existing.state !== 'prepared')
          throw new Error('Source outcome unknown or in flight; reconcile before retry');
      }
      const record: ShadowRecord = existing ?? {
        version: 1,
        ...this.binding,
        ...intent,
        args,
        requestHash: hash,
        state: 'prepared',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      if (!existing)
        this.db
          .prepare('INSERT INTO intents(id,state,record) VALUES(?,?,?)')
          .run(intent.id, record.state, canonicalEncode(record));
      record.state = 'source_in_flight';
      this.save(record);
      return { replay: false, record };
    });
    if (claimed.replay) return claimed.record.sourceResult as T;
    let result: T;
    try {
      result = await invoke();
    } catch (error) {
      // All thrown outcomes are conservative, including transport errors that might follow a committed write.
      try {
        claimed.record.state = 'source_unknown';
        claimed.record.reason = 'Source call failed; readback required';
        this.save(claimed.record);
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          'Source outcome unknown and failure receipt could not be persisted',
        );
      }
      throw error;
    }
    try {
      claimed.record.sourceResult = result;
      claimed.record.state = 'pending';
      claimed.record.reason = undefined;
      this.save(claimed.record);
    } catch (cause) {
      throw new SourceReceiptPersistenceError(result, { cause });
    }
    return result;
  }

  /** Strict queue order preserves prerequisites. A gap pauses target replay, never new source work. */
  async drainOne(adapter: ShadowAdapter): Promise<boolean> {
    return this.drainSingle(adapter);
  }

  /**
   * Drains exactly the record and request the operator previewed. Inside the claim transaction the
   * oldest unresolved non-payment record must be `id` (pending/retry_wait) and the digest of the
   * freshly prepared request must equal `expectedDigest`; otherwise nothing is claimed.
   * `beforeApply` runs after the claim and before any target request; if it throws a
   * TargetNotDispatchedError the record goes to retry_wait and nothing is sent.
   */
  async drainExpected(
    adapter: ShadowAdapter,
    expect: DrainExpectation,
  ): Promise<DrainExpectedResult> {
    const outcome: { reason?: string } = {};
    const applied = await this.drainSingle(adapter, false, undefined, expect, outcome);
    return outcome.reason === undefined
      ? { claimed: true, applied }
      : { claimed: false, reason: outcome.reason };
  }

  private async drainSingle(
    adapter: ShadowAdapter,
    paymentAware = false,
    expectedId?: string,
    expect?: DrainExpectation,
    outcome: { reason?: string } = {},
  ): Promise<boolean> {
    const refuse = (reason: string): undefined => {
      if (expect) outcome.reason = reason;
      return undefined;
    };
    const claimed = this.transaction(() => {
      let record: ShadowRecord | undefined;
      if (paymentAware) {
        const plan = planPaymentQueue(this.snapshot(), this.binding);
        if (plan.kind !== 'ordinary' || (expectedId !== undefined && plan.id !== expectedId))
          return undefined;
        record = this.get(plan.id);
      } else {
        const row = this.db
          .prepare(
            "SELECT record FROM intents WHERE state NOT IN ('applied', 'source_cancelled') ORDER BY seq LIMIT 1",
          )
          .get();
        record = row ? (decode(row.record as string) as ShadowRecord) : undefined;
      }
      if (
        !record ||
        record.paymentQueueOwned !== undefined ||
        record.paymentManaged !== undefined ||
        record.paymentGroup !== undefined
      )
        return refuse('the oldest unresolved record is not an ordinary drainable record');
      if (expect && record.id !== expect.id)
        return refuse(`the oldest unresolved record is ${record.id}, not ${expect.id}`);
      if (record.state !== 'pending' && record.state !== 'retry_wait')
        return refuse(`record is ${record.state}, not pending`);
      if (record.nextAttemptAt !== undefined && record.nextAttemptAt > this.now())
        return refuse('retry is not due yet');
      let prepared: ReturnType<ShadowAdapter['prepare']>;
      try {
        prepared = adapter.prepare(record);
      } catch (error) {
        prepared = { blocked: `Adapter validation failed (${safeErrorName(error)})` };
      }
      if ('blocked' in prepared) {
        record.state = 'blocked';
        record.reason = prepared.blocked.slice(0, 500);
        this.save(record);
        return refuse('mapping refuses this record');
      }
      if (expect) {
        const digest = expect.digestOf(record, decode(canonicalEncode(prepared.request)));
        if (digest !== expect.expectedDigest)
          return refuse('the prepared request differs from the previewed one');
      }
      // Never dispatch an identity source while another intent claims the same source object:
      // a second create or baseline could produce a duplicate target object (NOX-213).
      const allRecords = this.db
        .prepare('SELECT record FROM intents ORDER BY seq')
        .all()
        .map((row) => decode(row.record as string) as ShadowRecord);
      const competing = competingIdentitySources(allRecords, record);
      if (competing.length > 0) {
        record.state = 'blocked';
        record.reason = `IDENTITY_SOURCE_COMPETING: intents ${competing
          .map((other) => other.id)
          .join(', ')} claim the same source identity; nothing was dispatched.`.slice(0, 500);
        this.save(record);
        return undefined;
      }
      // Serialize before claiming so a nonserializable translation cannot reach the target.
      const request = decode(canonicalEncode(prepared.request));
      record.targetAttempts = (record.targetAttempts ?? 0) + 1;
      record.nextAttemptAt = undefined;
      record.state = 'target_in_flight';
      this.save(record);
      return { record, request };
    });
    if (!claimed) return false;
    try {
      await expect?.beforeApply?.(claimed.record, claimed.request);
      const result = await adapter.apply(claimed.record, claimed.request);
      identity(result.targetId);
      claimed.record.targetId = result.targetId;
      claimed.record.targetReceipt = result.receipt;
      claimed.record.state = 'applied';
      claimed.record.reason = undefined;
      this.save(claimed.record);
      return true;
    } catch (error) {
      if (error instanceof TargetNotDispatchedError) {
        claimed.record.state = 'retry_wait';
        claimed.record.reason = 'Target unavailable before dispatch; safe retry scheduled';
        claimed.record.nextAttemptAt =
          this.now() +
          Math.min(60_000, 1000 * 2 ** Math.min(6, (claimed.record.targetAttempts ?? 1) - 1));
        this.save(claimed.record);
        return false;
      }
      if (
        error instanceof TargetBlockedError &&
        READ_ONLY_TARGET_OPERATIONS.has(claimed.record.operation)
      ) {
        claimed.record.state = 'blocked';
        claimed.record.reason = error.message.slice(0, 500);
        this.save(claimed.record);
        return false;
      }
      if (error instanceof TargetReceiptPendingError) {
        identity(error.targetId);
        claimed.record.targetId = error.targetId;
        claimed.record.targetReceipt = error.receipt;
      }
      // A timeout, missing cache or 429 does not prove that no effect happened. Never retry automatically.
      claimed.record.state = 'target_unknown';
      claimed.record.reason = `Target outcome requires read-only reconciliation; automatic replay disabled (${safeErrorName(error)})`;
      this.save(claimed.record);
      return false;
    }
  }

  /** One explicit payment-aware step. No default scheduler or live adapter invokes this. */
  async drainPaymentAware(
    normal: ShadowAdapter,
    adapter: ShadowPaymentAdapter,
  ): Promise<PaymentDrainResult> {
    const preparedStep = this.transaction(() => {
      const plan = planPaymentQueue(this.snapshot(), this.binding);
      if (plan.kind === 'idle')
        return { result: { state: 'idle', intentIds: [] } as PaymentDrainResult };
      if (plan.kind === 'ordinary') return { ordinary: plan.id };
      if (plan.kind === 'blocked') {
        const record = this.get(plan.id)!;
        if (PAYMENT_OPERATIONS.has(record.operation)) record.paymentQueueOwned = true;
        record.state = 'blocked';
        record.reason = plan.reason.slice(0, 500);
        this.save(record);
        return { result: { state: 'blocked', intentIds: [record.id] } as PaymentDrainResult };
      }
      if (plan.kind === 'defer') {
        const record = plan.member.record;
        record.paymentManaged = managed(plan.member, plan.paymentId, plan.invoiceId);
        record.state = 'deferred';
        record.reason =
          'Source payment preparation awaits its terminal source step; target not applied';
        this.save(record);
        return { result: { state: 'deferred', intentIds: [record.id] } as PaymentDrainResult };
      }
      if (plan.kind === 'cancel') {
        for (const member of plan.members) {
          member.record.paymentManaged = managed(member, plan.paymentId, plan.invoiceId);
          member.record.state = 'source_cancelled';
          member.record.reason =
            'Unbooked source payment deleted before any target attempt; no target effect';
          this.save(member.record);
        }
        return {
          result: {
            state: 'cancelled',
            intentIds: plan.members.map(({ record }) => record.id),
          } as PaymentDrainResult,
        };
      }
      const group = plan.group;
      const ids = group.members.map(({ record }) => record.id);
      const first = group.members[0].record;
      if (first.nextAttemptAt !== undefined && first.nextAttemptAt > this.now())
        return { result: { state: 'idle', intentIds: ids } as PaymentDrainResult };
      let translated: ReturnType<ShadowPaymentAdapter['prepare']>;
      try {
        translated = adapter.prepare(copy(group));
      } catch (error) {
        translated = { blocked: `Payment mapping failed (${safeErrorName(error)})` };
      }
      let request: unknown;
      if (!('blocked' in translated)) {
        try {
          request = copy(translated.request);
        } catch (error) {
          translated = { blocked: `Payment request cannot be persisted (${safeErrorName(error)})` };
        }
      }
      if (
        !('blocked' in translated) &&
        plan.resumed &&
        digest(request) !== first.paymentGroup!.requestHash
      )
        translated = { blocked: 'Prepared payment request changed after durable group claim' };
      if ('blocked' in translated) {
        // Before the first dispatch only the terminal member blocks; its earlier preparations stay deferred.
        const blocked = plan.resumed ? group.members : [group.members[group.members.length - 1]];
        for (const member of blocked) {
          member.record.paymentManaged = managed(
            member,
            group.sourcePaymentId,
            group.sourceInvoiceId,
          );
          member.record.state = 'blocked';
          member.record.reason = translated.blocked.slice(0, 500);
          this.save(member.record);
        }
        return { result: { state: 'blocked', intentIds: ids } as PaymentDrainResult };
      }
      const descriptor = plan.resumed ? copy(first.paymentGroup!) : describeGroup(group, request);
      const attempts = (first.targetAttempts ?? 0) + 1;
      for (const member of group.members) {
        const record = member.record;
        record.paymentManaged = managed(member, group.sourcePaymentId, group.sourceInvoiceId);
        record.paymentGroup = copy(descriptor);
        record.targetAttempts = attempts;
        record.nextAttemptAt = undefined;
        record.state = 'target_in_flight';
        record.reason = undefined;
        this.save(record);
      }
      return { group, request };
    });
    if ('result' in preparedStep && preparedStep.result) return preparedStep.result;
    if ('ordinary' in preparedStep) {
      const applied = await this.drainSingle(normal, true, preparedStep.ordinary);
      return { state: applied ? 'applied' : 'idle', intentIds: [preparedStep.ordinary!] };
    }
    if (!('group' in preparedStep) || !preparedStep.group)
      throw new Error('Invalid payment queue claim');
    const { group, request } = preparedStep;
    const ids = group.members.map(({ record }) => record.id);
    let returned = false;
    let known: ShadowTargetReceipt | undefined;
    try {
      const result = await adapter.apply(copy(group), copy(request));
      returned = true;
      identity(result.targetId);
      known = copy(result);
      this.updatePaymentGroup(group, (record) => {
        record.targetId = known!.targetId;
        record.targetReceipt = copy(known!.receipt);
        record.state = 'applied';
        record.reason = undefined;
      });
      return { state: 'applied', intentIds: ids };
    } catch (error) {
      if (!returned && error instanceof TargetNotDispatchedError) {
        const retryAt =
          this.now() +
          Math.min(
            60_000,
            1000 * 2 ** Math.min(6, (group.members[0].record.targetAttempts ?? 1) - 1),
          );
        this.updatePaymentGroup(group, (record) => {
          record.state = 'retry_wait';
          record.reason =
            'Payment target unavailable before dispatch; safe grouped retry scheduled';
          record.nextAttemptAt = retryAt;
        });
        return { state: 'retry', intentIds: ids };
      }
      if (!returned && error instanceof TargetReceiptPendingError) {
        identity(error.targetId);
        known = copy({ targetId: error.targetId, receipt: error.receipt });
      }
      try {
        this.updatePaymentGroup(group, (record) => {
          if (known) {
            record.targetId = known.targetId;
            record.targetReceipt = copy(known.receipt);
          }
          record.state = 'target_unknown';
          record.reason = `Payment group needs read-only reconciliation; replay disabled (${safeErrorName(error)})`;
        });
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          'Payment group outcome could not be durably reconciled; do not retry',
        );
      }
      return { state: 'unknown', intentIds: ids };
    }
  }

  private updatePaymentGroup(
    group: ShadowPaymentGroup,
    change: (record: ShadowRecord) => void,
  ): void {
    this.transaction(() => {
      const current = restoreGroup(this.snapshot(), this.binding, group.members[0].record.id);
      if (canonicalEncode(current.members) !== canonicalEncode(group.members))
        throw new Error('Payment group changed during target operation');
      for (const member of current.members) {
        change(member.record);
        this.save(member.record);
      }
    });
  }

  /** Verify a whole durable receipt, never recover a receipt-less effect by repeating its mutation. */
  async reconcilePaymentGroup(memberId: string, adapter: ShadowPaymentAdapter): Promise<boolean> {
    const group = restoreGroup(this.snapshot(), this.binding, memberId);
    const first = group.members[0].record;
    if (
      first.state !== 'target_unknown' ||
      !first.targetId ||
      first.targetReceipt === undefined ||
      !adapter.verify
    )
      throw new Error('Payment group has no unknown durable receipt/verifier');
    if (
      (await adapter.verify(
        copy(group),
        copy({ targetId: first.targetId, receipt: first.targetReceipt }),
      )) !== true
    )
      return false;
    this.updatePaymentGroup(group, (record) => {
      record.state = 'applied';
      record.reason = undefined;
    });
    return true;
  }

  async verifyPaymentGroup(memberId: string, adapter: ShadowPaymentAdapter): Promise<boolean> {
    const group = restoreGroup(this.snapshot(), this.binding, memberId);
    const first = group.members[0].record;
    if (
      first.state !== 'applied' ||
      !first.targetId ||
      first.targetReceipt === undefined ||
      !adapter.verify
    )
      throw new Error('Payment group has no applied durable receipt/verifier');
    const matches =
      (await adapter.verify(
        copy(group),
        copy({ targetId: first.targetId, receipt: first.targetReceipt }),
      )) === true;
    this.updatePaymentGroup(group, (record) => {
      if (!matches) {
        record.state = 'blocked';
        record.reason = 'Grouped target readback mismatch; do not replay';
      }
    });
    return matches;
  }

  /** Recheck a pure mapping refusal only. Never resets a dispatched or drifted target. */
  revalidateBlocked(id: string, adapter: ShadowAdapter): boolean {
    return this.transaction(() => {
      const record = this.get(id);
      if (
        !record ||
        record.state !== 'blocked' ||
        record.paymentQueueOwned !== undefined ||
        record.paymentManaged !== undefined ||
        record.paymentGroup !== undefined ||
        (record.targetAttempts ?? 0) !== 0 ||
        record.targetId !== undefined ||
        record.targetReceipt !== undefined
      )
        return false;
      // Give validation an independent copy; it cannot rewrite the source evidence.
      const prepared = adapter.prepare(decode(canonicalEncode(record)) as ShadowRecord);
      if ('blocked' in prepared) return false;
      canonicalEncode(prepared.request);
      record.state = 'pending';
      record.reason = undefined;
      this.save(record);
      return true;
    });
  }

  async verifyApplied(id: string, adapter: ShadowAdapter): Promise<boolean> {
    const record = this.get(id);
    if (
      !record ||
      record.paymentQueueOwned !== undefined ||
      record.paymentManaged !== undefined ||
      record.paymentGroup !== undefined ||
      record.state !== 'applied' ||
      !record.targetId ||
      !adapter.verify
    )
      throw new Error('No confirmed target identity/verifier');
    // Persist a result only if the record is still the applied state that was verified, so a
    // concurrent verification can never overwrite a newer transition (e.g. a confirmed mismatch).
    const persist = (state: 'blocked' | 'target_unknown', reason: string): void =>
      this.transaction(() => {
        const current = this.get(id);
        if (
          !current ||
          current.state !== 'applied' ||
          current.targetId !== record.targetId ||
          current.requestHash !== record.requestHash
        )
          return;
        current.state = state;
        current.reason = reason;
        this.save(current);
      });
    let matches: boolean;
    try {
      matches = await adapter.verify(record);
    } catch (error) {
      // The check could not establish that the target still matches. Withhold the identity
      // (target_unknown keeps targetId and receipt) until reconcileTarget confirms it by reading.
      persist(
        'target_unknown',
        `Drift verification could not complete; identity withheld until read-only reconciliation (${safeErrorName(error)})`,
      );
      throw error;
    }
    if (!matches) persist('blocked', 'Target readback mismatch; do not replay');
    return matches;
  }
  /** Resolve only an already persisted target identity using the operation-specific read verifier. */
  async reconcileTarget(id: string, adapter: ShadowAdapter): Promise<boolean> {
    const record = this.get(id);
    if (
      !record ||
      record.state !== 'target_unknown' ||
      record.paymentQueueOwned !== undefined ||
      record.paymentManaged !== undefined ||
      record.paymentGroup !== undefined ||
      !record.targetId ||
      !record.targetReceipt ||
      !adapter.verify
    )
      throw new Error('Unknown target has no durable identity/receipt for automatic readback');
    if (!(await adapter.verify(record))) return false;
    return this.transaction(() => {
      const current = this.get(id);
      if (
        !current ||
        current.state !== 'target_unknown' ||
        current.targetId !== record.targetId ||
        current.requestHash !== record.requestHash
      )
        throw new Error('Target reconciliation state changed');
      current.state = 'applied';
      current.reason = undefined;
      this.save(current);
      return true;
    });
  }
  /** Aggregate status without materializing historical payloads; one statement, one snapshot. */
  summary(): Omit<ShadowStatus, 'items'> {
    const row = this.db
      .prepare(
        `WITH totals AS (SELECT state, COUNT(*) AS total FROM intents GROUP BY state)
         SELECT
           (SELECT json_group_object(state, total) FROM totals) AS counts,
           (SELECT record FROM intents WHERE state NOT IN ('applied', 'source_cancelled') ORDER BY seq LIMIT 1) AS oldest`,
      )
      .get()!;
    const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<
      ShadowState,
      number
    >;
    for (const [state, count] of Object.entries(JSON.parse(row.counts as string))) {
      if (
        !states.includes(state as ShadowState) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 0
      )
        throw new Error('Invalid shadow queue state count');
      counts[state as ShadowState] = count as number;
    }
    const oldest = row.oldest ? (decode(row.oldest as string) as ShadowRecord) : undefined;
    return {
      enabled: true,
      binding: { ...this.binding },
      counts,
      oldestUnappliedAgeMs: oldest ? Math.max(0, this.now() - oldest.createdAt) : null,
    };
  }
  status(): ShadowStatus {
    const records = this.db
      .prepare('SELECT record FROM intents ORDER BY seq')
      .all()
      .map((row) => decode(row.record as string) as ShadowRecord);
    const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<
      ShadowState,
      number
    >;
    for (const record of records) counts[record.state]++;
    const oldest = records.find(
      (record) => record.state !== 'applied' && record.state !== 'source_cancelled',
    );
    return {
      enabled: true,
      binding: { ...this.binding },
      counts,
      oldestUnappliedAgeMs: oldest ? Math.max(0, this.now() - oldest.createdAt) : null,
      items: records.map(
        ({ id, operation, state, createdAt, targetId, reason, nextAttemptAt }) => ({
          id,
          operation,
          state,
          createdAt,
          targetId,
          reason,
          nextAttemptAt,
        }),
      ),
    };
  }
  close(): void {
    this.db.close();
  }
}

/** Lazy load keeps default noxctl working on runtimes without built-in SQLite. */
export async function openShadowQueue(
  directory: string,
  binding: ShadowBinding,
  now: () => number = Date.now,
): Promise<ShadowQueue> {
  identity(binding.sourceCompany);
  identity(binding.targetCompany);
  if (process.platform === 'win32')
    throw new Error(
      'Shadow queue is supported on macOS and Linux only (needs POSIX private directories)',
    );
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Shadow queue requires a private owned directory (0700)');
  const path = join(root, 'shadow.sqlite');
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
      throw new Error('Shadow database must be a private regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { DatabaseSync: SqliteDatabase } = await import('node:sqlite');
  // umask is process-global: use SQLite's creation mode then restrict before writing any business payload.
  const db = new SqliteDatabase(path);
  chmodSync(path, 0o600);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS intents (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, record TEXT NOT NULL);',
    );
    const expected = canonicalEncode({ version: 1, ...binding });
    db.prepare('INSERT OR IGNORE INTO binding(singleton,value) VALUES(1,?)').run(expected);
    const row = db.prepare('SELECT value FROM binding WHERE singleton=1').get();
    if (row?.value !== expected) throw new Error('Shadow queue binding mismatch');
    return new ShadowQueue(db, Object.freeze({ ...binding }), now);
  } catch (error) {
    db.close();
    throw error;
  }
}
