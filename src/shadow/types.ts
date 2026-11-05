/** Host-bound identities. Never accepted as MCP business-tool arguments. */
export interface ShadowBinding {
  sourceCompany: string;
  targetCompany: string;
}
export type ShadowState =
  | 'prepared'
  | 'source_in_flight'
  | 'source_unknown'
  | 'pending'
  | 'retry_wait'
  | 'target_in_flight'
  | 'target_unknown'
  | 'blocked'
  | 'applied'
  | 'deferred'
  | 'source_cancelled';
export interface ShadowIntent {
  id: string;
  operation: string;
  args: unknown[];
}
export interface ShadowRecord extends ShadowIntent, ShadowBinding {
  version: 1;
  requestHash: string;
  state: ShadowState;
  createdAt: number;
  updatedAt: number;
  sourceResult?: unknown;
  targetId?: string;
  targetReceipt?: unknown;
  reason?: string;
  targetAttempts?: number;
  nextAttemptAt?: number;
  paymentManaged?: PaymentManaged;
  paymentGroup?: PaymentGroupDescriptor;
  /** Payment-aware refusal owns this record even before source identities are usable. */
  paymentQueueOwned?: true;
}
export interface PaymentManaged {
  version: 1;
  sourcePaymentId: string;
  sourceInvoiceId: string;
  sourceHash: string;
}
export interface PaymentGroupDescriptor {
  version: 1;
  id: string;
  sourcePaymentId: string;
  sourceInvoiceId: string;
  memberIds: string[];
  memberSequences: number[];
  requestHash: string;
}
export interface ShadowSnapshotEntry {
  sequence: number;
  record: ShadowRecord;
}
export interface ShadowStatus {
  enabled: true;
  binding: ShadowBinding;
  counts: Record<ShadowState, number>;
  oldestUnappliedAgeMs: number | null;
  items: Array<
    Pick<
      ShadowRecord,
      'id' | 'operation' | 'state' | 'createdAt' | 'targetId' | 'reason' | 'nextAttemptAt'
    >
  >;
}
export interface ShadowTargetReceipt {
  targetId: string;
  receipt: unknown;
}
export interface ShadowAdapter {
  /** Pure validation/translation. Return a reason for unsupported semantics. */
  prepare(record: ShadowRecord): { request: unknown } | { blocked: string };
  /** Exactly one attempt. No automatic retry on timeout, 429, or missing cache. */
  apply(record: ShadowRecord, request: unknown): Promise<ShadowTargetReceipt>;
  /** Read-only verification of a previously persisted target identity. */
  verify?(record: ShadowRecord): Promise<boolean>;
}
/** Source evidence for one target effect, not a target authorization or live adapter. */
export interface ShadowPaymentGroup {
  id: string;
  sourcePaymentId: string;
  sourceInvoiceId: string;
  members: ShadowSnapshotEntry[];
  sourceResult: unknown;
}
export interface ShadowPaymentAdapter {
  prepare(group: ShadowPaymentGroup): { request: unknown } | { blocked: string };
  apply(group: ShadowPaymentGroup, request: unknown): Promise<ShadowTargetReceipt>;
  verify?(group: ShadowPaymentGroup, receipt: ShadowTargetReceipt): Promise<boolean>;
}
export interface PaymentDrainResult {
  state: 'idle' | 'deferred' | 'cancelled' | 'applied' | 'blocked' | 'unknown' | 'retry';
  intentIds: string[];
}
export interface OperationObserver {
  execute<T>(operation: string, args: unknown[], invoke: () => Promise<T>): Promise<T>;
  status(): ShadowStatus;
}

/** Host callback may use this ONLY when no target mutation was dispatched at all. */
export class TargetNotDispatchedError extends Error {
  constructor() {
    super('Target unavailable before dispatch');
    this.name = 'TargetNotDispatchedError';
  }
}

/** A create receipt exists but readback failed. Preserve its identity without retrying create. */
export class TargetReceiptPendingError extends Error {
  constructor(
    readonly targetId: string,
    readonly receipt: unknown,
    options: ErrorOptions,
  ) {
    super('Target create has a receipt but readback is unresolved', options);
    this.name = 'TargetReceiptPendingError';
  }
}
