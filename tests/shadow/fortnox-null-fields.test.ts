import { describe, expect, it } from 'vitest';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};

type Obj = Record<string, unknown>;

function record(headerPatch: Obj = {}, rowPatch: Obj = {}): ShadowRecord {
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
        InvoiceRows: [
          { Description: 'Row', DeliveredQuantity: 1, Price: 100, VAT: 25, Unit: 'st' },
        ],
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
      CostCenter: '',
      Project: '',
      Net: 100,
      TotalVAT: 25,
      Total: 125,
      TotalToPay: 125,
      Balance: 125,
      InvoiceRows: [
        {
          Description: 'Row',
          DeliveredQuantity: 1,
          Price: 100,
          VAT: 25,
          Unit: 'st',
          PriceExcludingVAT: 100,
          TotalExcludingVAT: 100,
          Total: 100,
          Discount: 0,
          HouseWork: false,
          CostCenter: '',
          Project: '',
          ArticleNumber: '',
          AccountNumber: 3001,
          ...rowPatch,
        },
      ],
      ...headerPatch,
    },
  } as ShadowRecord;
}

function lookup(kind: ShadowResourceKind, id: string): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: kind,
    sourceId: id,
    targetId: '11111111-1111-4111-8111-111111111111',
    intentId: `${kind}-intent`,
    requestHash: 'creator-request-hash',
    ...binding,
  } as ShadowIdentityResolution;
}

const map = (r: ShadowRecord) => mapInvoiceDraft(r, binding, lookup);

describe('Fortnox null fields on the source invoice', () => {
  const baseline = map(record());

  it('baseline maps', () => {
    expect(baseline).toHaveProperty('request');
  });

  it('accepts TaxReduction null with no house work, identical to 0', () => {
    const result = map(
      record({ TaxReduction: null, TaxReductionType: 'none' }, { HouseWorkType: null }),
    );
    expect(result).toEqual(baseline);
  });

  it('accepts null CostCenter/Project on header and row, identical to ""', () => {
    const result = map(
      record({ CostCenter: null, Project: null }, { CostCenter: null, Project: null }),
    );
    expect(result).toEqual(baseline);
  });

  it('refuses TaxReduction null when a row has HouseWork', () => {
    expect(map(record({ TaxReduction: null }, { HouseWork: true }))).toHaveProperty('blocked');
  });

  it('refuses TaxReduction null when a row has a house-work type', () => {
    expect(map(record({ TaxReduction: null }, { HouseWorkType: 'ROT' }))).toHaveProperty('blocked');
  });

  it('refuses TaxReduction null when the invoice has a tax-reduction type or HouseWork', () => {
    expect(map(record({ TaxReduction: null, TaxReductionType: 'rot' }))).toHaveProperty('blocked');
    expect(map(record({ TaxReduction: null, HouseWork: true }))).toHaveProperty('blocked');
  });

  it('still refuses nonzero or malformed TaxReduction', () => {
    expect(map(record({ TaxReduction: 100 }))).toHaveProperty('blocked');
    expect(map(record({ TaxReduction: '0' }))).toHaveProperty('blocked');
    expect(map(record({ TaxReduction: undefined }))).toHaveProperty('blocked');
  });

  it('still refuses a nonempty dimension', () => {
    expect(map(record({ CostCenter: 'X' }))).toHaveProperty('blocked');
    expect(map(record({}, { Project: 'P' }))).toHaveProperty('blocked');
  });

  it('keeps null Discount strict', () => {
    expect(map(record({}, { Discount: null }))).toHaveProperty('blocked');
  });
});
