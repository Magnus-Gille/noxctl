import { describe, expect, it, vi } from 'vitest';
import { mapInvoiceDraft, ROW_REFUSAL } from '../../src/shadow/invoice-draft-mapping.js';
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

type RowSpec = 'product' | 'text' | Record<string, unknown>;

/** 'text' rows are purely descriptive; 'product' rows are priced 100 SEK x 1 at 25 percent. */
function creator(specs: RowSpec[]): ShadowRecord {
  const products = specs.filter((spec) => spec === 'product').length;
  const net = products * 100;
  const inputRow = (spec: RowSpec, index: number) => {
    if (spec === 'text') return { Description: `Note ${index}` };
    if (spec === 'product') {
      return { Description: `Row ${index}`, DeliveredQuantity: 1, Price: 100, VAT: 25, Unit: 'st' };
    }
    return { Description: `Row ${index}`, ...spec };
  };
  const sourceRow = (spec: RowSpec, index: number) => {
    const common = {
      Discount: 0,
      HouseWork: false,
      CostCenter: '',
      Project: '',
      ArticleNumber: '',
    };
    if (spec === 'text') {
      return {
        ...common,
        Description: `Note ${index}`,
        DeliveredQuantity: '0',
        Price: 0,
        PriceExcludingVAT: 0,
        TotalExcludingVAT: 0,
        Total: 0,
        VAT: 0,
        Unit: '',
        AccountNumber: 0,
      };
    }
    return {
      ...common,
      Description: `Row ${index}`,
      DeliveredQuantity: '1',
      Price: 100,
      PriceExcludingVAT: 100,
      TotalExcludingVAT: 100,
      Total: 100,
      VAT: 25,
      Unit: 'st',
      AccountNumber: 3001,
    };
  };
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
        InvoiceRows: specs.map(inputRow),
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
      InvoiceRows: specs.map(sourceRow),
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
    sourceCustomer: {
      Name: '',
      OrganisationNumber: '',
      Phone1: '',
      Phone2: '',
      Address1: '',
      Address2: '',
      ZipCode: '',
      City: '',
    },
  } as ShadowIdentityResolution;
}

function mappedOk(specs: RowSpec[]) {
  const result = mapInvoiceDraft(creator(specs), binding, lookup);
  if ('blocked' in result) throw new Error(result.blocked);
  return result;
}

type Row = Record<string, unknown>;

/** Target readback as the pinned server returns it: text rows are stored as zeros. */
function targetInvoice(
  expected: ReturnType<typeof mappedOk>['expected'],
  tweak?: (rows: Row[]) => void,
) {
  const items: Row[] = expected.items.map((item, index) => ({
    ...item,
    id: itemIds[index] ?? `66666666-6666-4666-8666-66666666666${index + 4}`,
    sort_order: index,
    line_type: 'line_type' in item ? 'text' : 'product',
    article_id: null,
    ...('line_type' in item ? { vat_rate: 0, discount_percent: 0, revenue_account: null } : {}),
    deduction_type: null,
    deduction_amount: 0,
    dimensions: {},
  }));
  tweak?.(items);
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
    items,
  };
}

const specs: RowSpec[] = ['text', 'product', 'text', 'product'];

describe('text invoice rows: mapping', () => {
  it('maps a descriptive row to a target text row at the same position', () => {
    const result = mappedOk(specs);
    expect(result.request.items[0]).toEqual({
      line_type: 'text',
      description: 'Note 0',
      quantity: 0,
      unit: '',
      unit_price: 0,
    });
    expect(result.request.items.map((item) => item.description)).toEqual([
      'Note 0',
      'Row 1',
      'Note 2',
      'Row 3',
    ]);
    expect(result.request.items[1]).toMatchObject({ unit: 'st', revenue_account: '3001' });
    expect(result.expected.items[0]).toEqual({
      line_type: 'text',
      description: 'Note 0',
      quantity: 0,
      unit: '',
      unit_price: 0,
      line_total: 0,
      vat_amount: 0,
    });
  });

  it('excludes text rows from totals on both sides', () => {
    const result = mappedOk(specs);
    expect(result.expected).toMatchObject({ subtotal: 200, vat_amount: 50, total: 250 });
  });

  it.each([[''], ['   ']])('refuses a blank text description %j like the product path', (blank) => {
    const empty = creator(['text', 'product']);
    (empty.args[0] as { InvoiceRows: Row[] }).InvoiceRows[0]!.Description = blank;
    (empty.sourceResult as { InvoiceRows: Row[] }).InvoiceRows[0]!.Description = blank;
    expect(mapInvoiceDraft(empty, binding, lookup)).toMatchObject({
      blocked: expect.stringContaining(ROW_REFUSAL.textRowInvalid),
    });
  });

  it('refuses an overlong text description', () => {
    const long = creator(['text', 'product']);
    (long.args[0] as { InvoiceRows: Row[] }).InvoiceRows[0]!.Description = 'x'.repeat(2001);
    expect(mapInvoiceDraft(long, binding, lookup)).toMatchObject({
      blocked: expect.stringContaining(ROW_REFUSAL.textRowInvalid),
    });
  });

  it('refuses an invoice made only of text rows', () => {
    expect(mapInvoiceDraft(creator(['text']), binding, lookup)).toMatchObject({
      blocked: expect.stringContaining(ROW_REFUSAL.noProductRow),
    });
  });

  it.each([
    ['zero-quantity priced row', { DeliveredQuantity: 0, Price: 100, VAT: 25, Unit: 'st' }],
    [
      'negative quantity, positive price',
      { DeliveredQuantity: -1, Price: 100, VAT: 25, Unit: 'st' },
    ],
    [
      'negative quantity, negative price',
      { DeliveredQuantity: -1, Price: -100, VAT: 25, Unit: 'st' },
    ],
    ['zero quantity, zero price, VAT 25', { DeliveredQuantity: 0, Price: 0, VAT: 25, Unit: 'st' }],
  ])('refuses a %s with ROW_NONPOSITIVE_QUANTITY and no request', (_name, row) => {
    const result = mapInvoiceDraft(creator(['product', row]), binding, lookup);
    expect(result).toMatchObject({
      blocked: expect.stringContaining(ROW_REFUSAL.nonpositiveQuantity),
    });
    expect('request' in result).toBe(false);
  });

  it('never converts a negative quantity into a negative price', () => {
    const result = mapInvoiceDraft(
      creator([{ DeliveredQuantity: -1, Price: 100, VAT: 25, Unit: 'st' }, 'product']),
      binding,
      lookup,
    );
    expect('request' in result).toBe(false);
  });

  it.each([
    ['article number', { ArticleNumber: 'A1' }],
    ['account number', { AccountNumber: '3001' }],
    ['unit', { Unit: 'st' }],
  ])('does not treat a row with a %s as text', (_name, extra) => {
    const result = mapInvoiceDraft(
      creator(['product', { DeliveredQuantity: 0, Price: 0, VAT: 0, ...extra }]),
      binding,
      lookup,
    );
    expect('request' in result).toBe(false);
  });

  it.each([
    ['nonzero price', 'Price', 5],
    ['nonzero VAT', 'VAT', 25],
    ['nonzero quantity', 'DeliveredQuantity', '1'],
    ['nonempty unit', 'Unit', 'st'],
    ['nonzero total', 'Total', 5],
    ['discount', 'Discount', 10],
    ['article', 'ArticleNumber', 'A1'],
    ['house work', 'HouseWork', true],
  ])('refuses a confirmed source text row with %s', (_name, field, value) => {
    const record = creator(['text', 'product']);
    (record.sourceResult as { InvoiceRows: Row[] }).InvoiceRows[0]![field as string] = value;
    expect(mapInvoiceDraft(record, binding, lookup)).toMatchObject({
      blocked: expect.stringContaining(ROW_REFUSAL.textRowInvalid),
    });
  });

  it('refuses a source whose row text differs from the input', () => {
    const record = creator(['text', 'product']);
    (record.sourceResult as { InvoiceRows: Row[] }).InvoiceRows[0]!.Description = 'Other';
    expect(mapInvoiceDraft(record, binding, lookup)).toHaveProperty('blocked');
  });

  it('keeps an input text row bound to the source position', () => {
    const record = creator(['text', 'product']);
    const rows = (record.sourceResult as { InvoiceRows: Row[] }).InvoiceRows;
    rows.reverse();
    expect(mapInvoiceDraft(record, binding, lookup)).toHaveProperty('blocked');
  });
});

describe('text invoice rows: readback', () => {
  it('accepts exact text-row readback and rejects drifted values', () => {
    const { expected } = mappedOk(specs);
    expect(matchesInvoiceExpected({ data: targetInvoice(expected) }, invoiceId, expected)).toBe(
      true,
    );
    const drifts: Array<[string, (rows: Row[]) => void]> = [
      ['stored as product', (rows) => (rows[0]!.line_type = 'product')],
      ['missing line_type', (rows) => delete rows[0]!.line_type],
      ['quantity 1', (rows) => (rows[0]!.quantity = 1)],
      ['unit st', (rows) => (rows[0]!.unit = 'st')],
      ['unit null', (rows) => (rows[0]!.unit = null)],
      ['price 1', (rows) => (rows[0]!.unit_price = 1)],
      ['total 1', (rows) => (rows[0]!.line_total = 1)],
      ['vat 1', (rows) => (rows[0]!.vat_amount = 1)],
      ['description', (rows) => (rows[0]!.description = 'Other')],
      ['article linked', (rows) => (rows[0]!.article_id = invoiceId)],
      ['vat_rate 25', (rows) => (rows[0]!.vat_rate = 25)],
      ['vat_rate missing', (rows) => delete rows[0]!.vat_rate],
      ['discount 10', (rows) => (rows[0]!.discount_percent = 10)],
      ['revenue account', (rows) => (rows[0]!.revenue_account = '3001')],
      ['product returned as text', (rows) => (rows[1]!.line_type = 'text')],
      [
        'swapped order',
        (rows) => {
          rows[0]!.sort_order = 1;
          rows[1]!.sort_order = 0;
        },
      ],
    ];
    for (const [name, tweak] of drifts) {
      expect(
        matchesInvoiceExpected({ data: targetInvoice(expected, tweak) }, invoiceId, expected),
        name,
      ).toBe(false);
    }
  });

  it('rejects invoice totals that include a text row', () => {
    const { expected } = mappedOk(specs);
    const target = { ...targetInvoice(expected), total_sek: expected.total + 1 };
    expect(matchesInvoiceExpected({ data: target }, invoiceId, expected)).toBe(false);
  });

  it('draft adapter sends the text row contract and fails closed on a drifted readback', async () => {
    const plan = mappedOk(specs);
    const record = creator(specs);
    const good = vi.fn(async (input: AccountedRequest) =>
      input.method === 'POST'
        ? { status: 201, json: { data: { id: invoiceId } } }
        : { status: 200, json: { data: targetInvoice(plan.expected) } },
    );
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, good);
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await adapter.apply(record, prepared.request);
    const sent = (good.mock.calls[0]![0] as { body: { items: Row[] } }).body.items;
    expect(sent[0]).toEqual({
      line_type: 'text',
      description: 'Note 0',
      quantity: 0,
      unit: '',
      unit_price: 0,
    });

    const bad = vi.fn(async (input: AccountedRequest) =>
      input.method === 'POST'
        ? { status: 201, json: { data: { id: invoiceId } } }
        : {
            status: 200,
            json: {
              data: targetInvoice(plan.expected, (rows) => (rows[0]!.line_type = 'product')),
            },
          },
    );
    const badAdapter = new AccountedInvoiceDraftAdapter(binding, lookup, bad);
    await expect(badAdapter.apply(record, prepared.request)).rejects.toMatchObject({
      targetId: invoiceId,
    });
    expect(bad.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  });

  it('draft verify fails when a saved receipt turns a text row into a product row', async () => {
    const plan = mappedOk(specs);
    const request = vi.fn(async () => ({
      status: 200,
      json: { data: targetInvoice(plan.expected) },
    }));
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
    const record = {
      ...creator(specs),
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
            index === 0 ? { ...item, line_type: 'product' } : item,
          ),
        },
      },
    };
    expect(await adapter.verify(tampered)).toBe(false);
  });
});

describe('text invoice rows: issue adapter binding', () => {
  function issueRecord(): ShadowRecord {
    const base = creator(specs);
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
      ...creator(specs),
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

  it('prepares when the creator receipt binds the text rows and blocks when one is swapped for a product', () => {
    const plan = mappedOk(specs);
    expect(adapterFor(plan.expected).prepare(issueRecord())).toHaveProperty('request');
    const swapped = {
      ...plan.expected,
      items: plan.expected.items.map((item, index) =>
        index === 0 ? { ...item, line_type: 'product' } : item,
      ),
    };
    expect(adapterFor(swapped).prepare(issueRecord())).toHaveProperty('blocked');
  });
});
