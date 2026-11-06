import { canonicalEncode, decode } from './codec.js';
import { resolveShadowIdentity, type ShadowResourceKind } from './identity.js';
import { OPERATION_CATALOGUE } from './operations.js';
import { AccountedInvoiceDraftAdapter } from './invoice-draft-adapter.js';
import { AccountedInvoiceIssueAdapter } from './invoice-issue-adapter.js';
import type { AccountedRequest, AccountedResponse } from './accounted-adapter.js';
import type { ShadowBinding, ShadowRecord, ShadowSnapshotEntry } from './types.js';

const DOCUMENT_NUMBER = /^[1-9]\d*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECT_INVOICE_OPERATIONS = new Set([
  'updateInvoice',
  'sendInvoice',
  'markInvoicePrinted',
  'bookkeepInvoice',
  'creditInvoice',
  'cancelInvoice',
  'externalPrintInvoice',
  'eprintInvoice',
  'getInvoiceReminderPdf',
]);
const VALID_ATTACHMENT_ENTITY_TYPES = new Set(['F', 'OF', 'O', 'C']);

export type InvoiceStageState =
  'verified' | 'missing' | 'unresolved' | 'conflict' | 'unsupported' | 'mismatch' | 'stale';

export interface InvoiceStageVerified {
  state: 'verified';
  stage: 'draft' | 'sent';
  proof: 'draft-receipt' | 'issue-receipt';
  sourceInvoiceId: string;
  sourceCompany: string;
  targetCompany: string;
  targetId: string;
  intentId: string;
  sequence: number;
}

export interface InvoiceStageUnverified {
  state: Exclude<InvoiceStageState, 'verified'>;
  reason: string;
  intentIds: string[];
}

export type InvoiceStageVerification = InvoiceStageVerified | InvoiceStageUnverified;

type Snapshot = {
  entries: readonly ShadowSnapshotEntry[];
  records: readonly ShadowRecord[];
  encoded: string;
};

type Relation =
  | { kind: 'unrelated' }
  | { kind: 'issue' }
  | { kind: 'transition' }
  | { kind: 'unsupported'; reason: string };

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function documentId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && DOCUMENT_NUMBER.test(value)) return value;
  return undefined;
}

function intentId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function result(state: Exclude<InvoiceStageState, 'verified'>, reason: string, ids: string[]) {
  return { state, reason, intentIds: [...new Set(ids)] } as InvoiceStageUnverified;
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,80}$/.test(error.name)
    ? error.name
    : 'UnknownError';
}

function snapshotFrom(
  raw: readonly ShadowSnapshotEntry[],
  binding: ShadowBinding,
): Snapshot | null {
  let cloned: unknown;
  try {
    cloned = decode(canonicalEncode(raw));
  } catch (cause) {
    throw new Error('Invoice stage snapshot cannot be decoded.', { cause });
  }
  if (!Array.isArray(cloned)) return null;
  let previous = 0;
  const ids = new Set<string>();
  const entries: ShadowSnapshotEntry[] = [];
  for (const value of cloned) {
    if (!plain(value) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0)
      return null;
    const sequence = value.sequence as number;
    if (sequence <= previous) return null;
    previous = sequence;
    if (!plain(value.record)) return null;
    const record = value.record;
    if (
      record.version !== 1 ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      ids.has(record.id) ||
      typeof record.operation !== 'string' ||
      record.sourceCompany !== binding.sourceCompany ||
      record.targetCompany !== binding.targetCompany
    )
      return null;
    ids.add(record.id);
    entries.push({ sequence, record: record as unknown as ShadowRecord });
  }
  const frozen = deepFreeze(entries);
  return {
    entries: frozen,
    records: deepFreeze(entries.map(({ record }) => record)),
    encoded: canonicalEncode(frozen),
  };
}

function directRelation(record: ShadowRecord, sourceInvoiceId: string): Relation {
  if (!Array.isArray(record.args) || record.args.length < 1) {
    return { kind: 'unsupported', reason: `${record.operation} has malformed invoice arguments.` };
  }
  const id = documentId(record.args[0]);
  if (!id)
    return { kind: 'unsupported', reason: `${record.operation} has no valid invoice number.` };
  if (id !== sourceInvoiceId) return { kind: 'unrelated' };
  return record.operation === 'markInvoicePrinted' ? { kind: 'issue' } : { kind: 'transition' };
}

function classifyRelation(record: ShadowRecord, sourceInvoiceId: string): Relation {
  const operation = record.operation;
  if (!Object.hasOwn(OPERATION_CATALOGUE, operation)) {
    return { kind: 'unsupported', reason: `Unknown operation: ${operation}.` };
  }
  const classification = OPERATION_CATALOGUE[operation];
  if (/SupplierInvoice/i.test(operation)) return { kind: 'unrelated' };
  if (operation === 'increaseInvoiceCount') return { kind: 'unrelated' };
  if (
    classification === 'mode-dependent' &&
    /Invoice|Attachment|Accrual|TaxReduction/.test(operation)
  ) {
    return {
      kind: 'unsupported',
      reason: `Mode-dependent operation is not safely classified: ${operation}.`,
    };
  }
  if (classification !== 'write') return { kind: 'unrelated' };
  if (!Array.isArray(record.args) && /Invoice|Attachment|Accrual|TaxReduction/.test(operation)) {
    return { kind: 'unsupported', reason: `${operation} has malformed arguments.` };
  }
  if (operation === 'createInvoice') {
    const id = plain(record.sourceResult)
      ? documentId(record.sourceResult.DocumentNumber)
      : undefined;
    if (!id)
      return {
        kind: 'unsupported',
        reason: 'createInvoice has no confirmed source DocumentNumber.',
      };
    return id === sourceInvoiceId ? { kind: 'transition' } : { kind: 'unrelated' };
  }
  if (DIRECT_INVOICE_OPERATIONS.has(operation)) return directRelation(record, sourceInvoiceId);
  if (operation === 'attachInvoiceFiles') {
    const id = plain(record.args?.[0]) ? documentId(record.args[0].documentNumber) : undefined;
    if (!id)
      return { kind: 'unsupported', reason: 'attachInvoiceFiles has no valid document number.' };
    return id === sourceInvoiceId ? { kind: 'transition' } : { kind: 'unrelated' };
  }
  if (operation === 'createDocumentAttachment') {
    const entityType = record.args?.[1];
    if (typeof entityType !== 'string' || !VALID_ATTACHMENT_ENTITY_TYPES.has(entityType)) {
      return {
        kind: 'unsupported',
        reason: 'createDocumentAttachment has an invalid entity type.',
      };
    }
    if (entityType !== 'F') return { kind: 'unrelated' };
    const id = documentId(record.args?.[0]);
    if (!id)
      return { kind: 'unsupported', reason: 'Invoice attachment has no valid document number.' };
    return id === sourceInvoiceId ? { kind: 'transition' } : { kind: 'unrelated' };
  }
  if (operation === 'createInvoicePayment') {
    const id = plain(record.args?.[0]) ? documentId(record.args[0].InvoiceNumber) : undefined;
    if (!id)
      return { kind: 'unsupported', reason: 'createInvoicePayment has no valid InvoiceNumber.' };
    return id === sourceInvoiceId ? { kind: 'transition' } : { kind: 'unrelated' };
  }
  if (
    operation === 'createInvoiceFromContract' ||
    operation === 'createInvoiceFromOffer' ||
    operation === 'createInvoiceFromOrder'
  ) {
    const id = plain(record.sourceResult)
      ? documentId(record.sourceResult.DocumentNumber)
      : undefined;
    if (!id)
      return {
        kind: 'unsupported',
        reason: `${operation} has no confirmed source DocumentNumber.`,
      };
    return id === sourceInvoiceId ? { kind: 'transition' } : { kind: 'unrelated' };
  }
  if (/Invoice|Attachment|Accrual|TaxReduction/.test(operation)) {
    return {
      kind: 'unsupported',
      reason: `Invoice-related operation is unsupported: ${operation}.`,
    };
  }
  return { kind: 'unrelated' };
}

function idsAround(entries: readonly ShadowSnapshotEntry[], start: number): string[] {
  return entries.slice(start).map(({ record }) => intentId(record.id));
}

/** Read-only projection of one invoice's latest proven local target stage. */
export class AccountedInvoiceStageVerifier {
  private readonly binding: Readonly<ShadowBinding>;

  constructor(
    binding: ShadowBinding,
    private readonly snapshot: () => readonly ShadowSnapshotEntry[],
    private readonly request: (request: AccountedRequest) => Promise<AccountedResponse>,
    private readonly diagnosticSink?: (error: Error) => void,
  ) {
    if (
      !binding ||
      typeof binding.sourceCompany !== 'string' ||
      !binding.sourceCompany.trim() ||
      typeof binding.targetCompany !== 'string' ||
      !UUID.test(binding.targetCompany)
    )
      throw new Error('Invalid invoice stage company binding');
    this.binding = Object.freeze({ ...binding });
  }

  async verify(sourceInvoiceId: string): Promise<InvoiceStageVerification> {
    let first: Snapshot;
    try {
      first = this.capture();
    } catch (error) {
      return this.diagnose(
        result('conflict', `Invoice stage snapshot is unavailable (${errorName(error)}).`, []),
        error,
      );
    }
    if (!documentId(sourceInvoiceId))
      return result('unresolved', 'Invoice number is malformed.', []);
    let identity;
    try {
      identity = resolveShadowIdentity(first.records, this.binding, 'invoice', sourceInvoiceId);
    } catch (error) {
      return this.diagnose(
        result(
          'conflict',
          `Invoice creator identity could not be resolved (${errorName(error)}).`,
          [],
        ),
        error,
      );
    }
    if (identity.state !== 'ready') {
      return result(
        identity.state,
        `Invoice creator identity is ${identity.state}.`,
        'intentIds' in identity ? identity.intentIds : [],
      );
    }
    const creatorEntry = first.entries.find(({ record }) => record.id === identity.intentId);
    if (!creatorEntry)
      return result('unresolved', 'Creator intent is absent from the snapshot.', [
        identity.intentId,
      ]);
    if (creatorEntry.record.operation !== 'createInvoice') {
      return result('unsupported', 'Credit or indirect invoice creators are not ordinary drafts.', [
        identity.intentId,
      ]);
    }
    if (creatorEntry.record.state !== 'applied') {
      return result('unresolved', 'Invoice creator is not applied.', [identity.intentId]);
    }

    const laterIssues: ShadowSnapshotEntry[] = [];
    const laterTransitions: string[] = [];
    for (const entry of first.entries) {
      const relation = classifyRelation(entry.record, sourceInvoiceId);
      if (entry.sequence < creatorEntry.sequence) {
        if (relation.kind === 'issue' || relation.kind === 'transition') {
          return result('mismatch', 'Invoice mutation precedes its creator.', [
            entry.record.id,
            identity.intentId,
          ]);
        }
        continue;
      }
      if (entry.record.id === creatorEntry.record.id) continue;
      if (relation.kind === 'issue') laterIssues.push(entry);
      else if (relation.kind === 'transition') laterTransitions.push(entry.record.id);
      else if (relation.kind === 'unsupported') {
        return result('unsupported', relation.reason, [entry.record.id, identity.intentId]);
      }
    }
    if (laterTransitions.length > 0) {
      return result('unsupported', 'Unsupported invoice transition follows the creator.', [
        identity.intentId,
        ...laterTransitions,
      ]);
    }
    if (laterIssues.length > 1) {
      return result('conflict', 'Multiple markInvoicePrinted transitions follow the creator.', [
        identity.intentId,
        ...laterIssues.map(({ record }) => record.id),
      ]);
    }

    const lookup = (kind: ShadowResourceKind, id: string) =>
      resolveShadowIdentity(first.records, this.binding, kind, id);
    const readIntent = (id: string) => first.records.find((record) => record.id === id);
    const getOnly = async (request: AccountedRequest): Promise<AccountedResponse> => {
      if (request.method !== 'GET') throw new Error('Invoice stage verifier permits GET only.');
      return this.request(request);
    };
    let stage: InvoiceStageVerified['stage'];
    let proof: InvoiceStageVerified['proof'];
    let verified = false;
    let selectedEntry = creatorEntry;
    let failure: InvoiceStageUnverified | undefined;
    let readFailure: InvoiceStageUnverified | undefined;
    if (laterIssues.length === 1) {
      const issue = laterIssues[0]!;
      if (issue.record.state !== 'applied') {
        failure = result('unresolved', 'Invoice issue is not applied.', [
          identity.intentId,
          issue.record.id,
        ]);
      } else {
        selectedEntry = issue;
        const adapter = new AccountedInvoiceIssueAdapter(this.binding, lookup, readIntent, getOnly);
        try {
          verified = await adapter.verify(issue.record);
        } catch (error) {
          verified = false;
          readFailure = this.diagnose(
            result('unresolved', `Target issue read failed (${errorName(error)}).`, [
              identity.intentId,
              issue.record.id,
            ]),
            new Error('Target issue read failed.', { cause: error }),
          );
        }
        stage = 'sent';
        proof = 'issue-receipt';
        if (!verified)
          failure = result(
            'mismatch',
            'Complete issue receipt or current issued target does not verify.',
            [identity.intentId, issue.record.id],
          );
      }
    } else {
      const adapter = new AccountedInvoiceDraftAdapter(this.binding, lookup, getOnly);
      try {
        verified = await adapter.verify(creatorEntry.record);
      } catch (error) {
        verified = false;
        readFailure = this.diagnose(
          result('unresolved', `Target draft read failed (${errorName(error)}).`, [
            identity.intentId,
          ]),
          new Error('Target draft read failed.', { cause: error }),
        );
      }
      stage = 'draft';
      proof = 'draft-receipt';
      if (!verified)
        failure = result(
          'mismatch',
          'Current target no longer verifies as the strict draft receipt.',
          [identity.intentId],
        );
    }
    let second: Snapshot;
    try {
      second = this.capture();
    } catch (error) {
      return this.diagnose(
        result(
          'stale',
          `Queue snapshot after target verification is unavailable (${errorName(error)}).`,
          [identity.intentId],
        ),
        error,
      );
    }
    if (second.encoded !== first.encoded) {
      return result('stale', 'Queue snapshot changed during target verification.', [
        identity.intentId,
        ...idsAround(second.entries, 0),
      ]);
    }
    if (readFailure || failure || !verified)
      return (
        readFailure ??
        failure ??
        result('mismatch', 'Invoice target verification failed.', [identity.intentId])
      );
    return {
      state: 'verified',
      stage: stage!,
      proof: proof!,
      sourceInvoiceId,
      sourceCompany: this.binding.sourceCompany,
      targetCompany: this.binding.targetCompany,
      targetId: identity.targetId,
      intentId: selectedEntry.record.id,
      sequence: selectedEntry.sequence,
    };
  }

  private capture(): Snapshot {
    let raw: readonly ShadowSnapshotEntry[];
    try {
      raw = this.snapshot();
    } catch (cause) {
      throw new Error('Invoice stage snapshot callback failed.', { cause });
    }
    const snapshot = snapshotFrom(raw, this.binding);
    if (!snapshot) throw new Error('Invoice stage snapshot is malformed.');
    return snapshot;
  }

  private diagnose<T extends object>(report: T, error: unknown): T {
    if (this.diagnosticSink) {
      try {
        this.diagnosticSink(
          error instanceof Error ? error : new Error('Invoice stage diagnostic.', { cause: error }),
        );
      } catch {
        // Diagnostics are host-owned and must not alter the safe verification result.
      }
    }
    return report;
  }
}
