import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { AccountedInvoiceDraftAdapter } from '../../src/shadow/invoice-draft-adapter.js';
import { TargetReceiptPendingError } from '../../src/shadow/types.js';
import type { ShadowRecord } from '../../src/shadow/types.js';
import type { ShadowIdentityResolution } from '../../src/shadow/identity.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
function record(): ShadowRecord {
  const row = {
    Description: 'Synthetic service',
    DeliveredQuantity: 1,
    Price: 100,
    VAT: 25,
    Unit: 'st',
  };
  const input = {
    CustomerNumber: '7',
    InvoiceDate: '2026-01-01',
    DueDate: '2026-01-31',
    Currency: 'SEK',
    InvoiceRows: [row],
  };
  return {
    version: 1,
    id: 'invoice-intent',
    operation: 'createInvoice',
    args: [input],
    ...binding,
    requestHash: 'synthetic-request-hash',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: {
      ...input,
      DocumentNumber: '10',
      AccountingMethod: 'CASH',
      InvoiceType: 'INVOICE',
      Country: 'Sverige',
      Booked: false,
      Sent: false,
      Cancelled: false,
      Credit: 'false',
      VATIncluded: false,
      CurrencyRate: 1,
      CurrencyUnit: 1,
      AdministrationFee: 0,
      AdministrationFeeVAT: 0,
      Freight: 0,
      FreightVAT: 0,
      RoundOff: 0,
      TaxReduction: 0,
      HouseWork: false,
      Net: 100,
      TotalVAT: 25,
      Total: 125,
      TotalToPay: 125,
      Balance: 125,
      InvoiceRows: [
        {
          ...row,
          DeliveredQuantity: '1',
          PriceExcludingVAT: 100,
          TotalExcludingVAT: 100,
          Total: 100,
          Discount: 0,
          HouseWork: false,
          AccountNumber: 3001,
        },
      ],
    },
  };
}
function lookup(): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: 'customer',
    sourceId: '7',
    targetId: customerId,
    intentId: 'customer-intent',
    requestHash: 'customer-hash',
    ...binding,
  };
}
function nativeInvoice() {
  return {
    id: invoiceId,
    customer_id: customerId,
    invoice_date: '2026-01-01',
    due_date: '2026-01-31',
    currency: 'SEK',
    document_type: 'invoice',
    payment_link_auto: false,
    ore_rounding: false,
    status: 'draft',
    invoice_number: null,
    subtotal: 100,
    vat_amount: 25,
    total: 125,
    remaining_amount: 125,
    subtotal_sek: 100,
    vat_amount_sek: 25,
    total_sek: 125,
    vat_treatment: 'standard',
    vat_rate: 25,
    paid_amount: 0,
    credited_invoice_id: null,
    deduction_total: 0,
    default_dimensions: {},
    customer: {
      id: customerId,
      customer_type: 'swedish_business',
      country: 'SE',
      archived_at: null,
    },
    items: [
      {
        description: 'Synthetic service',
        quantity: 1,
        unit: 'st',
        unit_price: 100,
        vat_rate: 25,
        revenue_account: '3001',
        line_total: 100,
        vat_amount: 25,
        discount_percent: 0,
        line_type: 'product',
        article_id: null,
        deduction_type: null,
        deduction_amount: 0,
        dimensions: {},
      },
    ],
  };
}
function setup(readback: unknown = nativeInvoice()) {
  const request = vi.fn(async (input: AccountedRequest) =>
    input.method === 'POST'
      ? { status: 201, json: { data: { id: invoiceId } } }
      : { status: 200, json: { data: readback } },
  );
  const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
  return { request, adapter };
}
function prepared(adapter: AccountedInvoiceDraftAdapter, source: ShadowRecord) {
  const result = adapter.prepare(source);
  if ('blocked' in result) throw new Error(result.blocked);
  return result.request;
}

describe('unarmed native-contract invoice draft adapter with synthetic transport', () => {
  it('reconciles a durable known invoice receipt after queue reopen with no second POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-adapter-'));
    let queue = await openShadowQueue(root, binding);
    try {
      await queue.execute({ id: 'customer', operation: 'createCustomer', args: [] }, async () => ({
        CustomerNumber: '7',
      }));
      await queue.drainOne({
        prepare: () => ({ request: {} }),
        apply: async () => ({ targetId: customerId, receipt: { data: { id: customerId } } }),
      });
      const source = record();
      const sourceCall = vi.fn(async () => source.sourceResult);
      await queue.execute(source, sourceCall);
      let readable = false;
      const request = vi.fn(async (input: AccountedRequest) =>
        input.method === 'POST'
          ? { status: 201, json: { data: { id: invoiceId } } }
          : readable
            ? { status: 200, json: { data: nativeInvoice() } }
            : { status: 503, json: {} },
      );
      const first = new AccountedInvoiceDraftAdapter(
        binding,
        (kind, id) => queue.resolveIdentity(kind, id),
        request,
      );
      expect(await queue.drainOne(first)).toBe(false);
      expect(queue.get(source.id)).toMatchObject({ state: 'target_unknown', targetId: invoiceId });
      queue.close();
      queue = await openShadowQueue(root, binding);
      const resumed = new AccountedInvoiceDraftAdapter(
        binding,
        (kind, id) => queue.resolveIdentity(kind, id),
        request,
      );
      expect(queue.resolveIdentity('invoice', '10').state).toBe('unresolved');
      expect(await queue.drainOne(resumed)).toBe(false);
      readable = true;
      expect(await queue.reconcileTarget(source.id, resumed)).toBe(true);
      expect(queue.resolveIdentity('invoice', '10')).toMatchObject({
        state: 'ready',
        targetId: invoiceId,
      });
      await queue.execute(source, sourceCall);
      expect(sourceCall).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [500, {}, /HTTP 500/],
    [201, { data: { id: 'invalid' } }, /no valid target identity/],
  ])(
    'leaves a create response without established UUID unresolved (%s)',
    async (status, json, message) => {
      const request = vi.fn(async () => ({ status: status as number, json }));
      const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
      const source = record();
      await expect(adapter.apply(source, prepared(adapter, source))).rejects.toThrow(
        message as RegExp,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('creates once, expands items, verifies exact totals and preserves known UUID receipts', async () => {
    const { adapter, request } = setup();
    const source = record();
    const result = await adapter.apply(source, prepared(adapter, source));
    expect(result.targetId).toBe(invoiceId);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/companies/${binding.targetCompany}/invoices`,
      body: { payment_link_auto: false, ore_rounding: false, document_type: 'invoice' },
    });
    expect(request.mock.calls[0]![0].idempotencyKey).toMatch(/^shadow_[a-f0-9]{64}$/);
    expect(request.mock.calls[1]![0]).toEqual({
      method: 'GET',
      path: `/api/v1/companies/${binding.targetCompany}/invoices/${invoiceId}?expand=items`,
    });
    expect(
      await adapter.verify({ ...source, targetId: result.targetId, targetReceipt: result.receipt }),
    ).toBe(true);
    expect(request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['missing items', { ...nativeInvoice(), items: undefined }],
    [
      'extra item',
      { ...nativeInvoice(), items: [...nativeInvoice().items, ...nativeInvoice().items] },
    ],
    ['wrong total', { ...nativeInvoice(), total: 124 }],
    ['wrong target UUID', { ...nativeInvoice(), id: customerId }],
    ['partially paid', { ...nativeInvoice(), paid_amount: 1 }],
    ['credit relation', { ...nativeInvoice(), credited_invoice_id: customerId }],
    ['converted total differs', { ...nativeInvoice(), total_sek: 124 }],
    ['exempt VAT treatment', { ...nativeInvoice(), vat_treatment: 'exempt' }],
    [
      'archived customer',
      {
        ...nativeInvoice(),
        customer: { ...nativeInvoice().customer, archived_at: '2026-01-01T00:00:00Z' },
      },
    ],
    [
      'unexpected article link',
      { ...nativeInvoice(), items: [{ ...nativeInvoice().items[0], article_id: customerId }] },
    ],
    ['already issued', { ...nativeInvoice(), status: 'sent' }],
    ['allocated number', { ...nativeInvoice(), invoice_number: 'F1' }],
    [
      'foreign customer',
      { ...nativeInvoice(), customer: { ...nativeInvoice().customer, country: 'NO' } },
    ],
    ['customer mismatch', { ...nativeInvoice(), customer_id: invoiceId }],
    [
      'line amount',
      { ...nativeInvoice(), items: [{ ...nativeInvoice().items[0], line_total: 99 }] },
    ],
    ['line VAT', { ...nativeInvoice(), items: [{ ...nativeInvoice().items[0], vat_rate: 12 }] }],
    ['dimensions', { ...nativeInvoice(), default_dimensions: { project: 'unexpected' } }],
    ['payment links enabled', { ...nativeInvoice(), payment_link_auto: true }],
    ['rounding enabled', { ...nativeInvoice(), ore_rounding: true }],
    [
      'wrong account',
      { ...nativeInvoice(), items: [{ ...nativeInvoice().items[0], revenue_account: '3002' }] },
    ],
    ['deduction', { ...nativeInvoice(), deduction_total: 1 }],
  ])('retains known create identity after %s readback failure', async (_name, readback) => {
    const { adapter, request } = setup(readback);
    const source = record();
    await expect(adapter.apply(source, prepared(adapter, source))).rejects.toMatchObject({
      name: 'TargetReceiptPendingError',
      targetId: invoiceId,
    });
    expect(request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
  });

  it('does not create again after readback recovers', async () => {
    let available = false;
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'POST') return { status: 201, json: { data: { id: invoiceId } } };
      if (!available) throw new Error('synthetic read outage');
      return { status: 200, json: { data: nativeInvoice() } };
    });
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
    const source = record();
    let receipt: TargetReceiptPendingError | undefined;
    try {
      await adapter.apply(source, prepared(adapter, source));
    } catch (error) {
      if (!(error instanceof TargetReceiptPendingError)) throw error;
      receipt = error;
    }
    expect(receipt).toBeDefined();
    available = true;
    expect(
      await adapter.verify({
        ...source,
        targetId: receipt!.targetId,
        targetReceipt: receipt!.receipt,
      }),
    ).toBe(true);
    expect(request.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1);
  });

  it('rejects altered prepared plans and unsupported operations before any target call', async () => {
    const { adapter, request } = setup();
    await expect(adapter.apply(record(), { body: {} })).rejects.toThrow(/prepared|mapping/i);
    expect(adapter.prepare({ ...record(), operation: 'bookkeepInvoice' })).toHaveProperty(
      'blocked',
    );
    expect(adapter.prepare({ ...record(), targetCompany: invoiceId })).toHaveProperty('blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses altered identity or expected receipt before readback', async () => {
    const { adapter, request } = setup();
    const source = record();
    const result = await adapter.apply(source, prepared(adapter, source));
    request.mockClear();
    expect(
      await adapter.verify({ ...source, targetId: customerId, targetReceipt: result.receipt }),
    ).toBe(false);
    expect(
      await adapter.verify({
        ...source,
        targetId: result.targetId,
        targetReceipt: { data: { id: invoiceId }, expected: {} },
      }),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
