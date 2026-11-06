import type { ShadowBinding, ShadowRecord } from './types.js';

export type ShadowResourceKind =
  'customer' | 'supplier' | 'article' | 'invoice' | 'invoice-payment';

export type ShadowIdentityResolution =
  | { state: 'missing' }
  | { state: 'unresolved'; intentIds: string[]; reason: string }
  | { state: 'conflict'; intentIds: string[]; reason: string }
  | {
      state: 'ready';
      resource: ShadowResourceKind;
      sourceId: string;
      targetId: string;
      intentId: string;
      requestHash: string;
      sourceCompany: string;
      targetCompany: string;
      /**
       * Customer resources only: the confirmed source customer's evidence fields (empty string when
       * absent), so invoice header copies can be checked against the mirrored customer.
       */
      sourceCustomer?: ShadowSourceCustomer;
    };

export interface ShadowSourceCustomer {
  Name: string;
  OrganisationNumber: string;
  Phone1: string;
  Phone2: string;
  Address1: string;
  Address2: string;
  ZipCode: string;
  City: string;
}

type CreatorIdentity = { kind: ShadowResourceKind; sourceField: string; allowNumeric?: boolean };

/**
 * Identity sources: operations whose applied receipt may establish a source-to-target identity.
 * Creators (create*) record an effect that happened; baselines (NOX-213) link a pre-existing
 * Fortnox record to an Accounted one. A baseline is never recorded as a creator.
 */
const CREATOR_IDENTITIES: Readonly<Record<string, CreatorIdentity>> = Object.freeze({
  createCustomer: { kind: 'customer', sourceField: 'CustomerNumber' },
  createSupplier: { kind: 'supplier', sourceField: 'SupplierNumber' },
  createArticle: { kind: 'article', sourceField: 'ArticleNumber', allowNumeric: false },
  createInvoice: { kind: 'invoice', sourceField: 'DocumentNumber' },
  creditInvoice: { kind: 'invoice', sourceField: 'DocumentNumber' },
  createInvoicePayment: { kind: 'invoice-payment', sourceField: 'Number' },
  baselineCustomer: { kind: 'customer', sourceField: 'CustomerNumber' },
  baselineArticle: { kind: 'article', sourceField: 'ArticleNumber', allowNumeric: false },
});

/** Host/operator-initiated baseline operations (never model tools; not in the Fortnox catalogue). */
export const BASELINE_OPERATIONS: ReadonlySet<string> = new Set([
  'baselineCustomer',
  'baselineArticle',
]);

/**
 * Operations whose target side issues read-only requests only. Only these may report a proven
 * mismatch as `blocked` (TargetBlockedError); for every other operation an error after dispatch
 * leaves the outcome unknown.
 */
export const READ_ONLY_TARGET_OPERATIONS: ReadonlySet<string> = new Set(['baselineArticle']);

const RESOURCE_KINDS: ReadonlySet<string> = new Set([
  'customer',
  'supplier',
  'article',
  'invoice',
  'invoice-payment',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidIdentityString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function isValidRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f]/.test(value)
  );
}

function sourceIdentity(
  record: ShadowRecord,
  sourceField: string,
  allowNumeric = true,
): string | undefined {
  if (!isPlainObject(record.sourceResult)) return undefined;
  const value = record.sourceResult[sourceField];
  if (isValidIdentityString(value)) return value;
  // Catalog numbers are opaque strings; numeric coercion can lose leading zeros.
  if (allowNumeric && typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value);
  return undefined;
}

function intentIds(records: readonly ShadowRecord[]): string[] {
  return records.map((record) => (typeof record.id === 'string' ? record.id : ''));
}

function unresolved(record: ShadowRecord, reason: string): ShadowIdentityResolution {
  return { state: 'unresolved', intentIds: intentIds([record]), reason };
}

function conflict(records: readonly ShadowRecord[], reason: string): ShadowIdentityResolution {
  return { state: 'conflict', intentIds: intentIds(records), reason };
}

function hasConfirmedTargetIdentity(record: ShadowRecord): record is ShadowRecord & {
  targetId: string;
  targetReceipt: Record<string, unknown>;
} {
  if (typeof record.targetId !== 'string' || !UUID_PATTERN.test(record.targetId)) return false;
  if (!isPlainObject(record.targetReceipt) || !isPlainObject(record.targetReceipt.data))
    return false;
  return record.targetReceipt.data.id === record.targetId;
}

/**
 * Project a source receipt onto its already-persisted target identity.
 * This is lookup evidence only: it does not authorize a create or prove current remote state.
 */
export function resolveShadowIdentity(
  records: readonly ShadowRecord[],
  binding: ShadowBinding,
  kind: ShadowResourceKind,
  sourceId: string,
): ShadowIdentityResolution {
  if (typeof kind !== 'string' || !RESOURCE_KINDS.has(kind)) {
    throw new Error('Invalid shadow resource kind');
  }
  if (!isValidIdentityString(sourceId)) throw new Error('Invalid shadow source identity');
  if (
    !binding ||
    typeof binding.sourceCompany !== 'string' ||
    !binding.sourceCompany.trim() ||
    typeof binding.targetCompany !== 'string' ||
    !binding.targetCompany.trim()
  ) {
    throw new Error('Invalid shadow company binding');
  }

  const relevant = records.filter((record) => CREATOR_IDENTITIES[record.operation]?.kind === kind);
  if (
    relevant.some(
      (record) =>
        record.sourceCompany !== binding.sourceCompany ||
        record.targetCompany !== binding.targetCompany,
    )
  ) {
    throw new Error('Shadow identity company binding mismatch');
  }

  const matching = relevant.filter((record) => {
    const creator = CREATOR_IDENTITIES[record.operation]!;
    return sourceIdentity(record, creator.sourceField, creator.allowNumeric) === sourceId;
  });

  if (matching.length > 1) {
    return conflict(matching, 'Multiple identity-source intents match the source identity.');
  }
  const record = matching[0];
  if (!record) return { state: 'missing' };

  if (typeof record.targetId === 'string' && UUID_PATTERN.test(record.targetId)) {
    const normalizedTargetId = record.targetId.toLowerCase();
    const collisions = relevant.filter((other) => {
      if (other === record || typeof other.targetId !== 'string') return false;
      if (!UUID_PATTERN.test(other.targetId) || other.targetId.toLowerCase() !== normalizedTargetId)
        return false;
      const otherCreator = CREATOR_IDENTITIES[other.operation]!;
      const otherSourceId = sourceIdentity(
        other,
        otherCreator.sourceField,
        otherCreator.allowNumeric,
      );
      return otherSourceId !== sourceId;
    });
    if (collisions.length > 0) {
      return conflict(
        [record, ...collisions],
        'A persisted target UUID is claimed by another creator intent.',
      );
    }
  }

  if (record.state !== 'applied') {
    return unresolved(record, 'Creator intent is not in the applied state.');
  }

  if (!hasConfirmedTargetIdentity(record)) {
    return unresolved(
      record,
      'Applied creator receipt does not confirm its persisted target UUID.',
    );
  }

  if (
    !isValidRecordId(record.id) ||
    typeof record.requestHash !== 'string' ||
    !record.requestHash
  ) {
    return unresolved(record, 'Applied creator intent evidence is malformed.');
  }

  return {
    state: 'ready',
    resource: kind,
    sourceId,
    targetId: record.targetId,
    intentId: record.id,
    requestHash: record.requestHash,
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    ...(kind === 'customer' ? { sourceCustomer: sourceCustomer(record) } : {}),
  };
}

function addressText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : `\u0000${typeof value}`;
}

function sourceCustomer(record: ShadowRecord): ShadowSourceCustomer {
  const source = isPlainObject(record.sourceResult) ? record.sourceResult : {};
  return {
    Name: addressText(source.Name),
    OrganisationNumber: addressText(source.OrganisationNumber),
    Phone1: addressText(source.Phone1),
    Phone2: addressText(source.Phone2),
    Address1: addressText(source.Address1),
    Address2: addressText(source.Address2),
    ZipCode: addressText(source.ZipCode),
    City: addressText(source.City),
  };
}
