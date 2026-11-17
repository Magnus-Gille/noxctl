import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InvoiceDraftExpected } from './invoice-draft-mapping.js';
import type { AccountedRequestCallback } from './accounted-adapter.js';
import { AccountedInvoiceIssueAdapter } from './invoice-issue-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from './identity.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord, ShadowSnapshotEntry } from './types.js';
import { TargetReceiptPendingError } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_NUMBER = /^[1-9]\d*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Refusal codes of the credit-note adapter. They never replace the draft-path refusals. */
export const CREDIT_REFUSAL = {
  operation: 'CREDIT_OPERATION_UNSUPPORTED',
  arguments: 'CREDIT_ARGUMENTS_INVALID',
  notCredit: 'CREDIT_SOURCE_NOT_A_CREDIT',
  referenceMismatch: 'CREDIT_REFERENCE_MISMATCH',
  numbers: 'CREDIT_DOCUMENT_NUMBER_INVALID',
  sourceDrift: 'CREDIT_SOURCE_DRIFT',
  /** The route credits the whole original only; any other credit cannot be expressed. */
  partial: 'CREDIT_PARTIAL_UNSUPPORTED',
  originalNotMirrored: 'CREDIT_ORIGINAL_NOT_MIRRORED',
  originalNotIssued: 'CREDIT_ORIGINAL_NOT_ISSUED',
  duplicate: 'CREDIT_DUPLICATE',
  textRow: 'CREDIT_TEXT_ROW_UNSUPPORTED',
} as const;

type IdentityLookup = (resource: ShadowResourceKind, sourceId: string) => ShadowIdentityResolution;
type ReadIntent = (id: string) => ShadowRecord | undefined;
type Snapshot = () => readonly ShadowSnapshotEntry[];

export interface InvoiceCreditPlan {
  /** Target UUID of the mirrored, issued original (the invoice that is credited). */
  originalTargetId: string;
  originalSourceInvoiceId: string;
  /** Accounted invoice_number of the original, from the issue receipt. */
  originalInvoiceNumber: string;
  /** Fortnox DocumentNumber of the credit note (source identity of the credit). */
  creditSourceInvoiceId: string;
  issueIntentId: string;
  issueRequestHash: string;
  creatorIntentId: string;
  creatorRequestHash: string;
  /** Strict mapped expectation of the ORIGINAL draft; the credit is its exact negation. */
  expected: InvoiceDraftExpected;
}

interface CreditReceiptBase {
  version: 1;
  kind: 'invoice-credit';
  complete: boolean;
  creditIntentId: string;
  creditRequestHash: string;
  issueIntentId: string;
  creatorIntentId: string;
  sourceCompany: string;
  targetCompany: string;
  originalSourceInvoiceId: string;
  originalTargetId: string;
  originalInvoiceNumber: string;
  creditSourceInvoiceId: string;
  expected: InvoiceDraftExpected;
}

export interface InvoiceCreditReceipt extends CreditReceiptBase {
  complete: true;
  /** Lets the credit note's own durable identity resolve (see identity.ts `creditInvoice`). */
  data: { id: string };
  mutation: { status: 201; response: Record<string, unknown> };
}

interface PendingInvoiceCreditReceipt extends CreditReceiptBase {
  complete: false;
  mutation?: { status?: number; response?: unknown };
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
function emptyDimensions(value: unknown): boolean {
  return value === null || (plain(value) && Object.keys(value).length === 0);
}
function documentId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && DOCUMENT_NUMBER.test(value)) return value;
  return undefined;
}
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && NUMERIC.test(value)) return Number(value);
  return undefined;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Header fields that legitimately differ between the original and its credit note. */
const CREDIT_HEADER_KEYS: ReadonlySet<string> = new Set([
  'DocumentNumber',
  'Credit',
  'CreditInvoiceReference',
  'InvoiceDate',
  'DueDate',
  'Net',
  'TotalVAT',
  'Total',
  'TotalToPay',
  'Balance',
  'Sent',
  'Booked',
  'InvoiceRows',
]);
const NEGATED_ROW_KEYS: ReadonlySet<string> = new Set([
  'DeliveredQuantity',
  'Total',
  'TotalExcludingVAT',
]);

/**
 * The Accounted route credits the WHOLE original: every source amount and row must equal the
 * negation of the original's, and everything else must be unchanged. Returns a refusal code or
 * undefined when the source is exactly the full credit of the original.
 */
function compareCreditSource(
  original: Record<string, unknown>,
  credit: Record<string, unknown>,
): string | undefined {
  const keys = new Set([...Object.keys(original), ...Object.keys(credit)]);
  for (const key of keys) {
    if (CREDIT_HEADER_KEYS.has(key)) continue;
    if (!isDeepStrictEqual(original[key], credit[key])) return CREDIT_REFUSAL.sourceDrift;
  }
  for (const key of ['InvoiceDate', 'DueDate'] as const) {
    if (typeof credit[key] !== 'string' || !ISO_DATE.test(credit[key])) {
      return CREDIT_REFUSAL.sourceDrift;
    }
  }
  for (const key of ['Sent', 'Booked'] as const) {
    if (Object.hasOwn(credit, key) && typeof credit[key] !== 'boolean') {
      return CREDIT_REFUSAL.sourceDrift;
    }
  }
  for (const key of ['TotalToPay', 'Balance'] as const) {
    if (numeric(credit[key]) === undefined) return CREDIT_REFUSAL.sourceDrift;
  }
  for (const key of ['Net', 'TotalVAT', 'Total'] as const) {
    const base = numeric(original[key]);
    const value = numeric(credit[key]);
    if (base === undefined || value === undefined || value !== -Math.abs(base)) {
      return CREDIT_REFUSAL.partial;
    }
  }
  const originalRows = original.InvoiceRows;
  const creditRows = credit.InvoiceRows;
  if (
    !Array.isArray(originalRows) ||
    !Array.isArray(creditRows) ||
    originalRows.length === 0 ||
    originalRows.length !== creditRows.length
  ) {
    return CREDIT_REFUSAL.partial;
  }
  for (let index = 0; index < originalRows.length; index++) {
    const before: unknown = originalRows[index];
    const after: unknown = creditRows[index];
    if (!plain(before) || !plain(after)) return CREDIT_REFUSAL.sourceDrift;
    const rowKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of rowKeys) {
      if (NEGATED_ROW_KEYS.has(key)) continue;
      if (!isDeepStrictEqual(before[key], after[key])) return CREDIT_REFUSAL.partial;
    }
    for (const key of NEGATED_ROW_KEYS) {
      const base = numeric(before[key]);
      const value = numeric(after[key]);
      if (base === undefined || value === undefined || value !== -Math.abs(base)) {
        return CREDIT_REFUSAL.partial;
      }
    }
  }
  return undefined;
}

/**
 * Exact readback of the credit note the route creates: the whole original, negated line for
 * line. The credit must carry an explicit, positive `credited_invoice_id` equal to the original's
 * target UUID, so a non-credit invoice (a draft, or a normal sent invoice) can never match.
 * The route copies neither `revenue_account`, `article_id` nor `line_type` onto credit items, so
 * those are not compared against the original (article and line type must be the defaults).
 */
export function matchesCreditNoteExpected(
  value: unknown,
  creditTargetId: string,
  originalTargetId: string,
  expected: InvoiceDraftExpected,
  originalInvoiceNumber: string,
  invoiceNumber: string = `KR-${originalInvoiceNumber}`,
): boolean {
  const invoice = data(value);
  if (!invoice || invoice.id !== creditTargetId || !uuid(creditTargetId)) return false;
  if (!uuid(originalTargetId) || originalTargetId === creditTargetId) return false;
  if (
    !uuid(invoice.credited_invoice_id) ||
    invoice.credited_invoice_id.toLowerCase() !== originalTargetId.toLowerCase()
  ) {
    return false;
  }
  const negated = (amount: number): number => (amount === 0 ? 0 : -Math.abs(amount));
  if (
    invoice.status !== 'sent' ||
    invoice.invoice_number !== invoiceNumber ||
    invoice.document_type !== 'invoice' ||
    invoice.currency !== 'SEK' ||
    invoice.customer_id !== expected.customer_id ||
    invoice.notes !== `Krediterar faktura ${originalInvoiceNumber}` ||
    typeof invoice.invoice_date !== 'string' ||
    !ISO_DATE.test(invoice.invoice_date) ||
    invoice.subtotal !== negated(expected.subtotal) ||
    invoice.vat_amount !== negated(expected.vat_amount) ||
    invoice.total !== negated(expected.total) ||
    invoice.subtotal_sek !== negated(expected.subtotal) ||
    invoice.vat_amount_sek !== negated(expected.vat_amount) ||
    invoice.total_sek !== negated(expected.total) ||
    invoice.vat_treatment !== 'standard_25' ||
    invoice.vat_rate !== 25 ||
    (invoice.paid_amount !== null && invoice.paid_amount !== 0) ||
    invoice.deduction_total !== 0 ||
    !emptyDimensions(invoice.default_dimensions)
  ) {
    return false;
  }
  // The route dates the credit note and its due date today, and carries the original's text
  // fields over verbatim; an unrequested text field must be empty on the target.
  if (invoice.due_date !== invoice.invoice_date) return false;
  for (const key of [
    'our_reference',
    'your_reference',
    'invoice_marking',
    'delivery_date',
  ] as const) {
    const wanted = (expected as unknown as Record<string, unknown>)[key];
    const stored = invoice[key];
    if (Object.hasOwn(expected, key)) {
      if (stored !== wanted) return false;
    } else if (stored !== undefined && stored !== null && stored !== '') {
      return false;
    }
  }
  // A reported journal entry contradicts the unbooked cash-method credit this adapter supports.
  if (Object.hasOwn(invoice, 'journal_entry_id') && invoice.journal_entry_id !== null) return false;
  if (
    !plain(invoice.customer) ||
    invoice.customer.id !== expected.customer_id ||
    invoice.customer.customer_type !== 'swedish_business' ||
    invoice.customer.country !== 'SE' ||
    invoice.customer.archived_at !== null
  ) {
    return false;
  }
  const mirrored: unknown = expected.mirrored_customer;
  if (!plain(mirrored) || Object.keys(mirrored).length === 0) return false;
  for (const [key, wanted] of Object.entries(mirrored)) {
    if (typeof wanted !== 'string') return false;
    const stored = invoice.customer[key];
    if ((stored === undefined || stored === null ? '' : stored) !== wanted) return false;
  }
  const wantedItems = expected.items;
  if (
    !Array.isArray(wantedItems) ||
    wantedItems.length === 0 ||
    !Array.isArray(invoice.items) ||
    invoice.items.length !== wantedItems.length
  ) {
    return false;
  }
  const ordered = new Map<number, Record<string, unknown>>();
  for (const item of invoice.items) {
    if (!plain(item)) return false;
    const position =
      wantedItems.length > 1 || Object.hasOwn(item, 'sort_order') ? item.sort_order : 0;
    if (
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= wantedItems.length ||
      ordered.has(position)
    ) {
      return false;
    }
    ordered.set(position, item);
  }
  return wantedItems.every((wanted, index) => {
    const row = ordered.get(index);
    if (!row || 'line_type' in wanted) return false;
    return (
      row.description === wanted.description &&
      row.unit === wanted.unit &&
      row.unit_price === wanted.unit_price &&
      row.vat_rate === wanted.vat_rate &&
      row.quantity === negated(wanted.quantity) &&
      row.line_total === negated(wanted.line_total) &&
      row.vat_amount === negated(wanted.vat_amount) &&
      (row.discount_percent === 0 || row.discount_percent === null) &&
      (row.line_type === undefined || row.line_type === 'product') &&
      (row.article_id === undefined || row.article_id === null) &&
      (row.deduction_type === undefined || row.deduction_type === null) &&
      (row.deduction_amount === undefined || row.deduction_amount === 0) &&
      emptyDimensions(row.dimensions ?? null)
    );
  });
}

function receiptBase(
  record: ShadowRecord,
  plan: InvoiceCreditPlan,
): Omit<CreditReceiptBase, 'complete'> {
  return {
    version: 1,
    kind: 'invoice-credit',
    creditIntentId: record.id,
    creditRequestHash: record.requestHash,
    issueIntentId: plan.issueIntentId,
    creatorIntentId: plan.creatorIntentId,
    sourceCompany: record.sourceCompany,
    targetCompany: record.targetCompany,
    originalSourceInvoiceId: plan.originalSourceInvoiceId,
    originalTargetId: plan.originalTargetId,
    originalInvoiceNumber: plan.originalInvoiceNumber,
    creditSourceInvoiceId: plan.creditSourceInvoiceId,
    expected: plan.expected,
  };
}

function pendingReceipt(
  record: ShadowRecord,
  plan: InvoiceCreditPlan,
  status?: number,
  response?: unknown,
): PendingInvoiceCreditReceipt {
  return { ...receiptBase(record, plan), complete: false, mutation: { status, response } };
}

/** Warning-free, journal-explicit-null, 201, whole-original response for this exact plan. */
function responseComplete(
  response: Record<string, unknown> | undefined,
  plan: InvoiceCreditPlan,
): response is Record<string, unknown> & { id: string; invoice_number: string } {
  return (
    !!response &&
    uuid(response.id) &&
    response.id !== plan.originalTargetId &&
    nonempty(response.invoice_number) &&
    response.invoice_number === `KR-${plan.originalInvoiceNumber}` &&
    uuid(response.credited_invoice_id) &&
    response.credited_invoice_id.toLowerCase() === plan.originalTargetId.toLowerCase() &&
    response.status === 'sent' &&
    response.total === (plan.expected.total === 0 ? 0 : -Math.abs(plan.expected.total)) &&
    // The original was issued under the cash method with no booking signal, so the route books
    // no reversal. Journaling is best-effort on the route: any entry or warning is unverifiable.
    Object.hasOwn(response, 'journal_entry_id') &&
    response.journal_entry_id === null &&
    (!Object.hasOwn(response, 'warnings') ||
      (Array.isArray(response.warnings) && response.warnings.length === 0))
  );
}

/**
 * Synthetic-only credit-note step for an already mirrored and issued original. It maps the
 * Fortnox `creditInvoice` operation onto `POST .../invoices/:id/credit` (full credit only).
 * It has no client, credentials, CLI registration, or live dispatch wiring.
 */
export class AccountedInvoiceCreditAdapter implements ShadowAdapter {
  private readonly binding: Readonly<ShadowBinding>;
  private readonly path: string;
  private readonly issue: AccountedInvoiceIssueAdapter;

  constructor(
    binding: ShadowBinding,
    private readonly lookup: IdentityLookup,
    private readonly readIntent: ReadIntent,
    private readonly snapshot: Snapshot,
    private readonly request: AccountedRequestCallback,
  ) {
    if (
      !binding ||
      typeof binding.sourceCompany !== 'string' ||
      !binding.sourceCompany.trim() ||
      typeof binding.targetCompany !== 'string' ||
      !UUID.test(binding.targetCompany)
    ) {
      throw new Error('Invalid invoice credit company binding');
    }
    this.binding = Object.freeze({ ...binding });
    this.path = `/api/v1/companies/${encodeURIComponent(binding.targetCompany)}/invoices`;
    this.issue = new AccountedInvoiceIssueAdapter(binding, lookup, readIntent, request);
  }

  prepare(record: ShadowRecord): { request: InvoiceCreditPlan } | { blocked: string } {
    if (
      !record ||
      record.sourceCompany !== this.binding.sourceCompany ||
      record.targetCompany !== this.binding.targetCompany
    ) {
      return { blocked: 'Invoice credit company binding does not match the adapter.' };
    }
    if (record.operation !== 'creditInvoice') {
      return {
        blocked: `${CREDIT_REFUSAL.operation}: Only creditInvoice is supported by the credit adapter.`,
      };
    }
    if (!Array.isArray(record.args) || record.args.length !== 1 || !nonempty(record.args[0])) {
      return {
        blocked: `${CREDIT_REFUSAL.arguments}: creditInvoice requires exactly one document number argument.`,
      };
    }
    const originalSourceInvoiceId = documentId(record.args[0]);
    if (!originalSourceInvoiceId || record.args[0] !== originalSourceInvoiceId) {
      return {
        blocked: `${CREDIT_REFUSAL.arguments}: The credited document number must be an exact positive string.`,
      };
    }
    if (!nonempty(record.id) || !nonempty(record.requestHash)) {
      return {
        blocked: `${CREDIT_REFUSAL.arguments}: Invoice credit requires durable intent identity and request hash.`,
      };
    }
    const source = record.sourceResult;
    if (!plain(source)) {
      return { blocked: `${CREDIT_REFUSAL.sourceDrift}: Credit source invoice is malformed.` };
    }
    if (source.Credit !== true && source.Credit !== 'true') {
      return {
        blocked: `${CREDIT_REFUSAL.notCredit}: The source result is not a credit invoice (Credit must be true).`,
      };
    }
    if (documentId(source.CreditInvoiceReference) !== originalSourceInvoiceId) {
      return {
        blocked: `${CREDIT_REFUSAL.referenceMismatch}: CreditInvoiceReference must equal the credited document number.`,
      };
    }
    const creditSourceInvoiceId = documentId(source.DocumentNumber);
    if (!creditSourceInvoiceId || creditSourceInvoiceId === originalSourceInvoiceId) {
      return {
        blocked: `${CREDIT_REFUSAL.numbers}: The credit note needs its own positive DocumentNumber.`,
      };
    }

    const identity = this.lookup('invoice', originalSourceInvoiceId);
    if (
      !plain(identity) ||
      identity.state !== 'ready' ||
      identity.resource !== 'invoice' ||
      identity.sourceId !== originalSourceInvoiceId ||
      !uuid(identity.targetId)
    ) {
      return {
        blocked: `${CREDIT_REFUSAL.originalNotMirrored}: The credited original has no applied invoice identity.`,
      };
    }

    const entries = this.snapshot();
    const issues = entries.filter(
      ({ record: other }) =>
        other.operation === 'markInvoicePrinted' &&
        other.state === 'applied' &&
        Array.isArray(other.args) &&
        other.args[0] === originalSourceInvoiceId,
    );
    if (issues.length !== 1) {
      return {
        blocked: `${CREDIT_REFUSAL.originalNotIssued}: Exactly one applied issue receipt for the original is required (found ${issues.length}).`,
      };
    }
    const issueRecord = issues[0]!.record;
    const receipt = issueRecord.targetReceipt;
    if (
      issueRecord.targetId !== identity.targetId ||
      !plain(receipt) ||
      receipt.version !== 1 ||
      receipt.kind !== 'invoice-issue' ||
      receipt.complete !== true ||
      receipt.targetId !== identity.targetId ||
      !plain(receipt.mutation) ||
      receipt.mutation.status !== 200 ||
      !plain(receipt.mutation.response) ||
      receipt.mutation.response.status !== 'sent' ||
      receipt.mutation.response.id !== identity.targetId ||
      !nonempty(receipt.mutation.response.invoice_number)
    ) {
      return {
        blocked: `${CREDIT_REFUSAL.originalNotIssued}: The issue receipt is incomplete or does not match the original.`,
      };
    }
    const issuePlan = this.issue.prepare(issueRecord);
    if (!('request' in issuePlan) || issuePlan.request.targetId !== identity.targetId) {
      return {
        blocked: `${CREDIT_REFUSAL.originalNotIssued}: The issue receipt no longer matches its strict mapping.`,
      };
    }
    if (issuePlan.request.expected.items.some((item) => 'line_type' in item)) {
      return {
        blocked: `${CREDIT_REFUSAL.textRow}: Text rows are not carried onto the credit note by the credit route.`,
      };
    }
    const duplicate = entries.some(
      ({ record: other }) =>
        other.id !== record.id &&
        other.operation === 'creditInvoice' &&
        other.state === 'applied' &&
        Array.isArray(other.args) &&
        other.args[0] === originalSourceInvoiceId,
    );
    if (duplicate) {
      return {
        blocked: `${CREDIT_REFUSAL.duplicate}: The original already has an applied credit.`,
      };
    }

    const creator = this.readIntent(issuePlan.request.creatorIntentId);
    if (!creator || !plain(creator.sourceResult)) {
      return {
        blocked: `${CREDIT_REFUSAL.originalNotMirrored}: The applied creator intent cannot be read.`,
      };
    }
    const refusal = compareCreditSource(creator.sourceResult, source);
    if (refusal) {
      return {
        blocked: `${refusal}: The credit source is not exactly the full negation of the mirrored original.`,
      };
    }
    return {
      request: {
        originalTargetId: identity.targetId,
        originalSourceInvoiceId,
        originalInvoiceNumber: receipt.mutation.response.invoice_number as string,
        creditSourceInvoiceId,
        issueIntentId: issueRecord.id,
        issueRequestHash: issueRecord.requestHash,
        creatorIntentId: issuePlan.request.creatorIntentId,
        creatorRequestHash: issuePlan.request.creatorRequestHash,
        expected: issuePlan.request.expected,
      },
    };
  }

  private async originalIsIssued(plan: InvoiceCreditPlan): Promise<boolean> {
    // The issue adapter's verify is GET-only: the original must still be the exact sent invoice.
    const issueRecord = this.snapshot().find(
      ({ record }) => record.id === plan.issueIntentId,
    )?.record;
    return !!issueRecord && (await this.issue.verify(issueRecord));
  }

  private async originalIsCredited(plan: InvoiceCreditPlan): Promise<boolean> {
    const response = await this.request({
      method: 'GET',
      path: `${this.path}/${encodeURIComponent(plan.originalTargetId)}?expand=items`,
    });
    const original = data(response.json);
    return (
      response.status === 200 &&
      !!original &&
      original.id === plan.originalTargetId &&
      original.status === 'credited'
    );
  }

  private async creditReadback(plan: InvoiceCreditPlan, creditTargetId: string): Promise<boolean> {
    const response = await this.request({
      method: 'GET',
      path: `${this.path}/${encodeURIComponent(creditTargetId)}?expand=items`,
    });
    return (
      response.status === 200 &&
      matchesCreditNoteExpected(
        response.json,
        creditTargetId,
        plan.originalTargetId,
        plan.expected,
        plan.originalInvoiceNumber,
      ) &&
      (await this.originalIsCredited(plan))
    );
  }

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: InvoiceCreditReceipt }> {
    const prepared = this.prepare(record);
    if (!('request' in prepared) || !isDeepStrictEqual(prepared.request, request)) {
      throw new Error('Invoice credit request does not match its prepared mapping.');
    }
    const plan = prepared.request;
    if (!(await this.originalIsIssued(plan))) {
      throw new Error('Credited original is not the exact issued (sent) invoice.');
    }
    const rechecked = this.prepare(record);
    if (!('request' in rechecked) || !isDeepStrictEqual(rechecked.request, plan)) {
      throw new Error('Invoice credit mapping changed after target original verification.');
    }

    const idempotencyKey = `shadow_credit_${createHash('sha256')
      .update(
        JSON.stringify([
          this.binding.sourceCompany,
          this.binding.targetCompany,
          record.id,
          record.requestHash,
          plan.originalTargetId,
        ]),
      )
      .digest('hex')}`;
    let response: { status: number; json: unknown };
    try {
      response = await this.request({
        method: 'POST',
        path: `${this.path}/${encodeURIComponent(plan.originalTargetId)}/credit`,
        idempotencyKey,
      });
    } catch (cause) {
      // No credit note id is known: do not persist a target identity. The deterministic
      // idempotency key makes a later reconciliation replay safe.
      throw new Error('Invoice credit outcome is unknown: the request did not return a response', {
        cause,
      });
    }
    const created = data(response.json);
    const pendingId = created && uuid(created.id) ? created.id : undefined;
    if (response.status !== 201 || !responseComplete(created, plan)) {
      const incomplete = pendingReceipt(record, plan, response.status, response.json);
      const cause = new Error('Invoice credit response is incomplete or contradictory');
      if (pendingId && pendingId !== plan.originalTargetId) {
        throw new TargetReceiptPendingError(pendingId, incomplete, { cause });
      }
      throw new Error('Invoice credit outcome is unknown: response carries no credit note id', {
        cause,
      });
    }
    const receipt: InvoiceCreditReceipt = {
      ...receiptBase(record, plan),
      complete: true,
      data: { id: created.id },
      mutation: { status: 201, response: created },
    };
    try {
      if (!(await this.creditReadback(plan, created.id))) {
        throw new Error('Credit note readback differs from the confirmed full credit.');
      }
    } catch (cause) {
      throw new TargetReceiptPendingError(created.id, receipt, { cause });
    }
    return { targetId: created.id, receipt };
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    const prepared = this.prepare(record);
    if (!('request' in prepared)) return false;
    const plan = prepared.request;
    const receipt = record.targetReceipt;
    if (
      !plain(receipt) ||
      receipt.version !== 1 ||
      receipt.kind !== 'invoice-credit' ||
      receipt.complete !== true ||
      receipt.creditIntentId !== record.id ||
      receipt.creditRequestHash !== record.requestHash ||
      receipt.issueIntentId !== plan.issueIntentId ||
      receipt.creatorIntentId !== plan.creatorIntentId ||
      receipt.sourceCompany !== this.binding.sourceCompany ||
      receipt.targetCompany !== this.binding.targetCompany ||
      receipt.originalSourceInvoiceId !== plan.originalSourceInvoiceId ||
      receipt.originalTargetId !== plan.originalTargetId ||
      receipt.originalInvoiceNumber !== plan.originalInvoiceNumber ||
      receipt.creditSourceInvoiceId !== plan.creditSourceInvoiceId ||
      !isDeepStrictEqual(receipt.expected, plan.expected) ||
      !plain(receipt.data) ||
      !uuid(receipt.data.id) ||
      record.targetId !== receipt.data.id ||
      !plain(receipt.mutation) ||
      receipt.mutation.status !== 201 ||
      !plain(receipt.mutation.response) ||
      receipt.mutation.response.id !== receipt.data.id ||
      !responseComplete(receipt.mutation.response, plan)
    ) {
      return false;
    }
    return this.creditReadback(plan, receipt.data.id);
  }
}
