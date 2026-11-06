import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import { matchesInvoiceExpected } from '../../src/shadow/invoice-draft-adapter.js';
import { mapBookedInvoicePayment } from '../../src/shadow/payment-source-mapping.js';
import { canonicalEncode } from '../../src/shadow/queue.js';
import type { InvoiceDraftExpected } from '../../src/shadow/invoice-draft-mapping.js';
import type { CapturedPaymentVoucher } from '../../src/shadow/payment-source-mapping.js';
import type { ShadowBinding, ShadowPaymentGroup, ShadowRecord } from '../../src/shadow/types.js';

const binding: ShadowBinding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const targetInvoiceId = '22222222-2222-4222-8222-222222222222';
const itemIds = ['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662'];

type RowSpec = {
  description: string;
  quantity: number;
  price: number;
  unit: string;
  account: number;
  inputExtra?: Record<string, unknown>;
  sourceExtra?: Record<string, unknown>;
  sourceVatCents?: number;
};

const twoRows: RowSpec[] = [
  { description: 'First service', quantity: 1, price: 100, unit: 'st', account: 3001 },
  { description: 'Second service', quantity: 1, price: 200, unit: 'tim', account: 3002 },
];

function cents(value: number): number {
  return Math.round(value * 100);
}

function draftRecord(
  specs: RowSpec[] = twoRows,
  overrides: { sourceHeader?: Record<string, unknown> } = {},
): ShadowRecord {
  const calculated = specs.map((spec) => {
    const netCents = cents(spec.price) * spec.quantity;
    const vatCents = spec.sourceVatCents ?? Math.round(netCents / 4);
    return { spec, netCents, vatCents };
  });
  const netCents = calculated.reduce((sum, row) => sum + row.netCents, 0);
  const vatCents = calculated.reduce((sum, row) => sum + row.vatCents, 0);
  const totalCents = netCents + vatCents;
  const args = [
    {
      CustomerNumber: '7',
      InvoiceDate: '2026-01-01',
      DueDate: '2026-01-31',
      Currency: 'SEK',
      InvoiceRows: specs.map((spec) => ({
        Description: spec.description,
        DeliveredQuantity: spec.quantity,
        Price: spec.price,
        VAT: 25,
        Unit: spec.unit,
        AccountNumber: String(spec.account),
        ...spec.inputExtra,
      })),
    },
  ];
  const sourceRows = calculated.map(({ spec, netCents: rowNet }) => ({
    Description: spec.description,
    DeliveredQuantity: String(spec.quantity),
    Price: spec.price,
    PriceExcludingVAT: spec.price,
    TotalExcludingVAT: rowNet / 100,
    Total: rowNet / 100,
    Discount: 0,
    VAT: 25,
    Unit: spec.unit,
    HouseWork: false,
    CostCenter: '',
    Project: '',
    ArticleNumber: '',
    AccountNumber: spec.account,
    ...spec.sourceExtra,
  }));
  const sourceResult = {
    CustomerNumber: '7',
    InvoiceDate: '2026-01-01',
    DueDate: '2026-01-31',
    Currency: 'SEK',
    DocumentNumber: '42',
    AccountingMethod: 'CASH',
    InvoiceType: 'INVOICE',
    Country: 'Sverige',
    Booked: false,
    Sent: false,
    Cancelled: false,
    Credit: false,
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
    Net: netCents / 100,
    TotalVAT: vatCents / 100,
    Total: totalCents / 100,
    TotalToPay: totalCents / 100,
    Balance: totalCents / 100,
    InvoiceRows: sourceRows,
    ...overrides.sourceHeader,
  };
  return {
    version: 1,
    id: 'invoice-create',
    operation: 'createInvoice',
    args,
    ...binding,
    requestHash: 'synthetic-draft-hash',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sourceResult,
  };
}

function mappedDraft(specs: RowSpec[] = twoRows, overrides?: Parameters<typeof draftRecord>[1]) {
  const result = mapInvoiceDraft(draftRecord(specs, overrides), binding, (resource, sourceId) => ({
    state: 'ready',
    resource,
    sourceId,
    targetId: customerId,
    intentId: 'customer-create',
    requestHash: 'synthetic-customer-hash',
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
  }));
  if ('blocked' in result)
    throw new Error(`Expected synthetic draft mapping, got: ${result.blocked}`);
  return result;
}

function targetInvoice(expected: InvoiceDraftExpected) {
  const items = expected.items
    .map((item, sort_order) => ({
      ...item,
      id: itemIds[sort_order]!,
      sort_order,
      line_type: 'product',
      article_id: null,
      deduction_type: null,
      deduction_amount: 0,
      dimensions: {},
    }))
    .reverse();
  return {
    ...expected,
    id: targetInvoiceId,
    status: 'sent',
    invoice_number: 'A-42',
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

function paymentGroup(amount: number, invoiceNo = 42): ShadowPaymentGroup {
  const payment = {
    Number: 17,
    InvoiceNumber: invoiceNo,
    Booked: true,
    Amount: amount,
    AmountCurrency: amount,
    Currency: 'SEK',
    CurrencyRate: 1,
    CurrencyUnit: 1,
    InvoiceTotal: amount,
    WriteOffs: [],
    ModeOfPaymentAccount: 1930,
    PaymentDate: '2026-01-15',
    VoucherYear: 2,
    VoucherSeries: 'A',
    VoucherNumber: 7,
  };
  const operations = [
    {
      id: 'payment-create',
      operation: 'createInvoicePayment',
      args: [{ InvoiceNumber: invoiceNo }],
      sourceResult: { ...payment, Booked: false },
    },
    {
      id: 'payment-bookkeep',
      operation: 'bookkeepInvoicePayment',
      args: [17],
      sourceResult: payment,
    },
  ];
  const members = operations.map((operation, index) => {
    const requestHash = createHash('sha256')
      .update(
        canonicalEncode({
          version: 1,
          ...binding,
          operation: operation.operation,
          args: operation.args,
        }),
      )
      .digest('hex');
    return {
      sequence: index + 1,
      record: {
        version: 1 as const,
        id: operation.id,
        operation: operation.operation,
        args: operation.args,
        ...binding,
        requestHash,
        state: 'applied' as const,
        createdAt: index + 1,
        updatedAt: index + 1,
        sourceResult: operation.sourceResult,
      },
    };
  });
  return {
    id: 'synthetic-booked-payment-group',
    sourcePaymentId: '17',
    sourceInvoiceId: String(invoiceNo),
    members,
    sourceResult: payment,
  };
}

function voucherRow(Account: number, Debit: number, Credit: number): Record<string, unknown> {
  return {
    Account,
    Debit,
    Credit,
    Removed: false,
    CostCenter: '',
    Project: '',
    Quantity: 0,
    Description: 'Synthetic row',
    TransactionInformation: '',
  };
}

function voucherCapture(rows: Record<string, unknown>[]): CapturedPaymentVoucher {
  return {
    sourceCompany: binding.sourceCompany,
    financialYearId: '2',
    data: {
      Year: 2,
      VoucherSeries: 'A',
      VoucherNumber: 7,
      ReferenceType: 'INVOICEPAYMENT',
      ReferenceNumber: 42,
      TransactionDate: '2026-01-15',
      CostCenter: '',
      Project: '',
      VoucherRows: rows,
    },
  };
}

function mapPayment(specs: RowSpec[], rows: Record<string, unknown>[]) {
  const draft = mappedDraft(specs);
  return mapBookedInvoicePayment(
    paymentGroup(draft.expected.total),
    binding,
    voucherCapture(rows),
    draft.expected,
  );
}

function requirePayment(specs: RowSpec[], rows: Record<string, unknown>[]) {
  const result = mapPayment(specs, rows);
  if ('blocked' in result)
    throw new Error(`Expected synthetic voucher mapping, got: ${result.blocked}`);
  return result.request;
}

const targetMutations: Array<{
  name: string;
  mutate: (items: Record<string, unknown>[]) => void;
}> = [
  {
    name: 'missing sort_order',
    mutate: (items) => {
      delete items[0]!.sort_order;
    },
  },
  {
    name: 'duplicate sort_order',
    mutate: (items) => {
      items[1]!.sort_order = items[0]!.sort_order;
    },
  },
  {
    name: 'crossed sort_order',
    mutate: (items) => {
      items[0]!.sort_order = 0;
      items[1]!.sort_order = 1;
    },
  },
  {
    name: 'missing item ID',
    mutate: (items) => {
      delete items[0]!.id;
    },
  },
  {
    name: 'duplicate item ID',
    mutate: (items) => {
      items[1]!.id = items[0]!.id;
    },
  },
  {
    name: 'second item drift',
    mutate: (items) => {
      items[0]!.unit_price = 201;
    },
  },
];

const draftMutations: Array<{
  name: string;
  mutate: (record: ShadowRecord, specs: RowSpec[]) => void;
}> = [
  {
    name: 'second source row reordered',
    mutate: (record) => {
      (record.sourceResult as { InvoiceRows: unknown[] }).InvoiceRows.reverse();
    },
  },
  {
    name: 'second source row amount drift',
    mutate: (record) => {
      (
        record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> }
      ).InvoiceRows[1]!.Total = 199;
    },
  },
  {
    name: 'second unit empty',
    mutate: (_record, specs) => {
      specs[1]!.unit = '';
    },
  },
  {
    name: 'second quantity nonpositive',
    mutate: (_record, specs) => {
      specs[1]!.quantity = 0;
    },
  },
  {
    name: 'second row has discount',
    mutate: (_record, specs) => {
      specs[1]!.sourceExtra = { Discount: 1 };
    },
  },
  {
    name: 'second row has dimension',
    mutate: (_record, specs) => {
      specs[1]!.sourceExtra = { Project: 'P1' };
    },
  },
  {
    name: 'second input row has unsupported discount field',
    mutate: (_record, specs) => {
      specs[1]!.inputExtra = { Discount: 0 };
    },
  },
];

const sameAccountVoucherRows: Array<{ name: string; rows: Record<string, unknown>[] }> = [
  {
    name: 'coalesced same-account credit',
    rows: [voucherRow(1930, 375, 0), voucherRow(3001, 0, 300), voucherRow(2611, 0, 75)],
  },
  {
    name: 'split same-account credit',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(3001, 0, 200),
      voucherRow(2611, 0, 75),
    ],
  },
];

const invalidVoucherRows: Array<{ name: string; rows: Record<string, unknown>[] }> = [
  {
    name: 'wrong bank amount',
    rows: [
      voucherRow(1930, 374, 0),
      ...[voucherRow(3001, 0, 100), voucherRow(3002, 0, 200), voucherRow(2611, 0, 75)],
    ],
  },
  {
    name: 'extra credit line',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 75),
      voucherRow(3999, 0, 1),
    ],
  },
  {
    name: 'opposing sides',
    rows: [
      voucherRow(1930, 375, 1),
      voucherRow(3001, 0, 100),
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 75),
    ],
  },
  {
    name: 'unknown account',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(9999, 0, 200),
      voucherRow(2611, 0, 75),
    ],
  },
  {
    name: 'credit sum mismatch',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(3002, 0, 199),
      voucherRow(2611, 0, 75),
    ],
  },
  {
    name: 'duplicate bank row',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 75),
      voucherRow(1930, 1, 0),
    ],
  },
  {
    name: 'zero-valued extra row',
    rows: [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 75),
      voucherRow(3999, 0, 0),
    ],
  },
];

describe('ordered multi-item invoice draft mapping', () => {
  it('maps two rows in source order with exact units and summed per-row totals', () => {
    const mapped = mappedDraft();
    expect(mapped.sourceInvoiceId).toBe('42');
    expect(mapped.request.items).toEqual([
      {
        description: 'First service',
        quantity: 1,
        unit: 'st',
        unit_price: 100,
        vat_rate: 25,
        revenue_account: '3001',
      },
      {
        description: 'Second service',
        quantity: 1,
        unit: 'tim',
        unit_price: 200,
        vat_rate: 25,
        revenue_account: '3002',
      },
    ]);
    expect(mapped.expected.items.map((item) => [item.line_total, item.vat_amount])).toEqual([
      [100, 25],
      [200, 50],
    ]);
    expect(mapped.expected).toMatchObject({
      subtotal: 300,
      vat_amount: 75,
      total: 375,
      remaining_amount: 375,
    });
  });

  it('matches a reversed readback array by unique sort_order and valid distinct UUIDs', () => {
    const expected = mappedDraft().expected;
    const target = targetInvoice(expected);
    expect(
      matchesInvoiceExpected({ data: target }, targetInvoiceId, expected, {
        status: 'sent',
        invoiceNumber: 'A-42',
      }),
    ).toBe(true);
  });

  it.each(targetMutations)('rejects $name in target item readback', ({ mutate }) => {
    const expected = mappedDraft().expected;
    const target = targetInvoice(expected);
    mutate(target.items as unknown as Record<string, unknown>[]);
    expect(
      matchesInvoiceExpected({ data: target }, targetInvoiceId, expected, {
        status: 'sent',
        invoiceNumber: 'A-42',
      }),
    ).toBe(false);
  });

  it.each(draftMutations)(
    'refuses $name before any target mapping can be produced',
    ({ mutate }) => {
      const specs = structuredClone(twoRows);
      const record = draftRecord(specs);
      mutate(record, specs);
      const args = record.args[0] as { InvoiceRows: Array<Record<string, unknown>> };
      args.InvoiceRows = args.InvoiceRows.map((row, index) => ({
        ...row,
        ...(specs[index]
          ? {
              Description: specs[index]!.description,
              DeliveredQuantity: specs[index]!.quantity,
              Price: specs[index]!.price,
              Unit: specs[index]!.unit,
              AccountNumber: String(specs[index]!.account),
              ...specs[index]!.inputExtra,
            }
          : {}),
      }));
      const sourceRows = (record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> })
        .InvoiceRows;
      specs.forEach((spec, index) => Object.assign(sourceRows[index]!, spec.sourceExtra ?? {}));
      const result = mapInvoiceDraft(record, binding, (resource, sourceId) => ({
        state: 'ready',
        resource,
        sourceId,
        targetId: customerId,
        intentId: 'customer-create',
        requestHash: 'synthetic-customer-hash',
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
      }));
      expect(result).toHaveProperty('blocked');
    },
  );

  it('sums per-row VAT cents instead of rounding the aggregate VAT once', () => {
    const tiny: RowSpec[] = [
      { description: 'Tiny one', quantity: 1, price: 0.02, unit: 'st', account: 3001 },
      { description: 'Tiny two', quantity: 1, price: 0.02, unit: 'tim', account: 3002 },
    ];
    const mapped = mappedDraft(tiny);
    expect(mapped.expected.vat_amount).toBe(0.02);
    expect(Math.round(((mapped.expected.subtotal * 25) / 100) * 100) / 100).toBe(0.01);
    expect(mapped.expected.total).toBe(0.06);
  });

  it('refuses source cents that disagree with the pinned target floating-point VAT calculation', () => {
    const drift: RowSpec[] = [
      {
        description: 'Float edge',
        quantity: 1,
        price: 0.58,
        unit: 'st',
        account: 3001,
        sourceVatCents: 15,
      },
    ];
    const record = draftRecord(drift);
    const result = mapInvoiceDraft(record, binding, (resource, sourceId) => ({
      state: 'ready',
      resource,
      sourceId,
      targetId: customerId,
      intentId: 'customer-create',
      requestHash: 'synthetic-customer-hash',
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
    }));
    expect(Math.round(((0.58 * 25) / 100) * 100) / 100).toBe(0.14);
    expect(result).toHaveProperty('blocked');
  });
});

describe('complete multi-row payment voucher preservation', () => {
  const fullRows = [
    voucherRow(1930, 375, 0),
    voucherRow(3001, 0, 100),
    voucherRow(3002, 0, 200),
    voucherRow(2611, 0, 75),
  ];

  it('preserves all captured bank, revenue, and VAT lines in the original order', () => {
    const request = requirePayment(twoRows, fullRows);
    expect(request.amount).toBe(375);
    expect(request.lines).toEqual([
      { account_number: '1930', debit_amount: 375, credit_amount: 0, dimensions: {} },
      { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
      { account_number: '3002', debit_amount: 0, credit_amount: 200, dimensions: {} },
      { account_number: '2611', debit_amount: 0, credit_amount: 75, dimensions: {} },
    ]);
    expect(request.sourceVoucher).toMatchObject({ year: '2', series: 'A', number: '7' });
    expect(request.sourceVoucher.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(sameAccountVoucherRows)(
    'accepts and preserves $name without merging captured lines',
    ({ rows }) => {
      const repeated: RowSpec[] = [
        { description: 'First service', quantity: 1, price: 100, unit: 'st', account: 3001 },
        { description: 'Second service', quantity: 1, price: 200, unit: 'tim', account: 3001 },
      ];
      const request = requirePayment(repeated, rows);
      expect(request.lines).toHaveLength(rows.length);
      expect(request.lines).toEqual(
        rows.map((row) => ({
          account_number: String(row.Account).padStart(4, '0'),
          debit_amount: row.Debit,
          credit_amount: row.Credit,
          dimensions: {},
        })),
      );
    },
  );

  it.each(invalidVoucherRows)('blocks voucher with $name', ({ rows }) => {
    expect(mapPayment(twoRows, rows)).toHaveProperty('blocked');
  });
});

describe('additional multi-item financial boundaries', () => {
  it('refuses source global VAT rounding when the target uses per-item rounding', () => {
    const rows = twoRows.map((row) => ({ ...row, price: 0.02 }));
    expect(() =>
      mappedDraft(rows, {
        sourceHeader: { TotalVAT: 0.01, Total: 0.05, TotalToPay: 0.05, Balance: 0.05 },
      }),
    ).toThrow(/source TotalVAT/);
  });

  it('refuses target aggregate floating-point drift before producing a target plan', () => {
    const rows = twoRows.map((row, index) => ({ ...row, price: index === 0 ? 0.1 : 0.2 }));
    expect(() => mappedDraft(rows)).toThrow(/Target aggregate arithmetic/);
  });

  it('refuses an unsafe whole-invoice cent sum even when every row is individually within bounds', () => {
    const rows = Array.from({ length: 8000 }, () => ({
      ...twoRows[0]!,
      quantity: 10000,
      price: 1000000,
    }));
    expect(() => mappedDraft(rows)).toThrow(/safe integer-cent/);
  });

  it('preserves split VAT credits and complete source line order', () => {
    const rows = [
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 25),
      voucherRow(1930, 375, 0),
      voucherRow(3001, 0, 100),
      voucherRow(2611, 0, 50),
    ];
    const mapped = requirePayment(twoRows, rows);
    expect(mapped.lines).toEqual(
      rows.map((row) => ({
        account_number: String(row.Account),
        debit_amount: row.Debit,
        credit_amount: row.Credit,
        dimensions: {},
      })),
    );
  });

  it('rejects balancing debit-credit netting on a revenue account', () => {
    const rows = [
      voucherRow(1930, 375, 0),
      voucherRow(3001, 20, 0),
      voucherRow(3001, 0, 120),
      voucherRow(3002, 0, 200),
      voucherRow(2611, 0, 75),
    ];
    expect(mapPayment(twoRows, rows)).toHaveProperty('blocked');
  });

  it('keeps historical single-item receipts compatible but rejects explicit wrong order', () => {
    const expected = mappedDraft([twoRows[0]!]).expected;
    const target = targetInvoice(expected);
    const row = target.items[0]! as unknown as Record<string, unknown>;
    delete row.sort_order;
    delete row.id;
    expect(
      matchesInvoiceExpected({ data: target }, targetInvoiceId, expected, {
        status: 'sent',
        invoiceNumber: 'A-42',
      }),
    ).toBe(true);
    row.sort_order = 1;
    expect(
      matchesInvoiceExpected({ data: target }, targetInvoiceId, expected, {
        status: 'sent',
        invoiceNumber: 'A-42',
      }),
    ).toBe(false);
  });
});
