import { describe, expect, it } from 'vitest';
import { INVOICE_REFUSAL, mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';

function record(sourceOverrides: Record<string, unknown>): ShadowRecord {
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
    requestHash: 'h',
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
      Net: 100,
      TotalVAT: 25,
      Total: 125,
      TotalToPay: 125,
      Balance: 125,
      InvoiceRows: [
        {
          Description: 'Row',
          DeliveredQuantity: '1',
          Price: 100,
          PriceExcludingVAT: 100,
          TotalExcludingVAT: 100,
          Total: 100,
          VAT: 25,
          Unit: 'st',
          AccountNumber: 3001,
          Discount: 0,
          HouseWork: false,
          CostCenter: '',
          Project: '',
          ArticleNumber: '',
        },
      ],
      ...sourceOverrides,
    },
  } as ShadowRecord;
}

const ready = (kind: ShadowResourceKind, id: string): ShadowIdentityResolution =>
  ({
    state: 'ready',
    resource: kind,
    sourceId: id,
    targetId: customerId,
    intentId: `${kind}-intent`,
    requestHash: 'customer-hash',
    ...binding,
  }) as ShadowIdentityResolution;
const missing = (kind: ShadowResourceKind, id: string): ShadowIdentityResolution =>
  ({ state: 'missing', resource: kind, sourceId: id }) as unknown as ShadowIdentityResolution;

describe('invoice Country', () => {
  it('maps Sverige and an empty Country identically for a resolved Swedish customer', () => {
    const a = mapInvoiceDraft(record({ Country: 'Sverige' }), binding, ready);
    const b = mapInvoiceDraft(record({ Country: '' }), binding, ready);
    expect(a).not.toHaveProperty('blocked');
    expect(b).toEqual(a);
  });

  it('still requires a resolved customer identity when Country is empty', () => {
    expect(mapInvoiceDraft(record({ Country: '' }), binding, missing)).toHaveProperty('blocked');
  });

  it.each(['Norge', 'Germany', ' ', 'SE', null, undefined])('refuses Country %j', (country) => {
    const result = mapInvoiceDraft(record({ Country: country }), binding, ready);
    expect(result).toHaveProperty('blocked');
  });
});

describe('invoice RoundOff', () => {
  it.each([0.25, -0.4, '0'])('refuses RoundOff %j with a stable reason', (roundOff) => {
    const result = mapInvoiceDraft(record({ RoundOff: roundOff }), binding, ready);
    expect(result).toHaveProperty('blocked');
    expect((result as { blocked: string }).blocked).toMatch(
      new RegExp(`^${INVOICE_REFUSAL.roundoffUnsupported}:`),
    );
  });

  it('accepts a zero RoundOff', () => {
    expect(mapInvoiceDraft(record({ RoundOff: 0 }), binding, ready)).not.toHaveProperty('blocked');
  });
});
