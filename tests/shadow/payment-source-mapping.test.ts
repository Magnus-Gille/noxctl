import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalEncode } from '../../src/shadow/codec.js';
import { mapBookedInvoicePayment } from '../../src/shadow/payment-source-mapping.js';
import type { CapturedPaymentVoucher } from '../../src/shadow/payment-source-mapping.js';
import type { InvoiceDraftExpected } from '../../src/shadow/invoice-draft-mapping.js';
import type {
  ShadowBinding,
  ShadowPaymentGroup,
  ShadowRecord,
  ShadowSnapshotEntry,
} from '../../src/shadow/types.js';

const binding: ShadowBinding = {
  sourceCompany: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  targetCompany: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const SOURCE_PAYMENT_ID = '17';
const SOURCE_INVOICE_ID = '42';
const VOUCHER_HASH = /^[0-9a-f]{64}$/;

function requestHash(record: Pick<ShadowRecord, 'operation' | 'args'>): string {
  return createHash('sha256')
    .update(
      canonicalEncode({ version: 1, ...binding, operation: record.operation, args: record.args }),
    )
    .digest('hex');
}

function member(
  sequence: number,
  id: string,
  operation: string,
  args: unknown[],
  sourceResult: unknown,
): ShadowSnapshotEntry {
  const record: ShadowRecord = {
    ...binding,
    id,
    version: 1,
    operation,
    args,
    requestHash: '',
    state: 'pending',
    createdAt: sequence,
    updatedAt: sequence,
    sourceResult,
  };
  record.requestHash = requestHash(record);
  return { sequence, record };
}

function paymentResult(overrides: Record<string, unknown> = {}) {
  return {
    Number: 17,
    InvoiceNumber: 42,
    Booked: true,
    Amount: 125,
    AmountCurrency: 125,
    Currency: 'SEK',
    CurrencyRate: 1,
    CurrencyUnit: 1,
    InvoiceTotal: 125,
    WriteOffs: [],
    ModeOfPaymentAccount: 1930,
    PaymentDate: '2026-01-15',
    VoucherYear: 2,
    VoucherSeries: 'A',
    VoucherNumber: 7,
    ...overrides,
  };
}

function sourceVoucher(overrides: Record<string, unknown> = {}) {
  return {
    Year: 2,
    VoucherSeries: 'A',
    VoucherNumber: 7,
    ReferenceType: 'INVOICEPAYMENT',
    ReferenceNumber: 42,
    TransactionDate: '2026-01-15',
    CostCenter: '',
    Project: '',
    VoucherRows: [
      {
        Account: 1930,
        CostCenter: '',
        Credit: 0,
        Debit: 125,
        Description: 'Synthetic bank settlement',
        Project: '',
        Quantity: 0,
        Removed: false,
        TransactionInformation: 'Synthetic payment fixture',
      },
      {
        Account: '3001',
        CostCenter: '',
        Credit: 100,
        Debit: 0,
        Description: 'Synthetic revenue settlement',
        Project: '',
        Quantity: 0,
        Removed: false,
        TransactionInformation: 'Synthetic row fixture',
      },
      {
        Account: 2611,
        CostCenter: '',
        Credit: 25,
        Debit: 0,
        Description: 'Synthetic VAT settlement',
        Project: '',
        Quantity: 0,
        Removed: false,
        TransactionInformation: 'Synthetic row fixture',
      },
    ],
    ...overrides,
  };
}

function expectedInvoice(overrides: Record<string, unknown> = {}): InvoiceDraftExpected {
  return {
    customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    invoice_date: '2026-01-15',
    due_date: '2026-02-14',
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
    items: [
      {
        description: 'Consulting service',
        quantity: 1,
        unit: 'st',
        unit_price: 100,
        vat_rate: 25,
        revenue_account: '3001',
        line_total: 100,
        vat_amount: 25,
        discount_percent: 0,
      },
    ],
    ...overrides,
  } as InvoiceDraftExpected;
}

function fixture(): {
  binding: ShadowBinding;
  group: ShadowPaymentGroup;
  voucher: CapturedPaymentVoucher;
  expectedInvoice: InvoiceDraftExpected;
} {
  const createResult = paymentResult({ Booked: false });
  const terminalResult = paymentResult();
  const members = [
    member(
      2,
      'payment-create',
      'createInvoicePayment',
      [{ InvoiceNumber: 42, Amount: 125 }],
      createResult,
    ),
    member(10, 'payment-bookkeep', 'bookkeepInvoicePayment', [17], terminalResult),
  ];
  return {
    binding: { ...binding },
    group: {
      id: 'synthetic-payment-group-17',
      sourcePaymentId: SOURCE_PAYMENT_ID,
      sourceInvoiceId: SOURCE_INVOICE_ID,
      members,
      sourceResult: terminalResult,
    },
    voucher: {
      sourceCompany: binding.sourceCompany,
      financialYearId: 2,
      data: sourceVoucher(),
    },
    expectedInvoice: expectedInvoice(),
  };
}

function map(input: ReturnType<typeof fixture>) {
  return mapBookedInvoicePayment(input.group, input.binding, input.voucher, input.expectedInvoice);
}

function voucherObject(input: ReturnType<typeof fixture>): Record<string, unknown> {
  return input.voucher.data as Record<string, unknown>;
}

function voucherRows(input: ReturnType<typeof fixture>): Record<string, unknown>[] {
  return voucherObject(input).VoucherRows as Record<string, unknown>[];
}

describe('mapBookedInvoicePayment', () => {
  it('rejects an absent binding without dereferencing it', () => {
    const input = fixture();
    expect(
      mapBookedInvoicePayment(
        input.group,
        null as unknown as ShadowBinding,
        input.voucher,
        input.expectedInvoice,
      ),
    ).toHaveProperty('blocked');
  });

  it('pins the complete original capture and preserves row order while matching a multiset', () => {
    const input = fixture();
    voucherRows(input).reverse();
    const result = map(input);
    if (!('request' in result)) throw new Error(result.blocked);
    expect(result.request.sourceVoucher.hash).toBe(
      createHash('sha256').update(canonicalEncode(input.voucher)).digest('hex'),
    );
    expect(result.request.lines.map((row) => row.account_number)).toEqual(['2611', '3001', '1930']);
  });

  it('treats an empty-unit invoice row exactly like any other unit for payment parity', () => {
    const input = fixture();
    const base = map(input);
    const item = expectedInvoice().items[0]!;
    input.expectedInvoice = expectedInvoice({ items: [{ ...item, unit: '' }] });
    const result = map(input);
    if (!('request' in result) || !('request' in base)) throw new Error('expected a plan');
    expect(result.request).toEqual(base.request);
    expect(JSON.stringify(result.request)).not.toContain('"unit"');
  });

  it('does not silently ignore an unrecognized financial field', () => {
    const input = fixture();
    const changed = paymentResult({ NewSettlementAdjustment: 1 });
    input.group.sourceResult = changed;
    input.group.members[1].record.sourceResult = changed;
    expect(map(input)).toHaveProperty('blocked');
  });

  it('maps a booked payment and the exact captured source voucher to expected payment lines', () => {
    const input = fixture();
    const result = map(input);

    expect(result).toEqual({
      request: {
        sourcePaymentId: SOURCE_PAYMENT_ID,
        sourceInvoiceId: SOURCE_INVOICE_ID,
        paymentDate: '2026-01-15',
        amount: 125,
        currency: 'SEK',
        sourceVoucher: {
          year: '2',
          series: 'A',
          number: '7',
          hash: expect.stringMatching(VOUCHER_HASH),
        },
        lines: [
          { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: {} },
          { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
          { account_number: '2611', debit_amount: 0, credit_amount: 25, dimensions: {} },
        ],
      },
    });
  });

  it('retains only source-derived accounting semantics and hashes full row descriptions', () => {
    const first = fixture();
    const second = fixture();
    const firstResult = map(first);
    (second.voucher.data as ReturnType<typeof sourceVoucher>).VoucherRows[0].Description =
      'changed source memo';
    const secondResult = map(second);

    expect(firstResult).toHaveProperty('request.lines', [
      { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: {} },
      { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
      { account_number: '2611', debit_amount: 0, credit_amount: 25, dimensions: {} },
    ]);
    expect(secondResult).toHaveProperty(
      'request.lines',
      (firstResult as { request: { lines: unknown } }).request.lines,
    );
    expect(
      (firstResult as { request: { sourceVoucher: { hash: string } } }).request.sourceVoucher.hash,
    ).not.toBe(
      (secondResult as { request: { sourceVoucher: { hash: string } } }).request.sourceVoucher.hash,
    );
  });

  it.each([
    [
      'unbooked terminal receipt',
      (input: ReturnType<typeof fixture>) => {
        input.group.sourceResult = paymentResult({ Booked: false });
        input.group.members[1]!.record.sourceResult = paymentResult({ Booked: false });
      },
    ],
    [
      'payment number mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.group.sourceResult = paymentResult({ Number: 18 });
        input.group.members[1]!.record.sourceResult = paymentResult({ Number: 18 });
      },
    ],
    [
      'invoice number mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.group.sourceResult = paymentResult({ InvoiceNumber: 43 });
        input.group.members[1]!.record.sourceResult = paymentResult({ InvoiceNumber: 43 });
      },
    ],
    [
      'member binding mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.group.members[0]!.record.sourceCompany = 'foreign-source';
      },
    ],
    [
      'member request hash mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.group.members[0]!.record.requestHash = '0'.repeat(64);
      },
    ],
    [
      'noncanonical source payment id',
      (input: ReturnType<typeof fixture>) => {
        input.group.sourcePaymentId = '017';
      },
    ],
  ])('blocks a group with %s', (_label, mutate) => {
    const input = fixture();
    mutate(input);

    expect(map(input)).toHaveProperty('blocked');
  });

  it.each([
    ['amount', { Amount: 124 }],
    ['currency', { Currency: 'EUR' }],
    ['currency rate', { CurrencyRate: 1.01 }],
    ['currency unit', { CurrencyUnit: 100 }],
    ['amount currency', { AmountCurrency: 124 }],
    ['invoice total', { InvoiceTotal: 126 }],
    ['write-off', { WriteOffs: [{ Amount: 1 }] }],
    ['mode-of-payment account', { ModeOfPaymentAccount: 1910 }],
    ['payment date', { PaymentDate: '2026-02-15' }],
    ['invalid payment date', { PaymentDate: '2026-13-40' }],
    ['voucher year', { VoucherYear: 3 }],
    ['voucher series', { VoucherSeries: 'B' }],
    ['voucher number', { VoucherNumber: 8 }],
  ])('blocks source payment with mismatched %s', (_label, changes) => {
    const input = fixture();
    const changed = paymentResult(changes);
    input.group.sourceResult = changed;
    input.group.members[1]!.record.sourceResult = changed;

    expect(map(input)).toHaveProperty('blocked');
  });

  it.each([
    [
      'captured company',
      (input: ReturnType<typeof fixture>) => {
        input.voucher.sourceCompany = 'foreign-source';
      },
    ],
    [
      'wrapper financial year',
      (input: ReturnType<typeof fixture>) => {
        input.voucher.financialYearId = 3;
      },
    ],
    [
      'voucher financial year',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).Year = 3;
      },
    ],
    [
      'voucher series',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).VoucherSeries = 'B';
      },
    ],
    [
      'voucher number',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).VoucherNumber = 8;
      },
    ],
    [
      'reference type',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).ReferenceType = 'INVOICE';
      },
    ],
    [
      'reference invoice',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).ReferenceNumber = 17;
      },
    ],
    [
      'transaction date',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).TransactionDate = '2026-01-16';
      },
    ],
    [
      'missing cost-center header',
      (input: ReturnType<typeof fixture>) => {
        delete (input.voucher.data as Record<string, unknown>).CostCenter;
      },
    ],
    [
      'project header',
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).Project = 'P1';
      },
    ],
  ])('blocks captured voucher with mismatched %s', (_label, mutate) => {
    const input = fixture();
    mutate(input);

    expect(map(input)).toHaveProperty('blocked');
  });

  it.each([
    ['removed row', (row: Record<string, unknown>) => ({ ...row, Removed: true })],
    ['quantity', (row: Record<string, unknown>) => ({ ...row, Quantity: 1 })],
    ['cost-center tag', (row: Record<string, unknown>) => ({ ...row, CostCenter: 'CC1' })],
    ['project tag', (row: Record<string, unknown>) => ({ ...row, Project: 'P1' })],
    ['unknown row field', (row: Record<string, unknown>) => ({ ...row, Unexpected: 'keep me' })],
    ['non-cent amount', (row: Record<string, unknown>) => ({ ...row, Debit: 125.001 })],
    ['negative amount', (row: Record<string, unknown>) => ({ ...row, Debit: -1 })],
    ['two positive sides', (row: Record<string, unknown>) => ({ ...row, Credit: 1 })],
  ])('blocks a source voucher containing a %s', (_label, mutate) => {
    const input = fixture();
    voucherRows(input)[0] = mutate(voucherRows(input)[0]!);

    expect(map(input)).toHaveProperty('blocked');
  });

  it.each([
    [
      'missing expected line',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input).pop();
      },
    ],
    [
      'extra line',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input).push({
          Account: 8999,
          CostCenter: '',
          Credit: 1,
          Debit: 0,
          Description: 'Synthetic extra line',
          Project: '',
          Quantity: 0,
          Removed: false,
          TransactionInformation: '',
        });
      },
    ],
    [
      'duplicate line',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input).push({ ...voucherRows(input)[1]! });
      },
    ],
    [
      'different revenue account',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input)[1]!.Account = 3002;
      },
    ],
    [
      'unbalanced line amount',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input)[1]!.Credit = 99;
      },
    ],
    [
      'wrong VAT amount',
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input)[2]!.Credit = 24;
      },
    ],
    [
      'wrong invoice expected total',
      (input: ReturnType<typeof fixture>) => {
        input.expectedInvoice = expectedInvoice({ total: 126 });
      },
    ],
    [
      'wrong invoice expected VAT',
      (input: ReturnType<typeof fixture>) => {
        input.expectedInvoice = expectedInvoice({ vat_amount: 24 });
      },
    ],
    [
      'wrong expected VAT rate',
      (input: ReturnType<typeof fixture>) => {
        input.expectedInvoice = expectedInvoice({
          items: [
            {
              description: 'Consulting service',
              quantity: 1,
              unit: 'st',
              unit_price: 100,
              vat_rate: 12,
              revenue_account: '3001',
              line_total: 100,
              vat_amount: 25,
              discount_percent: 0,
            },
          ],
        });
      },
    ],
    [
      'wrong expected revenue account',
      (input: ReturnType<typeof fixture>) => {
        input.expectedInvoice = expectedInvoice({
          items: [
            {
              description: 'Consulting service',
              quantity: 1,
              unit: 'st',
              unit_price: 100,
              vat_rate: 25,
              revenue_account: '3002',
              line_total: 100,
              vat_amount: 25,
              discount_percent: 0,
            },
          ],
        });
      },
    ],
    [
      'wrong invoice subtotal',
      (input: ReturnType<typeof fixture>) => {
        input.expectedInvoice = expectedInvoice({ subtotal: 99 });
      },
    ],
  ])('blocks a voucher with %s', (_label, mutate) => {
    const input = fixture();
    mutate(input);

    expect(map(input)).toHaveProperty('blocked');
  });

  it('rejects unsafe, incomplete, and noncanonical voucher account identifiers', () => {
    const cases = [
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input)[0]!.Account = 30001;
      },
      (input: ReturnType<typeof fixture>) => {
        voucherRows(input)[0]!.Account = Number.MAX_SAFE_INTEGER + 1;
      },
      (input: ReturnType<typeof fixture>) => {
        voucherObject(input).VoucherNumber = undefined;
      },
    ];
    for (const mutate of cases) {
      const input = fixture();
      mutate(input);
      expect(map(input)).toHaveProperty('blocked');
    }
  });

  it('does not mutate caller-owned source snapshots, capture, or expected invoice', () => {
    const input = fixture();
    const before = canonicalEncode({
      binding: input.binding,
      group: input.group,
      voucher: input.voucher,
      expectedInvoice: input.expectedInvoice,
    });

    expect(map(input)).toHaveProperty('request');
    expect(
      canonicalEncode({
        binding: input.binding,
        group: input.group,
        voucher: input.voucher,
        expectedInvoice: input.expectedInvoice,
      }),
    ).toBe(before);
  });
});

describe('captured InvoiceTotal decimal-string representation', () => {
  it.each(['125', '125.0', '125.00'])(
    'accepts exact total %s without changing source evidence',
    (total) => {
      const input = fixture();
      for (const row of input.group.members)
        (row.record.sourceResult as Record<string, unknown>).InvoiceTotal = total;
      const encoded = canonicalEncode(input.group);
      expect(map(input)).toMatchObject({ request: { amount: 125 } });
      expect(canonicalEncode(input.group)).toBe(encoded);
    },
  );
  it.each([
    '',
    ' 125',
    '125 ',
    '125,00',
    '1.25e2',
    '+125',
    '0125',
    '-125',
    '125.001',
    'Infinity',
    '90071992547409.92',
    '900719925474099999999999999999999999999',
  ])('rejects noncanonical or unsafe total %j', (total) => {
    const input = fixture();
    for (const row of input.group.members)
      (row.record.sourceResult as Record<string, unknown>).InvoiceTotal = total;
    expect(map(input)).toHaveProperty('blocked');
  });
});
