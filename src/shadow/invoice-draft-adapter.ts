import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mapInvoiceDraft } from './invoice-draft-mapping.js';
import type { InvoiceDraftBody, InvoiceDraftExpected } from './invoice-draft-mapping.js';
import type { AccountedRequestCallback } from './accounted-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from './identity.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord } from './types.js';
import { TargetReceiptPendingError } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type IdentityLookup = (resource: ShadowResourceKind, sourceId: string) => ShadowIdentityResolution;
type DraftPlan = {
  body: InvoiceDraftBody;
  expected: InvoiceDraftExpected;
  sourceInvoiceId: string;
};

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function data(value: unknown): Record<string, unknown> | undefined {
  return plain(value) && plain(value.data) ? value.data : undefined;
}
function emptyDimensions(value: unknown): boolean {
  return value === null || (plain(value) && Object.keys(value).length === 0);
}
export function matchesInvoiceExpected(
  value: unknown,
  targetId: string,
  expected: InvoiceDraftExpected,
  state: { status: 'draft' | 'sent'; invoiceNumber?: string | null } = {
    status: 'draft',
    invoiceNumber: null,
  },
): boolean {
  const invoice = data(value);
  if (!invoice || invoice.id !== targetId) return false;
  for (const [key, wanted] of Object.entries(expected)) {
    if (key !== 'items' && key !== 'status' && key !== 'invoice_number' && invoice[key] !== wanted)
      return false;
  }
  // Optional text fields are verified exactly; when not requested the target must hold none.
  for (const key of ['our_reference', 'your_reference', 'notes', 'invoice_marking'] as const) {
    if (!Object.hasOwn(expected, key)) {
      const stored = invoice[key];
      if (stored !== undefined && stored !== null && stored !== '') return false;
    }
  }
  if (invoice.status !== state.status || invoice.invoice_number !== (state.invoiceNumber ?? null))
    return false;
  if (
    invoice.subtotal_sek !== expected.subtotal ||
    invoice.vat_amount_sek !== expected.vat_amount ||
    invoice.total_sek !== expected.total ||
    invoice.vat_treatment !== 'standard' ||
    invoice.vat_rate !== 25 ||
    invoice.paid_amount !== 0 ||
    invoice.credited_invoice_id !== null ||
    invoice.deduction_total !== 0 ||
    !emptyDimensions(invoice.default_dimensions)
  )
    return false;
  if (
    !plain(invoice.customer) ||
    invoice.customer.id !== expected.customer_id ||
    invoice.customer.customer_type !== 'swedish_business' ||
    invoice.customer.country !== 'SE' ||
    invoice.customer.archived_at !== null
  )
    return false;
  if (
    !Array.isArray(expected.items) ||
    expected.items.length === 0 ||
    !Array.isArray(invoice.items) ||
    invoice.items.length !== expected.items.length
  )
    return false;
  const ordered = new Map<number, Record<string, unknown>>();
  const ids = new Set<string>();
  for (const item of invoice.items) {
    if (!plain(item)) return false;
    const multiple = expected.items.length > 1;
    const position = multiple || Object.hasOwn(item, 'sort_order') ? item.sort_order : 0;
    if (
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= expected.items.length ||
      ordered.has(position)
    )
      return false;
    if (multiple || Object.hasOwn(item, 'id')) {
      if (typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id.toLowerCase()))
        return false;
      ids.add(item.id.toLowerCase());
    }
    ordered.set(position, item);
  }
  return expected.items.every((wanted, index) => {
    const row = ordered.get(index);
    return (
      !!row &&
      Object.entries(wanted).every(([key, value]) => row[key] === value) &&
      row.line_type === ('line_type' in wanted ? wanted.line_type : 'product') &&
      row.article_id === (('article_id' in wanted ? wanted.article_id : undefined) ?? null) &&
      (!('line_type' in wanted) || wanted.line_type !== 'text' || textRowStoredAsZeros(row)) &&
      row.deduction_type === null &&
      row.deduction_amount === 0 &&
      emptyDimensions(row.dimensions)
    );
  });
}

/** Text rows are stored by the target as zeros with no VAT, account, article or discount. */
function textRowStoredAsZeros(row: Record<string, unknown>): boolean {
  return (
    row.article_id === null &&
    row.vat_rate === 0 &&
    row.line_total === 0 &&
    row.vat_amount === 0 &&
    row.quantity === 0 &&
    row.unit === '' &&
    row.unit_price === 0 &&
    (row.discount_percent === 0 || row.discount_percent === null) &&
    (row.revenue_account === null || row.revenue_account === undefined)
  );
}

export function matchesDraft(
  value: unknown,
  targetId: string,
  expected: InvoiceDraftExpected,
): boolean {
  return matchesInvoiceExpected(value, targetId, expected);
}

/**
 * Explicit host-owned, unarmed draft-only adapter. No CLI wiring or HTTP client.
 * Native invoice.created subscribers must be assessed separately before live use.
 */
export class AccountedInvoiceDraftAdapter implements ShadowAdapter {
  private readonly binding: Readonly<ShadowBinding>;
  private readonly path: string;

  constructor(
    binding: ShadowBinding,
    private readonly lookup: IdentityLookup,
    private readonly request: AccountedRequestCallback,
  ) {
    if (
      !binding ||
      typeof binding.sourceCompany !== 'string' ||
      !binding.sourceCompany.trim() ||
      typeof binding.targetCompany !== 'string' ||
      !UUID.test(binding.targetCompany)
    ) {
      throw new Error('Invalid invoice draft company binding');
    }
    this.binding = Object.freeze({ ...binding });
    this.path = `/api/v1/companies/${encodeURIComponent(binding.targetCompany)}/invoices`;
  }

  prepare(record: ShadowRecord): { request: DraftPlan } | { blocked: string } {
    const mapped = mapInvoiceDraft(record, this.binding, this.lookup);
    if ('blocked' in mapped) return mapped;
    return {
      request: {
        body: mapped.request,
        expected: mapped.expected,
        sourceInvoiceId: mapped.sourceInvoiceId,
      },
    };
  }

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: unknown }> {
    const prepared = this.prepare(record);
    if (!('request' in prepared) || !isDeepStrictEqual(prepared.request, request)) {
      throw new Error('Invoice draft request does not match its prepared mapping');
    }
    if (
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      typeof record.requestHash !== 'string' ||
      !record.requestHash.trim()
    ) {
      throw new Error('Invoice draft requires durable intent identity');
    }
    const plan = prepared.request;
    const idempotencyKey = `shadow_${createHash('sha256')
      .update(
        JSON.stringify([
          this.binding.sourceCompany,
          this.binding.targetCompany,
          record.id,
          record.requestHash,
        ]),
      )
      .digest('hex')}`;
    const created = await this.request({
      method: 'POST',
      path: this.path,
      body: plan.body,
      idempotencyKey,
    });
    if (created.status !== 201)
      throw new Error(`Invoice draft create returned HTTP ${created.status}`);
    const createdData = data(created.json);
    if (!createdData || typeof createdData.id !== 'string' || !UUID.test(createdData.id)) {
      throw new Error('Invoice draft create has no valid target identity');
    }
    const targetId = createdData.id;
    const receipt = {
      data: createdData,
      expected: plan.expected,
      sourceInvoiceId: plan.sourceInvoiceId,
    };
    // A native create can return only its header after refetch failure. Retain the
    // UUID before expanded GET; failed readback must never cause another create.
    try {
      const readback = await this.request({
        method: 'GET',
        path: `${this.path}/${encodeURIComponent(targetId)}?expand=items`,
      });
      if (readback.status !== 200 || !matchesDraft(readback.json, targetId, plan.expected)) {
        throw new Error(
          'Invoice draft expanded readback differs from the confirmed source mapping',
        );
      }
    } catch (cause) {
      throw new TargetReceiptPendingError(targetId, receipt, { cause });
    }
    return { targetId, receipt };
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    const prepared = this.prepare(record);
    if (
      !('request' in prepared) ||
      typeof record.targetId !== 'string' ||
      !UUID.test(record.targetId) ||
      !plain(record.targetReceipt) ||
      !plain(record.targetReceipt.data) ||
      record.targetReceipt.data.id !== record.targetId ||
      record.targetReceipt.sourceInvoiceId !== prepared.request.sourceInvoiceId ||
      !isDeepStrictEqual(record.targetReceipt.expected, prepared.request.expected)
    )
      return false;
    const readback = await this.request({
      method: 'GET',
      path: `${this.path}/${encodeURIComponent(record.targetId)}?expand=items`,
    });
    return (
      readback.status === 200 &&
      matchesDraft(readback.json, record.targetId, prepared.request.expected)
    );
  }
}
