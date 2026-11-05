import { createHash } from 'node:crypto';
import { canonicalEncode, decode } from './codec.js';
import { OPERATION_CATALOGUE } from './operations.js';
import type { ShadowBinding, ShadowRecord, ShadowSnapshotEntry, ShadowState } from './types.js';

export type InvoicePaymentLifecycleState =
  'missing' | 'waiting-for-bookkeeping' | 'booked' | 'deleted' | 'unresolved' | 'conflict';

export interface InvoicePaymentLifecycleChainEntry {
  intentId: string;
  sequence: number;
  operation: string;
  requestHash: string;
}

export interface InvoicePaymentLifecycleProjection {
  state: InvoicePaymentLifecycleState;
  reason: string;
  sourcePaymentId: string;
  sourceInvoiceId?: string;
  snapshotHash: string;
  chain: InvoicePaymentLifecycleChainEntry[];
  sourceResult?: unknown;
}

const VALID_STATES = new Set<ShadowState>([
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
]);
const COMPLETED_SOURCE_STATES = new Set<ShadowState>([
  'pending',
  'retry_wait',
  'target_in_flight',
  'target_unknown',
  'blocked',
  'applied',
  'deferred',
  'source_cancelled',
]);
const CREATE = 'createInvoicePayment';
const UPDATE = 'updateInvoicePayment';
const BOOKKEEP = 'bookkeepInvoicePayment';
const DELETE = 'deleteInvoicePayment';
const PAYMENT_OPERATIONS = new Set([CREATE, UPDATE, BOOKKEEP, DELETE]);
const HASH = /^[0-9a-f]{64}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f]/.test(value)
  );
}

/** Normalize numeric document identifiers without accepting ambiguous spellings. */
function documentId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function requestHash(record: ShadowRecord, binding: ShadowBinding): string {
  return createHash('sha256')
    .update(
      canonicalEncode({
        version: 1,
        ...binding,
        operation: record.operation,
        args: record.args,
      }),
    )
    .digest('hex');
}

function chainEntry(entry: ShadowSnapshotEntry): InvoicePaymentLifecycleChainEntry {
  return {
    intentId: entry.record.id,
    sequence: entry.sequence,
    operation: entry.record.operation,
    requestHash: entry.record.requestHash,
  };
}

function completed(entry: ShadowSnapshotEntry): boolean {
  return COMPLETED_SOURCE_STATES.has(entry.record.state);
}

function invalidReason(
  detail: string,
  sourcePaymentId: string,
  snapshotHash: string,
): InvoicePaymentLifecycleProjection {
  return {
    state: 'unresolved',
    reason: detail,
    sourcePaymentId,
    snapshotHash,
    chain: [],
  };
}

function result(
  state: InvoicePaymentLifecycleState,
  reason: string,
  sourcePaymentId: string,
  snapshotHash: string,
  chain: ShadowSnapshotEntry[],
  sourceInvoiceId?: string,
  sourceResult?: unknown,
): InvoicePaymentLifecycleProjection {
  return {
    state,
    reason,
    sourcePaymentId,
    ...(sourceInvoiceId !== undefined ? { sourceInvoiceId } : {}),
    snapshotHash,
    chain: chain.map(chainEntry),
    ...(sourceResult !== undefined ? { sourceResult } : {}),
  };
}

/**
 * Derive a read-only source-payment lifecycle projection from a verified queue snapshot.
 * This function never dispatches a target operation and never changes queue state.
 */
export function projectInvoicePaymentLifecycle(
  entries: readonly ShadowSnapshotEntry[],
  binding: ShadowBinding,
  sourcePaymentId: string,
): InvoicePaymentLifecycleProjection {
  let snapshotText: string;
  let clonedInput: {
    entries: unknown;
    binding: unknown;
    sourcePaymentId: unknown;
  };
  try {
    snapshotText = canonicalEncode({ entries, binding, sourcePaymentId });
    clonedInput = decode(snapshotText) as typeof clonedInput;
  } catch (cause) {
    throw new Error('Could not clone invoice payment lifecycle snapshot.', { cause });
  }
  const snapshotHash = createHash('sha256').update(snapshotText).digest('hex');
  const invalid = (detail: string) => invalidReason(detail, sourcePaymentId, snapshotHash);

  const clonedBinding = clonedInput.binding;
  if (
    !plainObject(clonedBinding) ||
    !safeIdentity(clonedBinding.sourceCompany) ||
    !safeIdentity(clonedBinding.targetCompany)
  )
    return invalid('Snapshot binding is malformed.');
  if (
    !plainObject(binding) ||
    !safeIdentity(binding.sourceCompany) ||
    !safeIdentity(binding.targetCompany) ||
    clonedBinding.sourceCompany !== binding.sourceCompany ||
    clonedBinding.targetCompany !== binding.targetCompany
  )
    return invalid('Snapshot binding does not match the requested binding.');
  const selectedPaymentId = documentId(clonedInput.sourcePaymentId);
  if (selectedPaymentId === null) return invalid('Source payment identifier is invalid.');
  if (!Array.isArray(clonedInput.entries)) return invalid('Snapshot entries are not an array.');

  const ordered = [...clonedInput.entries] as unknown[];
  if (ordered.some((entry) => !plainObject(entry))) return invalid('Snapshot entry is malformed.');

  const entriesToProcess: ShadowSnapshotEntry[] = [];
  const ids = new Set<string>();
  let previousSequence = 0;
  for (const candidate of ordered) {
    if (!plainObject(candidate)) return invalid('Snapshot entry is malformed.');
    const sequence = candidate.sequence;
    const record = candidate.record;
    if (
      !Number.isSafeInteger(sequence) ||
      (sequence as number) <= 0 ||
      (sequence as number) <= previousSequence
    )
      return invalid('Snapshot sequence is not strictly increasing.');
    previousSequence = sequence as number;
    if (!plainObject(record)) return invalid('Snapshot record is malformed.');
    if (
      record.version !== 1 ||
      !safeIdentity(record.id) ||
      ids.has(record.id) ||
      !safeIdentity(record.operation) ||
      !Array.isArray(record.args) ||
      !VALID_STATES.has(record.state as ShadowState) ||
      record.sourceCompany !== clonedBinding.sourceCompany ||
      record.targetCompany !== clonedBinding.targetCompany
    )
      return invalid('Snapshot record identity, state, arguments, or binding is invalid.');
    ids.add(record.id);
    if (!Object.hasOwn(OPERATION_CATALOGUE, record.operation))
      return invalid(`Snapshot contains an unclassified operation: ${record.operation}.`);
    if (typeof record.requestHash !== 'string' || !HASH.test(record.requestHash))
      return invalid(`Snapshot request hash is invalid for ${record.id}.`);
    try {
      if (
        requestHash(
          record as unknown as ShadowRecord,
          clonedBinding as unknown as ShadowBinding,
        ) !== record.requestHash
      )
        return invalid(`Snapshot request hash does not match ${record.id}.`);
    } catch (cause) {
      throw new Error(`Could not verify the snapshot request hash for ${record.id}.`, { cause });
    }
    entriesToProcess.push(candidate as unknown as ShadowSnapshotEntry);
  }

  const creators: ShadowSnapshotEntry[] = [];
  for (const item of entriesToProcess) {
    if (item.record.operation !== CREATE) continue;
    if (!completed(item))
      return invalid(`Invoice payment creator ${item.record.id} has no confirmed source result.`);
    if (item.record.args.length !== 1 || !plainObject(item.record.args[0]))
      return invalid(`Invoice payment creator ${item.record.id} has malformed arguments.`);
    const source = item.record.sourceResult;
    if (!plainObject(source))
      return invalid(`Invoice payment creator ${item.record.id} has no result object.`);
    const number = documentId(source.Number);
    if (number === null)
      return invalid(`Invoice payment creator ${item.record.id} has no valid payment Number.`);
    if (number !== selectedPaymentId) continue;
    creators.push(item);
  }

  let sourceInvoiceId: string | undefined;
  let lifecycle: InvoicePaymentLifecycleState = 'missing';
  let sourceResult: unknown;
  const related: ShadowSnapshotEntry[] = [];

  const followups: ShadowSnapshotEntry[] = [];
  for (const item of entriesToProcess) {
    if (item.record.operation === CREATE || !PAYMENT_OPERATIONS.has(item.record.operation))
      continue;
    const args = item.record.args;
    // A contradictory receipt must not disappear merely because the request named another payment.
    const receiptPaymentId = plainObject(item.record.sourceResult)
      ? documentId(item.record.sourceResult.Number)
      : null;
    const relatesToSelected =
      documentId(args[0]) === selectedPaymentId || receiptPaymentId === selectedPaymentId;
    if (item.record.operation === UPDATE) {
      if (args.length !== 2 || !documentId(args[0]) || !plainObject(args[1]))
        return invalid(`Invoice payment update ${item.record.id} has malformed arguments.`);
      if (relatesToSelected) followups.push(item);
      continue;
    }
    if (args.length !== 1 || documentId(args[0]) === null)
      return invalid(
        `Invoice payment ${item.record.operation} ${item.record.id} has malformed arguments.`,
      );
    if (relatesToSelected) followups.push(item);
  }

  const candidateChain = [...creators, ...followups].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (creators.length > 1) {
    return result(
      'conflict',
      'Multiple source create intents claim the same payment Number.',
      selectedPaymentId,
      snapshotHash,
      candidateChain,
    );
  }

  if (creators.length === 1) {
    const creator = creators[0];
    const params = creator.record.args[0] as Record<string, unknown>;
    const requestInvoiceId = documentId(params.InvoiceNumber);
    const created = creator.record.sourceResult as Record<string, unknown>;
    const resultInvoiceId = documentId(created.InvoiceNumber);
    if (requestInvoiceId === null || resultInvoiceId === null)
      return invalid(`Invoice payment creator ${creator.record.id} has an invalid invoice Number.`);
    if (requestInvoiceId !== resultInvoiceId)
      return result(
        'conflict',
        'Created payment InvoiceNumber disagrees with the requested InvoiceNumber.',
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        requestInvoiceId,
      );
    if (typeof created.Booked !== 'boolean')
      return invalid(`Invoice payment creator ${creator.record.id} has no boolean Booked receipt.`);
    sourceInvoiceId = requestInvoiceId;
    lifecycle = created.Booked ? 'booked' : 'waiting-for-bookkeeping';
    sourceResult = created;
    related.push(creator);
  }

  if (creators.length === 1 && followups.some((item) => item.sequence < creators[0].sequence))
    return result(
      'conflict',
      'A payment lifecycle operation precedes its source create receipt.',
      selectedPaymentId,
      snapshotHash,
      candidateChain,
      sourceInvoiceId,
      sourceResult,
    );

  for (const item of followups) {
    if (documentId(item.record.args[0]) !== selectedPaymentId)
      return result(
        'conflict',
        'Payment receipt Number contradicts the requested payment identity.',
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        sourceInvoiceId,
      );
    if (creators.length === 0)
      return result(
        'unresolved',
        'A payment lifecycle operation exists without a verified creator receipt.',
        selectedPaymentId,
        snapshotHash,
        followups,
      );
    if (lifecycle === 'booked' || lifecycle === 'deleted')
      return result(
        'conflict',
        `A later ${item.record.operation} follows a ${lifecycle} payment.`,
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        sourceInvoiceId,
        sourceResult,
      );
    if (!completed(item))
      return result(
        'unresolved',
        `Related ${item.record.operation} ${item.record.id} has an unresolved source outcome.`,
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        sourceInvoiceId,
        sourceResult,
      );

    if (item.record.operation === DELETE) {
      if (!Object.hasOwn(item.record, 'sourceResult') || item.record.sourceResult !== undefined)
        return invalid(
          `Related invoice payment delete ${item.record.id} lacks its void source receipt.`,
        );
      related.push(item);
      lifecycle = 'deleted';
      sourceResult = undefined;
      continue;
    }

    const receipt = item.record.sourceResult;
    if (!plainObject(receipt))
      return invalid(`Related ${item.record.operation} ${item.record.id} has no result object.`);
    const resultPaymentId = documentId(receipt.Number);
    const resultInvoiceId = documentId(receipt.InvoiceNumber);
    if (resultPaymentId === null || resultInvoiceId === null || typeof receipt.Booked !== 'boolean')
      return invalid(
        `Related ${item.record.operation} ${item.record.id} has an incomplete receipt.`,
      );
    if (resultPaymentId !== selectedPaymentId || resultInvoiceId !== sourceInvoiceId)
      return result(
        'conflict',
        `Related ${item.record.operation} ${item.record.id} contradicts the payment identity.`,
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        sourceInvoiceId,
        receipt,
      );
    if (item.record.operation === UPDATE) {
      const params = item.record.args[1] as Record<string, unknown>;
      if (Object.hasOwn(params, 'InvoiceNumber')) {
        const requestedInvoiceId = documentId(params.InvoiceNumber);
        if (requestedInvoiceId === null || requestedInvoiceId !== sourceInvoiceId)
          return result(
            'conflict',
            `Related invoice payment update ${item.record.id} changes InvoiceNumber.`,
            selectedPaymentId,
            snapshotHash,
            candidateChain,
            sourceInvoiceId,
            receipt,
          );
      }
    }
    if (item.record.operation === BOOKKEEP && !receipt.Booked)
      return result(
        'unresolved',
        'Bookkeep operation completed without a positive Booked receipt.',
        selectedPaymentId,
        snapshotHash,
        candidateChain,
        sourceInvoiceId,
        receipt,
      );
    related.push(item);
    sourceResult = receipt;
    if (receipt.Booked) lifecycle = 'booked';
  }

  if (creators.length === 0 && followups.length === 0)
    return result(
      'missing',
      'No source payment lifecycle record was found.',
      selectedPaymentId,
      snapshotHash,
      [],
    );
  return result(
    lifecycle,
    lifecycle === 'booked'
      ? 'Source receipt confirms the invoice payment is booked.'
      : lifecycle === 'deleted'
        ? 'Source receipt confirms the invoice payment was deleted before booking.'
        : 'Source payment exists but is not confirmed as booked.',
    selectedPaymentId,
    snapshotHash,
    related,
    sourceInvoiceId,
    sourceResult,
  );
}
