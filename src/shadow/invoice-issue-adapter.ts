import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mapInvoiceDraft } from './invoice-draft-mapping.js';
import type { InvoiceDraftExpected } from './invoice-draft-mapping.js';
import { matchesInvoiceExpected } from './invoice-draft-adapter.js';
import type { AccountedRequestCallback } from './accounted-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from './identity.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord } from './types.js';
import { TargetReceiptPendingError } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_NUMBER = /^[1-9]\d*$/;
const ENVELOPE_KEYS = new Set(['invoice', 'confirmed', 'pdf']);

type IdentityLookup = (resource: ShadowResourceKind, sourceId: string) => ShadowIdentityResolution;
type ReadIntent = (id: string) => ShadowRecord | undefined;

export interface InvoiceIssuePlan {
  targetId: string;
  sourceInvoiceId: string;
  creatorIntentId: string;
  creatorRequestHash: string;
  expected: InvoiceDraftExpected;
}

interface IssueReceiptBase {
  version: 1;
  kind: 'invoice-issue';
  complete: boolean;
  issueIntentId: string;
  issueRequestHash: string;
  creatorIntentId: string;
  creatorRequestHash: string;
  sourceCompany: string;
  targetCompany: string;
  sourceInvoiceId: string;
  targetId: string;
  expected: InvoiceDraftExpected;
}

export interface InvoiceIssueReceipt extends IssueReceiptBase {
  complete: true;
  mutation: {
    status: 200;
    response: Record<string, unknown>;
  };
}

interface PendingInvoiceIssueReceipt extends IssueReceiptBase {
  complete: false;
  mutation?: {
    status?: number;
    response?: unknown;
  };
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function data(value: unknown): Record<string, unknown> | undefined {
  return plain(value) && plain(value.data) ? value.data : undefined;
}

function sourceDocumentId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && DOCUMENT_NUMBER.test(value)) return value;
  return undefined;
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return (
    Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key))
  );
}

function matchingIdentity(
  value: unknown,
  binding: ShadowBinding,
  sourceInvoiceId: string,
): value is Extract<ShadowIdentityResolution, { state: 'ready' }> {
  return (
    plain(value) &&
    value.state === 'ready' &&
    value.resource === 'invoice' &&
    value.sourceId === sourceInvoiceId &&
    value.sourceCompany === binding.sourceCompany &&
    value.targetCompany === binding.targetCompany &&
    nonempty(value.targetId) &&
    UUID.test(value.targetId) &&
    nonempty(value.intentId) &&
    nonempty(value.requestHash)
  );
}

function sourceEnvelope(
  value: unknown,
): { invoice: Record<string, unknown> } | { blocked: string } {
  if (!plain(value) || !exactKeys(value, ENVELOPE_KEYS)) {
    return { blocked: 'Invoice issue requires the exact markInvoicePrinted receipt envelope.' };
  }
  if (value.confirmed !== true) {
    return { blocked: 'Invoice issue requires a confirmed markInvoicePrinted receipt.' };
  }
  if (!plain(value.invoice)) return { blocked: 'Invoice issue source invoice is malformed.' };
  if (value.pdf !== undefined && (!Buffer.isBuffer(value.pdf) || value.pdf.length === 0)) {
    return { blocked: 'Invoice issue print PDF receipt is malformed.' };
  }
  const sourceInvoiceId = sourceDocumentId(value.invoice.DocumentNumber);
  if (!sourceInvoiceId || value.invoice.Sent !== true) {
    return { blocked: 'Invoice issue source invoice must have the exact number and Sent=true.' };
  }
  return { invoice: value.invoice };
}

function creatorReceipt(
  creator: ShadowRecord,
  targetId: string,
  expected: InvoiceDraftExpected,
  sourceInvoiceId: string,
): boolean {
  return (
    creator.state === 'applied' &&
    creator.operation === 'createInvoice' &&
    creator.targetId === targetId &&
    plain(creator.targetReceipt) &&
    plain(creator.targetReceipt.data) &&
    creator.targetReceipt.data.id === targetId &&
    isDeepStrictEqual(creator.targetReceipt.expected, expected) &&
    creator.targetReceipt.sourceInvoiceId === sourceInvoiceId
  );
}

function normalizedSource(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, Sent: false };
}

function issueReceiptBase(
  record: ShadowRecord,
  plan: InvoiceIssuePlan,
): Omit<IssueReceiptBase, 'complete'> {
  return {
    version: 1,
    kind: 'invoice-issue',
    issueIntentId: record.id,
    issueRequestHash: record.requestHash,
    creatorIntentId: plan.creatorIntentId,
    creatorRequestHash: plan.creatorRequestHash,
    sourceCompany: record.sourceCompany,
    targetCompany: record.targetCompany,
    sourceInvoiceId: plan.sourceInvoiceId,
    targetId: plan.targetId,
    expected: plan.expected,
  };
}

function completeReceipt(
  record: ShadowRecord,
  plan: InvoiceIssuePlan,
  response: Record<string, unknown>,
): InvoiceIssueReceipt {
  return {
    ...issueReceiptBase(record, plan),
    complete: true,
    mutation: { status: 200, response },
  };
}

function pendingReceipt(
  record: ShadowRecord,
  plan: InvoiceIssuePlan,
  status?: number,
  response?: unknown,
): PendingInvoiceIssueReceipt {
  return {
    ...issueReceiptBase(record, plan),
    complete: false,
    mutation: { status, response },
  };
}

/**
 * Synthetic-only issue transition for an already applied strict CASH/SEK draft.
 * It has no client, credentials, CLI registration, or live dispatch wiring.
 */
export class AccountedInvoiceIssueAdapter implements ShadowAdapter {
  private readonly binding: Readonly<ShadowBinding>;
  private readonly path: string;

  constructor(
    binding: ShadowBinding,
    private readonly lookup: IdentityLookup,
    private readonly readIntent: ReadIntent,
    private readonly request: AccountedRequestCallback,
  ) {
    if (
      !binding ||
      typeof binding.sourceCompany !== 'string' ||
      !binding.sourceCompany.trim() ||
      typeof binding.targetCompany !== 'string' ||
      !UUID.test(binding.targetCompany)
    ) {
      throw new Error('Invalid invoice issue company binding');
    }
    this.binding = Object.freeze({ ...binding });
    this.path = `/api/v1/companies/${encodeURIComponent(binding.targetCompany)}/invoices`;
  }

  prepare(record: ShadowRecord): { request: InvoiceIssuePlan } | { blocked: string } {
    if (
      !record ||
      record.sourceCompany !== this.binding.sourceCompany ||
      record.targetCompany !== this.binding.targetCompany
    )
      return { blocked: 'Invoice issue company binding does not match the adapter.' };
    if (record.operation !== 'markInvoicePrinted') {
      return { blocked: 'Only markInvoicePrinted is supported by the invoice issue adapter.' };
    }
    if (!Array.isArray(record.args) || record.args.length !== 1 || !nonempty(record.args[0])) {
      return { blocked: 'Invoice issue requires exactly one document number argument.' };
    }
    const sourceInvoiceId = sourceDocumentId(record.args[0]);
    if (!sourceInvoiceId || record.args[0] !== sourceInvoiceId) {
      return { blocked: 'Invoice issue document number must be an exact positive string.' };
    }
    const envelope = sourceEnvelope(record.sourceResult);
    if ('blocked' in envelope) return envelope;
    if (sourceDocumentId(envelope.invoice.DocumentNumber) !== sourceInvoiceId) {
      return { blocked: 'Issue argument and confirmed source invoice number do not match.' };
    }
    if (!nonempty(record.id) || !nonempty(record.requestHash)) {
      return { blocked: 'Invoice issue requires durable intent identity and request hash.' };
    }

    const identity = this.lookup('invoice', sourceInvoiceId);
    if (!matchingIdentity(identity, this.binding, sourceInvoiceId)) {
      return { blocked: 'Applied invoice creator identity is missing or unresolved.' };
    }
    if (record.targetId !== undefined && record.targetId !== identity.targetId) {
      return { blocked: 'Persisted issue target UUID does not match the applied creator.' };
    }
    const creator = this.readIntent(identity.intentId);
    if (
      !creator ||
      creator.sourceCompany !== this.binding.sourceCompany ||
      creator.targetCompany !== this.binding.targetCompany ||
      creator.requestHash !== identity.requestHash ||
      creator.id !== identity.intentId ||
      !plain(creator.sourceResult)
    ) {
      return { blocked: 'Applied invoice creator intent cannot be verified.' };
    }
    const original = mapInvoiceDraft(creator, this.binding, this.lookup);
    if ('blocked' in original)
      return { blocked: `Creator draft mapping is not strict: ${original.blocked}` };
    if (!creatorReceipt(creator, identity.targetId, original.expected, sourceInvoiceId)) {
      return { blocked: 'Creator target receipt does not match its strict draft mapping.' };
    }

    const creatorSource = creator.sourceResult;
    if (!plain(creatorSource)) return { blocked: 'Creator source invoice is malformed.' };
    if (!isDeepStrictEqual(normalizedSource(creatorSource), normalizedSource(envelope.invoice))) {
      return { blocked: 'Source invoice changed beyond the known Sent transition.' };
    }
    const issueRecord: ShadowRecord = {
      ...creator,
      id: record.id,
      requestHash: record.requestHash,
      state: record.state,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      sourceResult: { ...creatorSource, Sent: false },
    };
    const remapped = mapInvoiceDraft(issueRecord, this.binding, this.lookup);
    if (
      'blocked' in remapped ||
      !isDeepStrictEqual(remapped.request, original.request) ||
      !isDeepStrictEqual(remapped.expected, original.expected) ||
      remapped.sourceInvoiceId !== original.sourceInvoiceId
    ) {
      return { blocked: 'Source invoice no longer matches the original strict draft mapping.' };
    }
    return {
      request: {
        targetId: identity.targetId,
        sourceInvoiceId,
        creatorIntentId: identity.intentId,
        creatorRequestHash: identity.requestHash,
        expected: original.expected,
      },
    };
  }

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: InvoiceIssueReceipt }> {
    const prepared = this.prepare(record);
    if (!('request' in prepared) || !isDeepStrictEqual(prepared.request, request)) {
      throw new Error('Invoice issue request does not match its prepared mapping.');
    }
    const plan = prepared.request;
    const draftReadback = await this.request({
      method: 'GET',
      path: `${this.path}/${encodeURIComponent(plan.targetId)}?expand=items`,
    });
    if (
      draftReadback.status !== 200 ||
      !matchesInvoiceExpected(draftReadback.json, plan.targetId, plan.expected)
    ) {
      throw new Error('Invoice issue target is not the exact confirmed draft.');
    }
    const rechecked = this.prepare(record);
    if (!('request' in rechecked) || !isDeepStrictEqual(rechecked.request, plan)) {
      throw new Error('Invoice issue mapping changed after target draft verification.');
    }

    const idempotencyKey = `shadow_issue_${createHash('sha256')
      .update(
        JSON.stringify([
          this.binding.sourceCompany,
          this.binding.targetCompany,
          record.id,
          record.requestHash,
          plan.targetId,
        ]),
      )
      .digest('hex')}`;
    let response: { status: number; json: unknown };
    try {
      response = await this.request({
        method: 'POST',
        path: `${this.path}/${encodeURIComponent(plan.targetId)}/mark-sent`,
        idempotencyKey,
      });
    } catch (cause) {
      throw new TargetReceiptPendingError(plan.targetId, pendingReceipt(record, plan), { cause });
    }
    const issued = data(response.json);
    if (
      response.status !== 200 ||
      !issued ||
      issued.id !== plan.targetId ||
      issued.status !== 'sent' ||
      !nonempty(issued.invoice_number) ||
      issued.total !== plan.expected.total ||
      !Object.hasOwn(issued, 'journal_entry_id') ||
      issued.journal_entry_id !== null ||
      (Object.hasOwn(issued, 'warnings') &&
        (!Array.isArray(issued.warnings) || issued.warnings.length !== 0))
    ) {
      throw new TargetReceiptPendingError(
        plan.targetId,
        pendingReceipt(record, plan, response.status, response.json),
        { cause: new Error('Invoice issue response is incomplete or contradictory') },
      );
    }
    const receipt = completeReceipt(record, plan, issued);
    try {
      const readback = await this.request({
        method: 'GET',
        path: `${this.path}/${encodeURIComponent(plan.targetId)}?expand=items`,
      });
      if (
        readback.status !== 200 ||
        !matchesInvoiceExpected(readback.json, plan.targetId, plan.expected, {
          status: 'sent',
          invoiceNumber: issued.invoice_number,
        })
      ) {
        throw new Error('Issued invoice expanded readback differs from the confirmed issue.');
      }
    } catch (cause) {
      throw new TargetReceiptPendingError(plan.targetId, receipt, { cause });
    }
    return { targetId: plan.targetId, receipt };
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    const prepared = this.prepare(record);
    if (
      !('request' in prepared) ||
      record.targetId !== prepared.request.targetId ||
      !plain(record.targetReceipt) ||
      record.targetReceipt.version !== 1 ||
      record.targetReceipt.kind !== 'invoice-issue' ||
      record.targetReceipt.complete !== true ||
      record.targetReceipt.issueIntentId !== record.id ||
      record.targetReceipt.issueRequestHash !== record.requestHash ||
      record.targetReceipt.creatorIntentId !== prepared.request.creatorIntentId ||
      record.targetReceipt.creatorRequestHash !== prepared.request.creatorRequestHash ||
      record.targetReceipt.sourceCompany !== this.binding.sourceCompany ||
      record.targetReceipt.targetCompany !== this.binding.targetCompany ||
      record.targetReceipt.sourceInvoiceId !== prepared.request.sourceInvoiceId ||
      record.targetReceipt.targetId !== prepared.request.targetId ||
      !isDeepStrictEqual(record.targetReceipt.expected, prepared.request.expected) ||
      !plain(record.targetReceipt.mutation) ||
      record.targetReceipt.mutation.status !== 200 ||
      !plain(record.targetReceipt.mutation.response) ||
      !nonempty(record.targetReceipt.mutation.response.invoice_number)
    ) {
      return false;
    }
    const response = record.targetReceipt.mutation.response;
    const invoiceNumber = response.invoice_number;
    if (
      response.id !== prepared.request.targetId ||
      response.status !== 'sent' ||
      response.total !== prepared.request.expected.total ||
      response.journal_entry_id !== null ||
      (Object.hasOwn(response, 'warnings') &&
        (!Array.isArray(response.warnings) || response.warnings.length !== 0))
    ) {
      return false;
    }
    const readback = await this.request({
      method: 'GET',
      path: `${this.path}/${encodeURIComponent(prepared.request.targetId)}?expand=items`,
    });
    return (
      readback.status === 200 &&
      matchesInvoiceExpected(readback.json, prepared.request.targetId, prepared.request.expected, {
        status: 'sent',
        invoiceNumber: typeof invoiceNumber === 'string' ? invoiceNumber : null,
      })
    );
  }
}
