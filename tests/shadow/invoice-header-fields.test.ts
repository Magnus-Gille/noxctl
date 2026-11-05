import { describe, expect, it } from 'vitest';
import { INVOICE_REFUSAL, mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import { matchesDraft } from '../../src/shadow/invoice-draft-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';

type Obj = Record<string, unknown>;

function record(headerPatch: Obj = {}): ShadowRecord {
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
        },
      ],
      ...headerPatch,
    },
  };
}

const ADDRESS = {
  Address1: 'Testgatan 1',
  Address2: 'c/o Test',
  ZipCode: '11122',
  City: 'Teststad',
};

function lookupFor(sourceAddress?: Obj) {
  return (kind: ShadowResourceKind): ShadowIdentityResolution => ({
    state: 'ready',
    resource: kind,
    sourceId: '7',
    targetId: customerId,
    intentId: 'customer-intent',
    requestHash: 'customer-hash',
    ...binding,
    ...(sourceAddress ? { sourceAddress: sourceAddress as never } : {}),
  });
}

function map(headerPatch: Obj = {}, sourceAddress?: Obj) {
  return mapInvoiceDraft(record(headerPatch), binding, lookupFor(sourceAddress));
}

describe('invoice text header fields', () => {
  it('maps OurReference, YourReference and Remarks verbatim into request and expectation', () => {
    const result = map({ OurReference: ' Anna ', YourReference: 'Erik', Remarks: 'Line1\nLine2 ' });
    if ('blocked' in result) throw new Error(result.blocked);
    for (const target of [result.request, result.expected]) {
      expect(target).toMatchObject({
        our_reference: ' Anna ',
        your_reference: 'Erik',
        notes: 'Line1\nLine2 ',
      });
    }
  });

  it.each([[''], [null], [undefined]])('omits empty value %j', (value) => {
    const result = map({ OurReference: value, YourReference: value, Remarks: value });
    if ('blocked' in result) throw new Error(result.blocked);
    for (const target of [result.request, result.expected]) {
      expect(target).not.toHaveProperty('our_reference');
      expect(target).not.toHaveProperty('your_reference');
      expect(target).not.toHaveProperty('notes');
    }
  });

  it('refuses a non-string text value', () => {
    expect(map({ Remarks: 5 })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.headerTextInvalid),
    });
  });
});

describe('unsupported invoice header fields', () => {
  it.each([
    ['YourOrderNumber', INVOICE_REFUSAL.yourOrderNumberUnsupported],
    ['Comments', INVOICE_REFUSAL.commentsUnsupported],
    ['DeliveryName', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['DeliveryAddress1', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['DeliveryAddress2', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['DeliveryZipCode', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['DeliveryCity', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['DeliveryCountry', INVOICE_REFUSAL.deliveryAddressUnsupported],
    ['InvoiceReference', INVOICE_REFUSAL.linkedDocumentUnsupported],
    ['OrderReference', INVOICE_REFUSAL.linkedDocumentUnsupported],
    ['ContractReference', INVOICE_REFUSAL.linkedDocumentUnsupported],
  ])('refuses populated %s with %s', (field, reason) => {
    const result = map({ [field]: field.endsWith('Reference') ? '55' : 'populated' });
    expect(result).toEqual({ blocked: expect.stringContaining(reason) });
  });

  it.each([[''], [null], [undefined], [0], ['0']])(
    'accepts neutral linked-document value %j and empty others',
    (value) => {
      const result = map({
        InvoiceReference: value,
        OrderReference: value,
        ContractReference: value,
        YourOrderNumber: '',
        Comments: null,
        DeliveryName: '',
      });
      expect('blocked' in result).toBe(false);
    },
  );

  it('treats Fortnox-derived defaults as neutral', () => {
    const result = map({
      OCR: '1234567890',
      TermsOfPayment: '30',
      PriceList: 'A',
      Language: 'SV',
      EmailInformation: { EmailAddressFrom: '', EmailAddressTo: '' },
      CustomerName: 'Synthetic AB',
    });
    expect('blocked' in result).toBe(false);
  });
});

describe('invoice address', () => {
  it('accepts an empty invoice address without customer address evidence', () => {
    expect('blocked' in map()).toBe(false);
  });

  it('accepts a populated address equal to the mirrored customer address', () => {
    expect('blocked' in map(ADDRESS, ADDRESS)).toBe(false);
  });

  it('accepts a partly populated address when empty parts are empty on the customer', () => {
    const partial = { Address1: 'Testgatan 1', ZipCode: '11122', City: 'Teststad' };
    expect('blocked' in map(partial, { ...partial, Address2: '' })).toBe(false);
  });

  it.each([
    ['Address1', 'Annangatan 2'],
    ['ZipCode', '99999'],
    ['City', 'Annanstad'],
    ['Address2', ''],
  ])('refuses a differing %s', (field, value) => {
    expect(map(ADDRESS, { ...ADDRESS, [field]: value })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.addressMismatch),
    });
  });

  it('refuses a populated address when the customer address evidence is absent', () => {
    expect(map(ADDRESS)).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.addressMismatch),
    });
  });
});

function nativeDraft(extra: Obj = {}) {
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
        description: 'Row',
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
    ...extra,
  };
}

function expectedFor(headerPatch: Obj) {
  const result = map(headerPatch);
  if ('blocked' in result) throw new Error(result.blocked);
  return result.expected;
}

describe('draft readback of text header fields', () => {
  const patch = { OurReference: 'Anna', YourReference: 'Erik', Remarks: 'Note' };
  const stored = { our_reference: 'Anna', your_reference: 'Erik', notes: 'Note' };

  it('accepts a draft that stores the mapped values', () => {
    expect(matchesDraft({ data: nativeDraft(stored) }, invoiceId, expectedFor(patch))).toBe(true);
  });

  it.each(['our_reference', 'your_reference', 'notes'])('blocks a mismatching %s', (key) => {
    expect(
      matchesDraft(
        { data: nativeDraft({ ...stored, [key]: 'other' }) },
        invoiceId,
        expectedFor(patch),
      ),
    ).toBe(false);
  });

  it.each(['our_reference', 'your_reference', 'notes'])('blocks a missing %s', (key) => {
    const partial: Obj = { ...stored };
    delete partial[key];
    expect(matchesDraft({ data: nativeDraft(partial) }, invoiceId, expectedFor(patch))).toBe(false);
  });

  it.each(['our_reference', 'your_reference', 'notes'])(
    'blocks a stored %s when none was requested',
    (key) => {
      expect(
        matchesDraft({ data: nativeDraft({ [key]: 'unexpected' }) }, invoiceId, expectedFor({})),
      ).toBe(false);
    },
  );

  it('accepts null or empty stored values when none was requested', () => {
    const empty = { our_reference: null, your_reference: '', notes: null };
    expect(matchesDraft({ data: nativeDraft(empty) }, invoiceId, expectedFor({}))).toBe(true);
  });
});
