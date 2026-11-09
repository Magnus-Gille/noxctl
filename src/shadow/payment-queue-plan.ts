import { createHash } from 'node:crypto';
import { canonicalEncode, decode } from './codec.js';
import { projectInvoicePaymentLifecycle } from './payment-source-lifecycle.js';
import type {
  PaymentGroupDescriptor,
  PaymentManaged,
  ShadowBinding,
  ShadowPaymentGroup,
  ShadowRecord,
  ShadowSnapshotEntry,
} from './types.js';

export const PAYMENT_OPERATIONS = new Set([
  'createInvoicePayment',
  'updateInvoicePayment',
  'bookkeepInvoicePayment',
  'deleteInvoicePayment',
]);
export function copy<T>(value: T): T {
  return decode(canonicalEncode(value)) as T;
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalEncode(value)).digest('hex');
}
function numberId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function sourceId(record: ShadowRecord): string | undefined {
  return record.operation === 'createInvoicePayment'
    ? object(record.sourceResult)
      ? numberId(record.sourceResult.Number)
      : undefined
    : numberId(record.args?.[0]);
}
function sourceEvidence(entry: ShadowSnapshotEntry) {
  const { record, sequence } = entry;
  return {
    sequence,
    id: record.id,
    version: record.version,
    sourceCompany: record.sourceCompany,
    targetCompany: record.targetCompany,
    operation: record.operation,
    args: record.args,
    requestHash: record.requestHash,
    sourceResult: record.sourceResult,
  };
}
export function managed(
  entry: ShadowSnapshotEntry,
  paymentId: string,
  invoiceId: string,
): PaymentManaged {
  return {
    version: 1,
    sourcePaymentId: paymentId,
    sourceInvoiceId: invoiceId,
    sourceHash: digest(sourceEvidence(entry)),
  };
}
function hasManaged(entry: ShadowSnapshotEntry, paymentId: string, invoiceId: string): boolean {
  return (
    canonicalEncode(entry.record.paymentManaged) ===
    canonicalEncode(managed(entry, paymentId, invoiceId))
  );
}
function undispatched(record: ShadowRecord): boolean {
  return (
    (record.targetAttempts ?? 0) === 0 &&
    record.targetId === undefined &&
    record.targetReceipt === undefined &&
    record.paymentGroup === undefined
  );
}
export function groupOf(
  members: ShadowSnapshotEntry[],
  binding: ShadowBinding,
  paymentId: string,
  invoiceId: string,
): ShadowPaymentGroup {
  return {
    id:
      'payment-' +
      digest({
        version: 1,
        binding,
        sourcePaymentId: paymentId,
        sourceInvoiceId: invoiceId,
        members: members.map(sourceEvidence),
      }),
    sourcePaymentId: paymentId,
    sourceInvoiceId: invoiceId,
    members: copy(members),
    sourceResult: copy(members[members.length - 1].record.sourceResult),
  };
}
export function describeGroup(group: ShadowPaymentGroup, request: unknown): PaymentGroupDescriptor {
  return {
    version: 1,
    id: group.id,
    sourcePaymentId: group.sourcePaymentId,
    sourceInvoiceId: group.sourceInvoiceId,
    memberIds: group.members.map(({ record }) => record.id),
    memberSequences: group.members.map(({ sequence }) => sequence),
    requestHash: digest(request),
  };
}
/** Reconstruct ONLY a previously claimed group. Later source intents remain separate. */
export function restoreGroup(
  snapshot: ShadowSnapshotEntry[],
  binding: ShadowBinding,
  memberId: string,
): ShadowPaymentGroup {
  const member = snapshot.find(({ record }) => record.id === memberId);
  const descriptor = member?.record.paymentGroup;
  if (
    !descriptor ||
    descriptor.version !== 1 ||
    !Array.isArray(descriptor.memberIds) ||
    descriptor.memberIds.length === 0 ||
    new Set(descriptor.memberIds).size !== descriptor.memberIds.length ||
    !Array.isArray(descriptor.memberSequences) ||
    descriptor.memberSequences.length !== descriptor.memberIds.length ||
    !/^[a-f0-9]{64}$/.test(descriptor.requestHash)
  )
    throw new Error('Invalid durable payment group');
  const members = descriptor.memberIds.map((id, index) => {
    const row = snapshot.find(({ record }) => record.id === id);
    if (
      !row ||
      row.sequence !== descriptor.memberSequences[index] ||
      canonicalEncode(row.record.paymentGroup) !== canonicalEncode(descriptor)
    )
      throw new Error('Payment group membership changed');
    return row;
  });
  if (!descriptor.memberIds.includes(memberId))
    throw new Error('Payment group excludes selected member');
  const projection = projectInvoicePaymentLifecycle(members, binding, descriptor.sourcePaymentId);
  if (
    projection.state !== 'booked' ||
    projection.sourceInvoiceId !== descriptor.sourceInvoiceId ||
    projection.chain.length !== members.length
  )
    throw new Error('Payment group source evidence changed');
  const group = groupOf(members, binding, descriptor.sourcePaymentId, descriptor.sourceInvoiceId);
  if (
    group.id !== descriptor.id ||
    canonicalEncode({ ...describeGroup(group, undefined), requestHash: descriptor.requestHash }) !==
      canonicalEncode(descriptor)
  )
    throw new Error('Payment group descriptor changed');
  const first = members[0].record;
  for (const row of members) {
    const record = row.record;
    if (
      !hasManaged(row, group.sourcePaymentId, group.sourceInvoiceId) ||
      canonicalEncode({
        state: record.state,
        targetId: record.targetId,
        targetReceipt: record.targetReceipt,
        targetAttempts: record.targetAttempts,
        nextAttemptAt: record.nextAttemptAt,
      }) !==
        canonicalEncode({
          state: first.state,
          targetId: first.targetId,
          targetReceipt: first.targetReceipt,
          targetAttempts: first.targetAttempts,
          nextAttemptAt: first.nextAttemptAt,
        })
    )
      throw new Error('Payment group is partially updated');
  }
  return group;
}

function validDeferred(
  row: ShadowSnapshotEntry,
  snapshot: ShadowSnapshotEntry[],
  binding: ShadowBinding,
): boolean {
  const record = row.record;
  const id = sourceId(record);
  if (!id) return false;
  const projection = projectInvoicePaymentLifecycle(snapshot, binding, id);
  return (
    ['waiting-for-bookkeeping', 'booked', 'deleted'].includes(projection.state) &&
    !!projection.sourceInvoiceId &&
    projection.chain.some((entry) => entry.intentId === record.id) &&
    hasManaged(row, id, projection.sourceInvoiceId) &&
    undispatched(record) &&
    ['createInvoicePayment', 'updateInvoicePayment'].includes(record.operation) &&
    object(record.sourceResult) &&
    record.sourceResult.Booked === false
  );
}

export type PaymentQueuePlan =
  | { kind: 'idle' }
  | { kind: 'ordinary'; id: string }
  | { kind: 'blocked'; id: string; reason: string }
  | { kind: 'defer'; member: ShadowSnapshotEntry; paymentId: string; invoiceId: string }
  | { kind: 'cancel'; members: ShadowSnapshotEntry[]; paymentId: string; invoiceId: string }
  | { kind: 'payment'; group: ShadowPaymentGroup; resumed: boolean };

/** Pure ordering decision. Deferral is never permission to skip another financial effect. */
export function planPaymentQueue(
  raw: ShadowSnapshotEntry[],
  binding: ShadowBinding,
): PaymentQueuePlan {
  const snapshot = copy(raw);
  for (const row of snapshot) {
    const record = row.record;
    if (record.state === 'applied' || record.state === 'source_cancelled') continue;
    if (record.state === 'deferred') {
      if (!validDeferred(row, snapshot, binding))
        return {
          kind: 'blocked',
          id: record.id,
          reason: 'Deferred source payment requires reconciliation',
        };
      continue;
    }
    if (record.paymentGroup !== undefined) {
      const group = restoreGroup(snapshot, binding, record.id);
      if (record.state !== 'retry_wait') return { kind: 'idle' };
      const terminalSequence = group.members[group.members.length - 1].sequence;
      const memberIds = new Set(group.members.map((member) => member.record.id));
      // An earlier target can drift after our first safe-before-dispatch failure.
      // Recheck the whole original prefix, not only the earliest group member.
      for (const prerequisite of snapshot) {
        if (prerequisite.sequence >= terminalSequence) break;
        const item = prerequisite.record;
        if (memberIds.has(item.id) || item.state === 'applied' || item.state === 'source_cancelled')
          continue;
        if (item.state === 'deferred' && validDeferred(prerequisite, snapshot, binding)) continue;
        return { kind: 'idle' };
      }
      return { kind: 'payment', group, resumed: true };
    }
    if (!PAYMENT_OPERATIONS.has(record.operation)) {
      if (record.paymentQueueOwned !== undefined || record.paymentManaged !== undefined)
        return {
          kind: 'blocked',
          id: record.id,
          reason: 'Payment metadata on unrelated operation',
        };
      return { kind: 'ordinary', id: record.id };
    }
    if (!['pending', 'blocked'].includes(record.state) || !undispatched(record))
      return { kind: 'idle' };
    const id = sourceId(record);
    if (!id)
      return { kind: 'blocked', id: record.id, reason: 'Payment source identity is unresolved' };
    const projection = projectInvoicePaymentLifecycle(snapshot, binding, id);
    if (
      !['waiting-for-bookkeeping', 'booked', 'deleted'].includes(projection.state) ||
      !projection.sourceInvoiceId
    )
      return {
        kind: 'blocked',
        id: record.id,
        reason: 'Payment source chain is not ready: ' + projection.reason,
      };
    if (record.paymentManaged !== undefined && !hasManaged(row, id, projection.sourceInvoiceId))
      return { kind: 'blocked', id: record.id, reason: 'Managed payment source evidence changed' };
    const members = projection.chain.map((entry) =>
      snapshot.find(({ record: r }) => r.id === entry.intentId)!,
    );
    const index = members.findIndex(({ record: r }) => r.id === record.id);
    if (
      index < 0 ||
      members.some((entry) => !undispatched(entry.record)) ||
      members
        .slice(0, index)
        .some(
          (entry) =>
            entry.record.state !== 'deferred' ||
            !hasManaged(entry, id, projection.sourceInvoiceId!),
        )
    )
      return {
        kind: 'blocked',
        id: record.id,
        reason: 'Payment chain has unprocessed or dispatched prerequisites',
      };
    if (projection.state === 'waiting-for-bookkeeping' || index < members.length - 1) {
      if (
        !['createInvoicePayment', 'updateInvoicePayment'].includes(record.operation) ||
        !object(record.sourceResult) ||
        record.sourceResult.Booked !== false
      )
        return {
          kind: 'blocked',
          id: record.id,
          reason: 'Only unbooked source preparation can defer',
        };
      return { kind: 'defer', member: row, paymentId: id, invoiceId: projection.sourceInvoiceId };
    }
    if (projection.state === 'deleted')
      return { kind: 'cancel', members, paymentId: id, invoiceId: projection.sourceInvoiceId };
    return {
      kind: 'payment',
      group: groupOf(members, binding, id, projection.sourceInvoiceId),
      resumed: false,
    };
  }
  return { kind: 'idle' };
}
