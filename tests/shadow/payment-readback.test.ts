import { describe, expect, it, vi } from 'vitest';
import { verifyAccountedPaymentReadback } from '../../src/shadow/payment-readback.js';
import type { PaymentReadbackExpected } from '../../src/shadow/payment-readback.js';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const JOURNAL_ID = '44444444-4444-4444-8444-444444444444';
const LINE_1930_ID = '55555555-5555-4555-8555-555555555555';
const LINE_3001_ID = '66666666-6666-4666-8666-666666666666';
const LINE_2611_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_LINE_ID = '88888888-8888-4888-8888-888888888888';
const PAYMENT_DATE = '2026-01-15';

type ReadRequest = { method: string; path: string };
type ReadResponse = { status: number; json: unknown };

function expected(): PaymentReadbackExpected {
  return {
    companyId: COMPANY_ID,
    invoiceId: INVOICE_ID,
    paymentId: PAYMENT_ID,
    journalId: JOURNAL_ID,
    paymentDate: PAYMENT_DATE,
    amount: 125,
    currency: 'SEK',
    journalSourceType: 'invoice_cash_payment',
    lines: [
      { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: {} },
      { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
      { account_number: '2611', debit_amount: 0, credit_amount: 25, dimensions: {} },
    ],
  };
}

function invoicePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    payment_date: PAYMENT_DATE,
    amount: 125,
    currency: 'SEK',
    journal_entry_id: JOURNAL_ID,
    transaction_id: null,
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    currency: 'SEK',
    document_type: 'invoice',
    status: 'partially_paid',
    total: 500,
    paid_amount: 200,
    remaining_amount: 300,
    payments: [invoicePayment()],
    ...overrides,
  };
}

function journalLine(
  id: string,
  account_number: string,
  debit_amount: number,
  credit_amount: number,
  dimensions: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    account_number,
    debit_amount,
    credit_amount,
    dimensions,
    currency: 'SEK',
    amount_in_currency: null,
    exchange_rate: null,
    tax_code: null,
    cost_center: null,
    project: null,
    ...extra,
  };
}

function journal(overrides: Record<string, unknown> = {}) {
  return {
    id: JOURNAL_ID,
    status: 'posted',
    entry_date: PAYMENT_DATE,
    source_type: 'invoice_cash_payment',
    source_id: INVOICE_ID,
    reverses_id: null,
    reversed_by_id: null,
    correction_of_id: null,
    lines: [
      journalLine(LINE_1930_ID, '1930', 125, 0),
      journalLine(LINE_3001_ID, '3001', 0, 100),
      journalLine(LINE_2611_ID, '2611', 0, 25),
    ],
    ...overrides,
  };
}

function paths(value: PaymentReadbackExpected = expected()) {
  return {
    invoice: `/api/v1/companies/${value.companyId}/invoices/${value.invoiceId}?expand=payments`,
    journal: `/api/v1/companies/${value.companyId}/journal-entries/${value.journalId}`,
  };
}

function syntheticRequest(
  options: {
    expected?: PaymentReadbackExpected;
    invoiceBody?: unknown;
    invoiceStatus?: number;
    journalBody?: unknown;
    journalStatus?: number;
  } = {},
) {
  const expectedValue = options.expected ?? expected();
  const expectedPaths = paths(expectedValue);
  const calls: ReadRequest[] = [];
  const request = vi.fn(async (call: ReadRequest): Promise<ReadResponse> => {
    calls.push(call);
    if (call.path === expectedPaths.invoice) {
      return {
        status: options.invoiceStatus ?? 200,
        json: options.invoiceBody ?? { data: invoice() },
      };
    }
    if (call.path === expectedPaths.journal) {
      return {
        status: options.journalStatus ?? 200,
        json: options.journalBody ?? { data: journal() },
      };
    }
    return { status: 404, json: { error: 'unexpected synthetic path' } };
  });
  return { request, calls, expectedPaths };
}

describe('verifyAccountedPaymentReadback', () => {
  it('detaches expectations before a transport callback can mutate the caller object', async () => {
    const value = expected();
    const fixture = syntheticRequest();
    const request = async (call: ReadRequest) => {
      value.amount = 999;
      value.lines[0].dimensions['1'] = 'changed';
      return fixture.request(call);
    };
    await expect(verifyAccountedPaymentReadback(value, request)).resolves.toBe(true);
  });

  it('compares complete dimensions and their generated cost center/project mirrors', async () => {
    const value = expected();
    value.lines[0].dimensions = { '1': 'CC1', '6': 'P1', '20': 'REGION' };
    const lines = journal().lines;
    lines[0] = journalLine(
      LINE_1930_ID,
      '1930',
      125,
      0,
      { '20': 'REGION', '6': 'P1', '1': 'CC1' },
      { cost_center: 'CC1', project: 'P1' },
    );
    const fixture = syntheticRequest({ journalBody: { data: journal({ lines }) } });
    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(true);
  });

  it('rejects duplicate IDs even on unrelated payment rows', async () => {
    const other = invoicePayment({ id: OTHER_LINE_ID });
    const fixture = syntheticRequest({
      invoiceBody: { data: invoice({ payments: [invoicePayment(), other, other] }) },
    });
    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it('rejects aggregate cent totals outside safe integer range even when every line fits', async () => {
    const value = expected();
    const amount = 45_000_000_000_000;
    value.lines = Array.from({ length: 3 }, () => [
      { account_number: '1930', debit_amount: amount, credit_amount: 0, dimensions: {} },
      { account_number: '3001', debit_amount: 0, credit_amount: amount, dimensions: {} },
    ]).flat();
    const fixture = syntheticRequest();
    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('accepts exact fractional currency units without rejecting floating-point multiplication noise', async () => {
    const value = expected();
    value.amount = 1.1;
    value.lines = [
      { account_number: '1930', debit_amount: 1.1, credit_amount: 0, dimensions: {} },
      { account_number: '3001', debit_amount: 0, credit_amount: 1.1, dimensions: {} },
    ];
    const fixture = syntheticRequest({
      invoiceBody: { data: invoice({ payments: [invoicePayment({ amount: 1.1 })] }) },
      journalBody: {
        data: journal({
          lines: [
            journalLine(LINE_1930_ID, '1930', 1.1, 0),
            journalLine(LINE_3001_ID, '3001', 0, 1.1),
          ],
        }),
      },
    });
    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(true);
  });

  it('accepts the exact invoice payment row and posted journal with fixed GET-only paths', async () => {
    const fixture = syntheticRequest();

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(true);

    expect(fixture.calls).toEqual([
      { method: 'GET', path: fixture.expectedPaths.invoice },
      { method: 'GET', path: fixture.expectedPaths.journal },
    ]);
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it('allows later invoice payments while selecting exactly this payment row', async () => {
    const anotherPayment = invoicePayment({
      id: OTHER_LINE_ID,
      payment_date: '2026-02-01',
      amount: 75,
      journal_entry_id: OTHER_LINE_ID,
      transaction_id: '99999999-9999-4999-8999-999999999999',
    });
    const fixture = syntheticRequest({
      invoiceBody: {
        data: invoice({
          status: 'paid',
          paid_amount: 500,
          remaining_amount: 0,
          payments: [anotherPayment, invoicePayment()],
        }),
      },
    });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(true);
  });

  it('accepts the alternate supported invoice_paid source type when expected explicitly', async () => {
    const value = { ...expected(), journalSourceType: 'invoice_paid' as const };
    const fixture = syntheticRequest({
      expected: value,
      journalBody: { data: journal({ source_type: 'invoice_paid' }) },
    });

    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(true);
  });

  it.each([
    ['amount', { amount: 124.99 }],
    ['date', { payment_date: '2026-01-16' }],
    ['payment identity', { id: OTHER_LINE_ID }],
    ['journal identity', { journal_entry_id: OTHER_LINE_ID }],
    ['transaction linkage', { transaction_id: OTHER_LINE_ID }],
    ['payment currency', { currency: 'EUR' }],
    ['company scope', { companyId: OTHER_COMPANY_ID }],
  ])('rejects a changed payment %s', async (_label, change) => {
    const value = expected();
    if (_label === 'company scope') {
      const changedExpected = { ...value, ...change } as PaymentReadbackExpected;
      const fixture = syntheticRequest();
      await expect(verifyAccountedPaymentReadback(changedExpected, fixture.request)).resolves.toBe(
        false,
      );
      expect(fixture.calls[0].path).toContain(`/companies/${OTHER_COMPANY_ID}/`);
      expect(fixture.calls).toHaveLength(1);
      return;
    }
    const fixture = syntheticRequest({
      invoiceBody: { data: invoice({ payments: [invoicePayment(change)] }) },
    });
    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(false);
  });

  it('rejects duplicate matching payment rows instead of selecting one', async () => {
    const fixture = syntheticRequest({
      invoiceBody: { data: invoice({ payments: [invoicePayment(), invoicePayment()] }) },
    });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    ['missing payment array', { data: invoice({ payments: undefined }) }],
    ['non-array payment collection', { data: invoice({ payments: {} }) }],
    ['missing invoice envelope data', { data: null }],
  ])('returns false for %s', async (_label, invoiceBody) => {
    const fixture = syntheticRequest({ invoiceBody });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([
    ['invoice id', { id: OTHER_LINE_ID }],
    ['invoice currency', { currency: 'EUR' }],
    ['invoice document type', { document_type: 'proforma' }],
    ['cancelled journal', { status: 'cancelled' }],
    ['journal identity', { id: OTHER_LINE_ID }],
    ['wrong journal date', { entry_date: '2026-01-16' }],
    ['wrong source type', { source_type: 'invoice_paid' }],
    ['wrong source invoice', { source_id: OTHER_LINE_ID }],
    ['reversed journal', { reverses_id: OTHER_LINE_ID }],
    ['journal with reverse link', { reversed_by_id: OTHER_LINE_ID }],
    ['journal with correction link', { correction_of_id: OTHER_LINE_ID }],
    ['missing journal lines', { lines: undefined }],
  ])('rejects a %s', async (_label, change) => {
    const fixture = _label.startsWith('invoice ')
      ? syntheticRequest({ invoiceBody: { data: invoice(change) } })
      : syntheticRequest({ journalBody: { data: journal(change) } });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
  });

  it.each([
    [
      'wrong account',
      [
        journalLine(LINE_1930_ID, '1940', 125, 0),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    ['extra line', [...journal().lines, journalLine(OTHER_LINE_ID, '8999', 1, 0)]],
    [
      'duplicate line identity',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0),
        journalLine(LINE_1930_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'duplicate semantic line',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0),
        journalLine(LINE_3001_ID, '3001', 0, 50),
        journalLine(LINE_2611_ID, '2611', 0, 25),
        journalLine(OTHER_LINE_ID, '3001', 0, 50),
      ],
    ],
    [
      'wrong dimensions',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, { '1': 'A' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'extra dimension',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, { unexpected: 'x' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'non-SEK line',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, {}, { currency: 'EUR' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'FX amount',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, {}, { amount_in_currency: 125 }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'FX rate',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, {}, { exchange_rate: 1 }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'tax code',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, {}, { tax_code: '25' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'cost center mismatch',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, { '1': 'CC1' }, { cost_center: 'CC2' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'project mismatch',
      [
        journalLine(LINE_1930_ID, '1930', 125, 0, { '6': 'P1' }, { project: 'P2' }),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'invalid line UUID',
      [
        journalLine('not-a-uuid', '1930', 125, 0),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'non-cent actual amount',
      [
        journalLine(LINE_1930_ID, '1930', 125.001, 0),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
    [
      'non-finite actual amount',
      [
        journalLine(LINE_1930_ID, '1930', Number.NaN, 0),
        journalLine(LINE_3001_ID, '3001', 0, 100),
        journalLine(LINE_2611_ID, '2611', 0, 25),
      ],
    ],
  ])('rejects journal lines with %s', async (_label, lines) => {
    const fixture = syntheticRequest({ journalBody: { data: journal({ lines }) } });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
  });

  it('compares the complete line multiset independent of display order', async () => {
    const shuffled = [...journal().lines].reverse();
    const fixture = syntheticRequest({ journalBody: { data: journal({ lines: shuffled }) } });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(true);
  });

  it('preserves multiplicity when equivalent duplicate semantic lines are expected', async () => {
    const value = {
      ...expected(),
      lines: [
        { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: {} },
        { account_number: '3001', debit_amount: 0, credit_amount: 50, dimensions: {} },
        { account_number: '3001', debit_amount: 0, credit_amount: 50, dimensions: {} },
        { account_number: '2611', debit_amount: 0, credit_amount: 25, dimensions: {} },
      ],
    };
    const fixture = syntheticRequest({
      expected: value,
      journalBody: {
        data: journal({
          lines: [
            journalLine(LINE_1930_ID, '1930', 125, 0),
            journalLine(LINE_3001_ID, '3001', 0, 50),
            journalLine(OTHER_LINE_ID, '3001', 0, 50),
            journalLine(LINE_2611_ID, '2611', 0, 25),
          ],
        }),
      },
    });

    await expect(verifyAccountedPaymentReadback(value, fixture.request)).resolves.toBe(true);
  });

  it.each([
    ['fractional cent payment', { amount: 125.001 }],
    ['non-finite payment', { amount: Number.POSITIVE_INFINITY }],
    ['invalid calendar date', { paymentDate: '2026-13-40' }],
    ['unsupported currency', { currency: 'EUR' }],
    ['unsupported journal source', { journalSourceType: 'other' }],
    ['zero payment', { amount: 0 }],
    ['unsafe payment total', { amount: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'negative line',
      { lines: [{ account_number: '1930', debit_amount: -125, credit_amount: 0, dimensions: {} }] },
    ],
    [
      'zero-sided line',
      { lines: [{ account_number: '1930', debit_amount: 0, credit_amount: 0, dimensions: {} }] },
    ],
    [
      'fractional cent line',
      {
        lines: [
          { account_number: '1930', debit_amount: 125.001, credit_amount: 0, dimensions: {} },
          { account_number: '3001', debit_amount: 0, credit_amount: 125.001, dimensions: {} },
        ],
      },
    ],
    [
      'unbalanced lines',
      {
        lines: [
          { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: {} },
          { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
        ],
      },
    ],
    [
      'equal debit and credit side',
      { lines: [{ account_number: '1930', debit_amount: 1, credit_amount: 1, dimensions: {} }] },
    ],
    [
      'invalid account number',
      {
        lines: [
          { account_number: '193', debit_amount: 125, credit_amount: 0, dimensions: {} },
          { account_number: '3001', debit_amount: 0, credit_amount: 125, dimensions: {} },
        ],
      },
    ],
    [
      'non-string dimension',
      {
        lines: [
          { account_number: '1930', debit_amount: 125, credit_amount: 0, dimensions: { '1': 3 } },
          { account_number: '3001', debit_amount: 0, credit_amount: 125, dimensions: {} },
        ],
      },
    ],
    [
      'unsafe line totals',
      {
        lines: [
          {
            account_number: '1930',
            debit_amount: 4503599627370496,
            credit_amount: 0,
            dimensions: {},
          },
          {
            account_number: '1931',
            debit_amount: 4503599627370496,
            credit_amount: 0,
            dimensions: {},
          },
          {
            account_number: '3001',
            debit_amount: 0,
            credit_amount: 4503599627370496,
            dimensions: {},
          },
          {
            account_number: '3002',
            debit_amount: 0,
            credit_amount: 4503599627370496,
            dimensions: {},
          },
        ],
      },
    ],
    ['malformed UUID', { paymentId: 'not-a-uuid' }],
    ['duplicate resource identities', { journalId: PAYMENT_ID }],
  ])('returns false for invalid expected input: %s without any request', async (_label, change) => {
    const candidate = { ...expected(), ...change } as PaymentReadbackExpected;
    const fixture = syntheticRequest({ expected: candidate });

    await expect(verifyAccountedPaymentReadback(candidate, fixture.request)).resolves.toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('rejects a malformed journal response after the journal read', async () => {
    const fixture = syntheticRequest({ journalBody: { data: { id: JOURNAL_ID, lines: 'bad' } } });

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
    expect(fixture.calls).toHaveLength(2);
  });

  it.each([
    ['invoice', { invoiceStatus: 503 }],
    ['journal', { journalStatus: 503 }],
  ])('returns false for a non-200 %s response', async (_label, options) => {
    const fixture = syntheticRequest(options);

    await expect(verifyAccountedPaymentReadback(expected(), fixture.request)).resolves.toBe(false);
  });

  it.each([0, 1])(
    'throws an Error with the transport cause for GET %s failure',
    async (failedRead) => {
      const transportError = new Error('synthetic transport failure');
      const calls: ReadRequest[] = [];
      const request = vi.fn(async (call: ReadRequest): Promise<ReadResponse> => {
        calls.push(call);
        if (calls.length === failedRead + 1) throw transportError;
        return call.path.includes('/invoices/')
          ? { status: 200, json: { data: invoice() } }
          : { status: 200, json: { data: journal() } };
      });

      let failure: unknown;
      try {
        await verifyAccountedPaymentReadback(expected(), request);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ cause: transportError });
      expect(calls.length).toBe(failedRead + 1);
    },
  );
});
