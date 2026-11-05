import { describe, expect, it } from 'vitest';
import type { ShadowBinding, ShadowRecord } from '../../src/shadow/types.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';

const binding: ShadowBinding = {
  sourceCompany: 'source-company',
  targetCompany: 'target-company',
};
const customerTargetId = '550e8400-e29b-41d4-a716-446655440000';

type DraftRow = {
  Description: string;
  DeliveredQuantity: number;
  Price: number;
  VAT: number;
  Unit: string;
  AccountNumber?: unknown;
  [key: string]: unknown;
};

type DraftInput = {
  CustomerNumber: unknown;
  InvoiceDate: unknown;
  DueDate: unknown;
  Currency: unknown;
  InvoiceRows: unknown;
  [key: string]: unknown;
};

type Lookup = (resource: ShadowResourceKind, sourceId: string) => ShadowIdentityResolution;

function inputFixture(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    CustomerNumber: 'C-100',
    InvoiceDate: '2026-01-15',
    DueDate: '2026-02-14',
    Currency: 'SEK',
    InvoiceRows: [
      {
        Description: 'Consulting service',
        DeliveredQuantity: 2,
        Price: 1000,
        VAT: 25,
        Unit: 'st',
      } satisfies DraftRow,
    ],
    ...overrides,
  };
}

function sourceFixture(input: DraftInput): Record<string, unknown> {
  const row = (input.InvoiceRows as DraftRow[])[0]!;
  const netCents = Math.round(row.Price * 100) * row.DeliveredQuantity;
  const vatCents = Math.round(netCents / 4);
  const net = netCents / 100;
  const vat = vatCents / 100;
  const total = net + vat;
  return {
    DocumentNumber: 1001,
    CustomerNumber: input.CustomerNumber,
    InvoiceDate: input.InvoiceDate,
    DueDate: input.DueDate,
    Currency: input.Currency,
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
    CostCenter: '',
    Project: '',
    Net: net,
    TotalVAT: vat,
    Total: total,
    TotalToPay: total,
    Balance: total,
    InvoiceRows: [
      {
        Description: row.Description,
        DeliveredQuantity: row.DeliveredQuantity,
        Price: row.Price,
        PriceExcludingVAT: row.Price,
        TotalExcludingVAT: net,
        Total: net,
        Discount: 0,
        HouseWork: false,
        CostCenter: '',
        Project: '',
        ArticleNumber: '',
        VAT: row.VAT,
        Unit: row.Unit,
        AccountNumber: 3001,
      },
    ],
  };
}

function recordFixture(
  input = inputFixture(),
  sourceResult: unknown = sourceFixture(input),
  overrides: Partial<ShadowRecord> = {},
): ShadowRecord {
  return {
    version: 1,
    id: 'invoice-intent-1',
    operation: 'createInvoice',
    args: [input],
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    requestHash: 'request-hash-1',
    state: 'pending',
    createdAt: 1,
    updatedAt: 2,
    sourceResult,
    ...overrides,
  };
}

function readyIdentity(
  overrides: Partial<Extract<ShadowIdentityResolution, { state: 'ready' }>> = {},
): Extract<ShadowIdentityResolution, { state: 'ready' }> {
  return {
    state: 'ready',
    resource: 'customer',
    sourceId: 'C-100',
    targetId: customerTargetId,
    intentId: 'customer-intent-1',
    requestHash: 'customer-request-hash',
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    ...overrides,
  };
}

function lookupFixture(resolution: ShadowIdentityResolution = readyIdentity()) {
  const calls: Array<[ShadowResourceKind, string]> = [];
  const lookup: Lookup = (resource, sourceId) => {
    calls.push([resource, sourceId]);
    return resolution;
  };
  return { lookup, calls };
}

function withSource(
  input: DraftInput,
  headerOverrides: Record<string, unknown> = {},
  rowOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const source = sourceFixture(input);
  const sourceRows = source.InvoiceRows as Array<Record<string, unknown>>;
  return {
    ...source,
    ...headerOverrides,
    InvoiceRows: [{ ...sourceRows[0], ...rowOverrides }],
  };
}

function isBlocked(value: ReturnType<typeof mapInvoiceDraft>): value is { blocked: string } {
  return 'blocked' in value;
}

describe('mapInvoiceDraft', () => {
  it('maps a one-row confirmed invoice to a native draft body and response expectation', () => {
    const record = recordFixture();
    const calls = lookupFixture();

    expect(mapInvoiceDraft(record, binding, calls.lookup)).toEqual({
      request: {
        customer_id: customerTargetId,
        invoice_date: '2026-01-15',
        due_date: '2026-02-14',
        currency: 'SEK',
        document_type: 'invoice',
        payment_link_auto: false,
        ore_rounding: false,
        items: [
          {
            description: 'Consulting service',
            quantity: 2,
            unit: 'st',
            unit_price: 1000,
            vat_rate: 25,
            revenue_account: '3001',
          },
        ],
      },
      expected: {
        customer_id: customerTargetId,
        invoice_date: '2026-01-15',
        due_date: '2026-02-14',
        currency: 'SEK',
        document_type: 'invoice',
        payment_link_auto: false,
        ore_rounding: false,
        status: 'draft',
        invoice_number: null,
        subtotal: 2000,
        vat_amount: 500,
        total: 2500,
        remaining_amount: 2500,
        items: [
          {
            description: 'Consulting service',
            quantity: 2,
            unit: 'st',
            unit_price: 1000,
            vat_rate: 25,
            revenue_account: '3001',
            line_total: 2000,
            vat_amount: 500,
            discount_percent: 0,
          },
        ],
      },
      sourceInvoiceId: '1001',
    });
    expect(calls.calls).toEqual([['customer', 'C-100']]);
  });

  it.each([
    [0.01, 1, 0, 1],
    [0.02, 2, 1, 3],
    [0.1, 10, 3, 13],
  ])(
    'calculates integer-cent totals for unit price %s',
    (price, netCents, vatCents, totalCents) => {
      const input = inputFixture({
        InvoiceRows: [
          { Description: 'Boundary', DeliveredQuantity: 1, Price: price, VAT: 25, Unit: 'st' },
        ],
      });
      const source = sourceFixture(input);
      const result = mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup);

      expect(isBlocked(result)).toBe(false);
      if (!isBlocked(result)) {
        expect(result.request.items[0]?.unit_price).toBe(netCents / 100);
        expect(result.expected.subtotal).toBe(netCents / 100);
        expect(result.expected.vat_amount).toBe(vatCents / 100);
        expect(result.expected.total).toBe(totalCents / 100);
        expect(result.expected.items[0]?.line_total).toBe(netCents / 100);
        expect(result.expected.items[0]?.vat_amount).toBe(vatCents / 100);
      }
    },
  );

  it('normalizes a numeric source document number and accepts canonical decimal strings', () => {
    const input = inputFixture();
    const numericSource = sourceFixture(input);
    const numeric = mapInvoiceDraft(
      recordFixture(input, numericSource),
      binding,
      lookupFixture().lookup,
    );
    const stringSource = { ...numericSource, DocumentNumber: '1001' };
    const string = mapInvoiceDraft(
      recordFixture(input, stringSource),
      binding,
      lookupFixture().lookup,
    );

    expect(numeric).toMatchObject({ sourceInvoiceId: '1001' });
    expect(string).toMatchObject({ sourceInvoiceId: '1001' });
  });

  it('does not mutate source evidence, input arguments, or binding', () => {
    const record = recordFixture();
    const beforeRecord = structuredClone(record);
    const beforeBinding = structuredClone(binding);

    mapInvoiceDraft(record, binding, lookupFixture().lookup);

    expect(record).toEqual(beforeRecord);
    expect(binding).toEqual(beforeBinding);
  });

  it.each([
    ['source company', { sourceCompany: 'other-source' }],
    ['target company', { targetCompany: 'other-target' }],
  ])('blocks a mismatched %s binding', (_label, override) => {
    const result = mapInvoiceDraft(
      recordFixture(inputFixture(), undefined, override),
      binding,
      () => {
        throw new Error('lookup should not be called');
      },
    );

    expect(isBlocked(result)).toBe(true);
  });

  it('blocks unsupported operations before consulting customer identity', () => {
    const record = recordFixture(inputFixture(), sourceFixture(inputFixture()), {
      operation: 'creditInvoice',
    });
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(record, binding, calls.lookup))).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['no arguments', []],
    ['too many arguments', [inputFixture(), inputFixture()]],
    ['non-object argument', ['not-an-object']],
  ])('blocks malformed argument shape: %s', (_label, args) => {
    const record = recordFixture(inputFixture(), sourceFixture(inputFixture()), { args });

    expect(isBlocked(mapInvoiceDraft(record, binding, lookupFixture().lookup))).toBe(true);
  });

  it.each([
    ['CustomerNumber', { CustomerNumber: undefined }],
    ['InvoiceDate', { InvoiceDate: undefined }],
    ['DueDate', { DueDate: undefined }],
    ['Currency', { Currency: undefined }],
    ['InvoiceRows', { InvoiceRows: undefined }],
  ])('requires input field %s', (_field, overrides) => {
    const input = inputFixture(overrides);
    const calls = lookupFixture();

    const record = recordFixture(
      input,
      input.InvoiceRows === undefined ? sourceFixture(inputFixture()) : sourceFixture(input),
    );

    expect(isBlocked(mapInvoiceDraft(record, binding, calls.lookup))).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['Description', { Description: undefined }],
    ['DeliveredQuantity', { DeliveredQuantity: undefined }],
    ['Price', { Price: undefined }],
    ['VAT', { VAT: undefined }],
    ['Unit', { Unit: undefined }],
  ])('requires row input field %s', (_field, rowOverrides) => {
    const input = inputFixture({
      InvoiceRows: [{ ...(inputFixture().InvoiceRows as DraftRow[])[0]!, ...rowOverrides }],
    });
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input), binding, calls.lookup))).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['no rows', []],
    [
      'multiple rows',
      [
        ...(inputFixture().InvoiceRows as DraftRow[]),
        ...(inputFixture().InvoiceRows as DraftRow[]),
      ],
    ],
  ])('rejects empty input or input/source row-count mismatch: %s', (_label, InvoiceRows) => {
    const input = inputFixture({ InvoiceRows });
    const calls = lookupFixture();

    expect(
      isBlocked(
        mapInvoiceDraft(recordFixture(input, sourceFixture(inputFixture())), binding, calls.lookup),
      ),
    ).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it('rejects unknown header and row fields instead of dropping them', () => {
    const headerInput = inputFixture({ RequestedDiscount: 1 });
    const headerResult = mapInvoiceDraft(
      recordFixture(headerInput),
      binding,
      lookupFixture().lookup,
    );
    const baseRow = (inputFixture().InvoiceRows as DraftRow[])[0]!;
    const rowInput = inputFixture({ InvoiceRows: [{ ...baseRow, Discount: 1 }] });
    const rowResult = mapInvoiceDraft(recordFixture(rowInput), binding, lookupFixture().lookup);

    expect(isBlocked(headerResult) && headerResult.blocked).toContain('RequestedDiscount');
    expect(isBlocked(rowResult) && rowResult.blocked).toContain('Discount');
  });

  it.each([
    ['DocumentNumber', { DocumentNumber: undefined }],
    ['CustomerNumber', { CustomerNumber: undefined }],
    ['InvoiceDate', { InvoiceDate: undefined }],
    ['DueDate', { DueDate: undefined }],
    ['Currency', { Currency: undefined }],
    ['AccountingMethod', { AccountingMethod: undefined }],
    ['InvoiceType', { InvoiceType: undefined }],
    ['Country', { Country: undefined }],
    ['Booked', { Booked: undefined }],
    ['Sent', { Sent: undefined }],
    ['Cancelled', { Cancelled: undefined }],
    ['Credit', { Credit: undefined }],
    ['VATIncluded', { VATIncluded: undefined }],
    ['CurrencyRate', { CurrencyRate: undefined }],
    ['CurrencyUnit', { CurrencyUnit: undefined }],
    ['AdministrationFee', { AdministrationFee: undefined }],
    ['AdministrationFeeVAT', { AdministrationFeeVAT: undefined }],
    ['Freight', { Freight: undefined }],
    ['FreightVAT', { FreightVAT: undefined }],
    ['RoundOff', { RoundOff: undefined }],
    ['TaxReduction', { TaxReduction: undefined }],
    ['HouseWork', { HouseWork: undefined }],
    ['Net', { Net: undefined }],
    ['TotalVAT', { TotalVAT: undefined }],
    ['Total', { Total: undefined }],
    ['TotalToPay', { TotalToPay: undefined }],
    ['Balance', { Balance: undefined }],
  ])('requires source confirmation field %s', (_field, overrides) => {
    const input = inputFixture();
    const source = withSource(input, overrides);
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['Description', { Description: undefined }],
    ['DeliveredQuantity', { DeliveredQuantity: undefined }],
    ['Price', { Price: undefined }],
    ['PriceExcludingVAT', { PriceExcludingVAT: undefined }],
    ['TotalExcludingVAT', { TotalExcludingVAT: undefined }],
    ['Total', { Total: undefined }],
    ['Discount', { Discount: undefined }],
    ['HouseWork', { HouseWork: undefined }],
    ['VAT', { VAT: undefined }],
    ['Unit', { Unit: undefined }],
    ['AccountNumber', { AccountNumber: undefined }],
  ])('requires source row confirmation field %s', (_field, rowOverrides) => {
    const input = inputFixture();
    const source = withSource(input, {}, rowOverrides);
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['missing rows', undefined],
    ['no rows', []],
    [
      'multiple rows',
      [
        ...(sourceFixture(inputFixture()).InvoiceRows as object[]),
        ...(sourceFixture(inputFixture()).InvoiceRows as object[]),
      ],
    ],
  ])(
    'rejects missing source rows or source/input row-count mismatch: %s',
    (_label, InvoiceRows) => {
      const input = inputFixture();
      const source = { ...sourceFixture(input), InvoiceRows };
      const calls = lookupFixture();

      expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
        true,
      );
      expect(calls.calls).toEqual([]);
    },
  );

  it('requires an unwrapped plain source invoice result', () => {
    const calls = lookupFixture();

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(inputFixture(), []), binding, calls.lookup)),
    ).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['input invoice date', { InvoiceDate: '2025-02-29' }],
    ['input due date', { DueDate: '2026-02-30' }],
  ])('rejects an invalid %s', (_label, inputOverrides) => {
    const input = inputFixture(inputOverrides);
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input), binding, calls.lookup))).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it('accepts a real leap-day date and rejects due dates before the invoice date', () => {
    const validInput = inputFixture({ InvoiceDate: '2024-02-29', DueDate: '2024-03-01' });
    const valid = mapInvoiceDraft(recordFixture(validInput), binding, lookupFixture().lookup);
    const earlierInput = inputFixture({ InvoiceDate: '2026-02-14', DueDate: '2026-02-13' });
    const earlier = mapInvoiceDraft(recordFixture(earlierInput), binding, lookupFixture().lookup);

    expect(isBlocked(valid)).toBe(false);
    expect(isBlocked(earlier)).toBe(true);
  });

  it('requires source header dates and currency to exactly confirm the input', () => {
    const input = inputFixture();
    const source = withSource(input, {
      InvoiceDate: '2026-01-16',
      Currency: 'USD',
    });
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['discount', {}, { Discount: 1 }],
    ['house work', {}, { HouseWork: true }],
    ['cost center', {}, { CostCenter: 'CC-1' }],
    ['project', {}, { Project: 'P-1' }],
    ['header cost center', { CostCenter: 'CC-1' }, {}],
    ['header project', { Project: 'P-1' }, {}],
  ])('rejects unsupported source semantics: %s', (_label, headerOverrides, rowOverrides) => {
    const input = inputFixture();
    const source = withSource(input, headerOverrides, rowOverrides);
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it.each([
    ['non-cash accounting', { AccountingMethod: 'ACCRUAL' }],
    ['foreign invoice type', { InvoiceType: 'CREDIT' }],
    ['foreign country', { Country: 'Sweden' }],
    ['booked invoice', { Booked: true }],
    ['sent invoice', { Sent: true }],
    ['cancelled invoice', { Cancelled: true }],
    ['credit invoice', { Credit: true }],
    ['VAT included', { VATIncluded: true }],
    ['exchange rate', { CurrencyRate: 2 }],
    ['currency unit', { CurrencyUnit: 100 }],
    ['administration fee', { AdministrationFee: 1 }],
    ['administration fee VAT', { AdministrationFeeVAT: 1 }],
    ['freight', { Freight: 1 }],
    ['freight VAT', { FreightVAT: 1 }],
    ['round off', { RoundOff: 0.01 }],
    ['tax reduction', { TaxReduction: 1 }],
    ['header house work', { HouseWork: true }],
  ])('rejects unsupported source header semantics: %s', (_label, sourceOverrides) => {
    const input = inputFixture();
    const source = withSource(input, sourceOverrides);
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it('accepts only the explicit Credit false string alias', () => {
    const input = inputFixture();
    const source = withSource(input, { Credit: 'false' });

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
    ).toBe(false);
  });

  it('accepts empty or absent source dimensions and catalog links', () => {
    const input = inputFixture();
    const source = withSource(
      input,
      { CostCenter: undefined, Project: undefined },
      { CostCenter: undefined, Project: undefined, ArticleNumber: undefined },
    );

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
    ).toBe(false);
  });

  it('rejects non-SEK input currency and non-25-percent input VAT', () => {
    const baseRow = (inputFixture().InvoiceRows as DraftRow[])[0]!;
    const currencyInput = inputFixture({ Currency: 'USD' });
    const vatInput = inputFixture({ InvoiceRows: [{ ...baseRow, VAT: 20 }] });

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(currencyInput), binding, lookupFixture().lookup)),
    ).toBe(true);
    expect(
      isBlocked(mapInvoiceDraft(recordFixture(vatInput), binding, lookupFixture().lookup)),
    ).toBe(true);
  });

  it('requires source header and row totals to match the computed integer-cent amounts', () => {
    const input = inputFixture();
    const headerMismatch = withSource(input, { TotalToPay: 2499.99 });
    const rowMismatch = withSource(input, {}, { TotalExcludingVAT: 1999.99 });
    const mismatchHeader = mapInvoiceDraft(
      recordFixture(input, headerMismatch),
      binding,
      lookupFixture().lookup,
    );
    const mismatchRow = mapInvoiceDraft(
      recordFixture(input, rowMismatch),
      binding,
      lookupFixture().lookup,
    );

    expect(isBlocked(mismatchHeader)).toBe(true);
    expect(isBlocked(mismatchRow)).toBe(true);
  });

  it.each(['Net', 'TotalVAT', 'Total', 'TotalToPay', 'Balance'] as const)(
    'rejects a mismatched source header total %s',
    (field) => {
      const input = inputFixture();
      const source = sourceFixture(input);
      source[field] = Number(source[field]) + 0.01;

      expect(
        isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
      ).toBe(true);
    },
  );

  it.each(['Price', 'PriceExcludingVAT', 'TotalExcludingVAT', 'Total'] as const)(
    'rejects a mismatched source row amount %s',
    (field) => {
      const input = inputFixture();
      const source = withSource(input, {}, { [field]: 1999.99 });

      expect(
        isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
      ).toBe(true);
    },
  );

  it('requires numeric source money fields rather than parsing strings', () => {
    const input = inputFixture();
    const source = withSource(input, { Total: '2500' });

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
    ).toBe(true);
  });

  it.each([
    ['Description', { Description: 'Other service' }],
    ['DeliveredQuantity', { DeliveredQuantity: '02' }],
    ['DeliveredQuantity value', { DeliveredQuantity: 3 }],
    ['Unit', { Unit: 'kg' }],
    ['VAT', { VAT: 20 }],
  ])('rejects a source row that does not match input %s', (_label, rowOverrides) => {
    const input = inputFixture();
    const source = withSource(input, {}, rowOverrides);

    expect(
      isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
    ).toBe(true);
  });

  it('rejects unpadded, zero, negative, fractional, and unsafe source document numbers', () => {
    const input = inputFixture();
    const invalid = ['01001', '0', '-1', '1.5', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

    for (const DocumentNumber of invalid) {
      const source = withSource(input, { DocumentNumber });
      expect(
        isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
      ).toBe(true);
    }
  });

  it('accepts the maximum supported quantity and unit price with safe cent totals', () => {
    const input = inputFixture({
      InvoiceRows: [
        {
          Description: 'Maximum supported draft',
          DeliveredQuantity: 10_000,
          Price: 1_000_000,
          VAT: 25,
          Unit: 'st',
        },
      ],
    });
    const result = mapInvoiceDraft(recordFixture(input), binding, lookupFixture().lookup);

    expect(isBlocked(result)).toBe(false);
    if (!isBlocked(result)) {
      expect(result.expected.subtotal).toBe(10_000_000_000);
      expect(result.expected.vat_amount).toBe(2_500_000_000);
      expect(result.expected.total).toBe(12_500_000_000);
    }
  });

  it.each([
    ['blank customer identity', ''],
    ['leading padded customer identity', ' C-100'],
    ['trailing padded customer identity', 'C-100 '],
    ['control character in customer identity', 'C-\u0000100'],
    ['overlong customer identity', 'x'.repeat(201)],
  ])('rejects %s before lookup', (_label, CustomerNumber) => {
    const input = inputFixture({ CustomerNumber });
    const calls = lookupFixture();

    const result = mapInvoiceDraft(recordFixture(input), binding, calls.lookup);

    expect(isBlocked(result)).toBe(true);
    expect(calls.calls).toEqual([]);
    if (isBlocked(result) && CustomerNumber) expect(result.blocked).not.toContain(CustomerNumber);
  });

  it('requires the source customer identity to exactly match the validated input', () => {
    const input = inputFixture();
    const source = withSource(input, { CustomerNumber: 'C-OTHER' });
    const calls = lookupFixture();

    expect(isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, calls.lookup))).toBe(
      true,
    );
    expect(calls.calls).toEqual([]);
  });

  it('accepts an explicit string account only when it matches the confirmed class-3 account', () => {
    const baseRow = (inputFixture().InvoiceRows as DraftRow[])[0]!;
    const input = inputFixture({ InvoiceRows: [{ ...baseRow, AccountNumber: '3001' }] });
    const numericSource = sourceFixture(input);
    const result = mapInvoiceDraft(
      recordFixture(input, numericSource),
      binding,
      lookupFixture().lookup,
    );
    const wrongAccount = withSource(input, {}, { AccountNumber: 3002 });
    const mismatch = mapInvoiceDraft(
      recordFixture(input, wrongAccount),
      binding,
      lookupFixture().lookup,
    );

    expect(isBlocked(result)).toBe(false);
    expect(isBlocked(mismatch)).toBe(true);

    const numericInput = inputFixture({ InvoiceRows: [{ ...baseRow, AccountNumber: 3001 }] });
    expect(
      isBlocked(mapInvoiceDraft(recordFixture(numericInput), binding, lookupFixture().lookup)),
    ).toBe(true);
  });

  it.each([3000, 3001, '3001'])('normalizes a confirmed class-3 account %s', (AccountNumber) => {
    const input = inputFixture();
    const source = withSource(input, {}, { AccountNumber });
    const result = mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup);

    expect(isBlocked(result)).toBe(false);
    if (!isBlocked(result))
      expect(result.request.items[0]?.revenue_account).toBe(String(AccountNumber));
  });

  it.each([2999, 4000, '04001', '3001x', 30.01, Number.NaN])(
    'rejects invalid source class-3 account %s',
    (AccountNumber) => {
      const input = inputFixture();
      const source = withSource(input, {}, { AccountNumber });

      expect(
        isBlocked(mapInvoiceDraft(recordFixture(input, source), binding, lookupFixture().lookup)),
      ).toBe(true);
    },
  );

  it.each([
    [0, 'zero quantity'],
    [-1, 'negative quantity'],
    [1.5, 'fractional quantity'],
    [10001, 'quantity over cap'],
    [Number.MAX_SAFE_INTEGER, 'unsafe quantity'],
  ])('rejects %s (%s)', (DeliveredQuantity) => {
    const baseRow = (inputFixture().InvoiceRows as DraftRow[])[0]!;
    const input = inputFixture({
      InvoiceRows: [{ ...baseRow, DeliveredQuantity }],
    });

    expect(isBlocked(mapInvoiceDraft(recordFixture(input), binding, lookupFixture().lookup))).toBe(
      true,
    );
  });

  it.each([
    [0, 'zero price'],
    [-0.01, 'negative price'],
    [1000000.01, 'price over cap'],
    [1000000.0000000001, 'price just over cap'],
    [0.001, 'sub-cent price'],
    [Number.NaN, 'NaN price'],
    [Number.POSITIVE_INFINITY, 'infinite price'],
    [Number.MAX_VALUE, 'unsafe price'],
  ])('rejects %s (%s)', (Price) => {
    const baseRow = (inputFixture().InvoiceRows as DraftRow[])[0]!;
    const input = inputFixture({ InvoiceRows: [{ ...baseRow, Price }] });

    expect(isBlocked(mapInvoiceDraft(recordFixture(input), binding, lookupFixture().lookup))).toBe(
      true,
    );
  });

  it('blocks all non-ready, wrong-resource, wrong-binding, and invalid-UUID customer lookups', () => {
    const invalidLookups: ShadowIdentityResolution[] = [
      { state: 'missing' },
      { state: 'unresolved', intentIds: ['customer-intent'], reason: 'private' },
      { state: 'conflict', intentIds: ['a', 'b'], reason: 'private' },
      readyIdentity({ resource: 'supplier' }),
      readyIdentity({ sourceId: 'OTHER' }),
      readyIdentity({ sourceCompany: 'other-source' }),
      readyIdentity({ targetCompany: 'other-target' }),
      readyIdentity({ targetId: 'not-a-uuid' }),
    ];

    for (const resolution of invalidLookups) {
      const result = mapInvoiceDraft(recordFixture(), binding, lookupFixture(resolution).lookup);

      expect(isBlocked(result)).toBe(true);
      if (isBlocked(result)) {
        expect(result.blocked).not.toContain('C-100');
        expect(result.blocked).not.toContain('private');
      }
    }
  });

  it('propagates trusted lookup failures instead of converting them to a mapping refusal', () => {
    const failure = new Error('trusted lookup failure');

    expect(() =>
      mapInvoiceDraft(recordFixture(), binding, () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});
