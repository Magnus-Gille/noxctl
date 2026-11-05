import { describe, expect, it, vi } from 'vitest';
import { mapInvoiceDraft, UNIT_REFUSAL } from '../../src/shadow/invoice-draft-mapping.js';
import {
  AccountedInvoiceDraftAdapter,
  matchesInvoiceExpected,
} from '../../src/shadow/invoice-draft-adapter.js';
import { AccountedInvoiceIssueAdapter } from '../../src/shadow/invoice-issue-adapter.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const itemIds = [
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
  '66666666-6666-4666-8666-666666666663',
];

function creator(units: unknown[]): ShadowRecord {
  const net = units.length * 100;
  const rows = (full: boolean) =>
    units.map((unit, index) => ({
      Description: `Row ${index}`,
      DeliveredQuantity: full ? '1' : 1,
      Price: 100,
      VAT: 25,
      Unit: unit,
      ...(full
        ? {
            PriceExcludingVAT: 100,
            TotalExcludingVAT: 100,
            Total: 100,
            Discount: 0,
            HouseWork: false,
            CostCenter: '',
            Project: '',
            ArticleNumber: '',
            AccountNumber: 3001,
          }
        : {}),
    }));
  return {
    version: 1,
    id: 'invoice-intent',
    operation: 'createInvoice',
    args: [
      {
        CustomerNumber: '7',
        InvoiceDate: '2026-01-01',
        DueDate: '2026-01-31',
        Currency: 'SEK',
        InvoiceRows: rows(false),
      },
    ],
    ...binding,
    requestHash: 'creator-request-hash',
    state: 'applied',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: {
      CustomerNumber: '7',
      InvoiceDate: '2026-01-01',
      DueDate: '2026-01-31',
      Currency: 'SEK',
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
      Net: net,
      TotalVAT: net / 4,
      Total: net * 1.25,
      TotalToPay: net * 1.25,
      Balance: net * 1.25,
      InvoiceRows: rows(true),
    },
  } as ShadowRecord;
}

function lookup(kind: ShadowResourceKind, id: string): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: kind,
    sourceId: id,
    targetId: kind === 'customer' ? customerId : invoiceId,
    intentId: `${kind}-intent`,
    requestHash: kind === 'invoice' ? 'creator-request-hash' : 'customer-hash',
    ...binding,
  } as ShadowIdentityResolution;
}

function mappedOk(units: unknown[]) {
  const result = mapInvoiceDraft(creator(units), binding, lookup);
  if ('blocked' in result) throw new Error(result.blocked);
  return result;
}

function targetInvoice(expected: ReturnType<typeof mappedOk>['expected'], units: unknown[]) {
  return {
    ...expected,
    id: invoiceId,
    subtotal_sek: expected.subtotal,
    vat_amount_sek: expected.vat_amount,
    total_sek: expected.total,
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
    items: expected.items.map((item, index) => ({
      ...item,
      unit: units[index],
      id: itemIds[index],
      sort_order: index,
      line_type: 'product',
      article_id: null,
      deduction_type: null,
      deduction_amount: 0,
      dimensions: {},
    })),
  };
}

describe('empty invoice-row units: mapping', () => {
  it('emits unit "" for an empty source unit in request and expected', () => {
    const result = mappedOk(['']);
    expect(result.request.items[0]!.unit).toBe('');
    expect(result.expected.items[0]!.unit).toBe('');
  });

  it('keeps positions for mixed empty and nonempty units', () => {
    const result = mappedOk(['st', '', 'tim']);
    expect(result.request.items.map((item) => item.unit)).toEqual(['st', '', 'tim']);
    expect(result.request.items.map((item) => item.description)).toEqual([
      'Row 0',
      'Row 1',
      'Row 2',
    ]);
    expect(result.expected.items.map((item) => item.unit)).toEqual(['st', '', 'tim']);
  });

  it('binds "" and "st" to different expected and request content', () => {
    expect(JSON.stringify(mappedOk(['']).expected)).not.toEqual(
      JSON.stringify(mappedOk(['st']).expected),
    );
    expect(JSON.stringify(mappedOk(['']).request)).not.toEqual(
      JSON.stringify(mappedOk(['st']).request),
    );
  });

  it.each([
    ['whitespace-only', ' '],
    ['tab only', '\t'],
    ['leading space', ' st'],
    ['trailing space', 'st '],
    ['control character', 's\nt'],
    ['NUL', 's\u0000t'],
    ['null', null],
    ['absent', undefined],
    ['number', 1],
    ['object', {}],
  ])('refuses a %s unit with a stable reason and no request', (_name, unit) => {
    const result = mapInvoiceDraft(creator([unit]), binding, lookup);
    expect(result).toMatchObject({ blocked: expect.stringContaining(UNIT_REFUSAL.invalid) });
    expect('request' in result).toBe(false);
  });

  it('refuses a confirmed source row whose unit differs from the input', () => {
    const record = creator(['']);
    (record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> }).InvoiceRows[0]!.Unit =
      'st';
    expect(mapInvoiceDraft(record, binding, lookup)).toHaveProperty('blocked');
  });
});

describe('empty invoice-row units: readback', () => {
  const units = ['st', '', 'tim'];

  it('accepts exact "" and rejects "st", null, undefined, and whitespace for it', () => {
    const { expected } = mappedOk(units);
    expect(
      matchesInvoiceExpected({ data: targetInvoice(expected, units) }, invoiceId, expected),
    ).toBe(true);
    for (const wrong of ['st', null, undefined, ' ']) {
      expect(
        matchesInvoiceExpected(
          { data: targetInvoice(expected, ['st', wrong, 'tim']) },
          invoiceId,
          expected,
        ),
      ).toBe(false);
    }
  });

  it('rejects "" returned for a nonempty expected unit', () => {
    const { expected } = mappedOk(units);
    expect(
      matchesInvoiceExpected(
        { data: targetInvoice(expected, ['', '', 'tim']) },
        invoiceId,
        expected,
      ),
    ).toBe(false);
  });

  it('draft adapter applies and verifies, and keeps the target id pending without replay on a "st" readback', async () => {
    const plan = mappedOk(units);
    const good = vi.fn(async (input: AccountedRequest) =>
      input.method === 'POST'
        ? { status: 201, json: { data: { id: invoiceId } } }
        : { status: 200, json: { data: targetInvoice(plan.expected, units) } },
    );
    const record = creator(units);
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, good);
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await adapter.apply(record, prepared.request);
    expect(
      (good.mock.calls[0]![0] as { body: { items: Array<{ unit: string }> } }).body.items.map(
        (item) => item.unit,
      ),
    ).toEqual(['st', '', 'tim']);

    for (const wrong of ['st', null]) {
      const bad = vi.fn(async (input: AccountedRequest) =>
        input.method === 'POST'
          ? { status: 201, json: { data: { id: invoiceId } } }
          : {
              status: 200,
              json: { data: targetInvoice(plan.expected, ['st', wrong, 'tim']) },
            },
      );
      const badAdapter = new AccountedInvoiceDraftAdapter(binding, lookup, bad);
      await expect(badAdapter.apply(record, prepared.request)).rejects.toMatchObject({
        targetId: invoiceId,
      });
      expect(bad.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    }
  });

  it('draft verify fails when a saved receipt carries "st" for an empty-unit row', async () => {
    const plan = mappedOk(units);
    const request = vi.fn(async () => ({
      status: 200,
      json: { data: targetInvoice(plan.expected, units) },
    }));
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
    const record = {
      ...creator(units),
      targetId: invoiceId,
      targetReceipt: { data: { id: invoiceId }, expected: plan.expected, sourceInvoiceId: '10' },
    };
    expect(await adapter.verify(record)).toBe(true);
    const tampered = {
      ...record,
      targetReceipt: {
        ...record.targetReceipt,
        expected: {
          ...plan.expected,
          items: plan.expected.items.map((item, index) =>
            index === 1 ? { ...item, unit: 'st' } : item,
          ),
        },
      },
    };
    expect(await adapter.verify(tampered)).toBe(false);
  });
});

describe('empty invoice-row units: issue adapter binding', () => {
  const units = ['', 'st'];
  function issueRecord(): ShadowRecord {
    const base = creator(units);
    return {
      ...base,
      id: 'issue-intent',
      operation: 'markInvoicePrinted',
      args: ['10'],
      requestHash: 'issue-request-hash',
      state: 'pending',
      createdAt: 2,
      updatedAt: 2,
      sourceResult: {
        invoice: { ...(base.sourceResult as object), Sent: true },
        confirmed: true,
        pdf: Buffer.from('%PDF-synthetic'),
      },
    };
  }
  function adapterFor(expected: unknown) {
    const intent: ShadowRecord = {
      ...creator(units),
      targetId: invoiceId,
      targetReceipt: { data: { id: invoiceId }, expected, sourceInvoiceId: '10' },
    };
    return new AccountedInvoiceIssueAdapter(
      binding,
      lookup,
      (id) => (id === 'invoice-intent' ? intent : undefined),
      vi.fn(),
    );
  }

  it('prepares when the creator receipt binds "" and blocks when it was bound to "st"', () => {
    const plan = mappedOk(units);
    expect(adapterFor(plan.expected).prepare(issueRecord())).toHaveProperty('request');
    const swapped = {
      ...plan.expected,
      items: plan.expected.items.map((item, index) =>
        index === 0 ? { ...item, unit: 'st' } : item,
      ),
    };
    expect(adapterFor(swapped).prepare(issueRecord())).toHaveProperty('blocked');
  });
});
