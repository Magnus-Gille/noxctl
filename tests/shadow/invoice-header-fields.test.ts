import { describe, expect, it } from 'vitest';
import {
  INVOICE_REFUSAL,
  mapInvoiceDraft,
  preflightInvoiceDraft,
} from '../../src/shadow/invoice-draft-mapping.js';
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

function lookupFor(sourceCustomer?: Obj) {
  return (kind: ShadowResourceKind): ShadowIdentityResolution => ({
    state: 'ready',
    resource: kind,
    sourceId: '7',
    targetId: customerId,
    intentId: 'customer-intent',
    requestHash: 'customer-hash',
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
      ...sourceCustomer,
    } as never,
  });
}

function map(headerPatch: Obj = {}, sourceCustomer?: Obj) {
  return mapInvoiceDraft(record(headerPatch), binding, lookupFor(sourceCustomer));
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

  it('maps YourOrderNumber verbatim to invoice_marking', () => {
    const result = map({ YourOrderNumber: ' PO-1 ' });
    if ('blocked' in result) throw new Error(result.blocked);
    expect(result.request).toMatchObject({ invoice_marking: ' PO-1 ' });
    expect(result.expected).toMatchObject({ invoice_marking: ' PO-1 ' });
  });

  it('accepts a 200-character YourOrderNumber and refuses a longer one', () => {
    expect('blocked' in map({ YourOrderNumber: 'x'.repeat(200) })).toBe(false);
    expect(map({ YourOrderNumber: 'x'.repeat(201) })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.yourOrderNumberTooLong),
    });
  });

  it.each([[''], [null], [undefined]])('omits empty value %j', (value) => {
    const result = map({
      OurReference: value,
      YourReference: value,
      Remarks: value,
      YourOrderNumber: value,
    });
    if ('blocked' in result) throw new Error(result.blocked);
    for (const target of [result.request, result.expected]) {
      expect(target).not.toHaveProperty('our_reference');
      expect(target).not.toHaveProperty('your_reference');
      expect(target).not.toHaveProperty('notes');
      expect(target).not.toHaveProperty('invoice_marking');
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
    vat_treatment: 'standard_25',
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

function expectedFor(headerPatch: Obj, sourceCustomer?: Obj) {
  const result = map(headerPatch, sourceCustomer);
  if ('blocked' in result) throw new Error(result.blocked);
  return result.expected;
}

describe('draft readback of text header fields', () => {
  const patch = {
    OurReference: 'Anna',
    YourReference: 'Erik',
    Remarks: 'Note',
    YourOrderNumber: 'PO-1',
    DeliveryDate: '2026-01-10',
  };
  const stored = {
    our_reference: 'Anna',
    your_reference: 'Erik',
    notes: 'Note',
    invoice_marking: 'PO-1',
    delivery_date: '2026-01-10',
  };

  it('accepts a draft that stores the mapped values', () => {
    expect(matchesDraft({ data: nativeDraft(stored) }, invoiceId, expectedFor(patch))).toBe(true);
  });

  it.each(['our_reference', 'your_reference', 'notes', 'invoice_marking', 'delivery_date'])(
    'blocks a mismatching %s',
    (key) => {
      expect(
        matchesDraft(
          { data: nativeDraft({ ...stored, [key]: 'other' }) },
          invoiceId,
          expectedFor(patch),
        ),
      ).toBe(false);
    },
  );

  it.each(['our_reference', 'your_reference', 'notes', 'invoice_marking', 'delivery_date'])(
    'blocks a missing %s',
    (key) => {
      const partial: Obj = { ...stored };
      delete partial[key];
      expect(matchesDraft({ data: nativeDraft(partial) }, invoiceId, expectedFor(patch))).toBe(
        false,
      );
    },
  );

  it.each(['our_reference', 'your_reference', 'notes', 'invoice_marking', 'delivery_date'])(
    'blocks a stored %s when none was requested',
    (key) => {
      expect(
        matchesDraft({ data: nativeDraft({ [key]: 'unexpected' }) }, invoiceId, expectedFor({})),
      ).toBe(false);
    },
  );

  it('accepts null or empty stored values when none was requested', () => {
    const empty = {
      our_reference: null,
      your_reference: '',
      notes: null,
      invoice_marking: '',
      delivery_date: null,
    };
    expect(matchesDraft({ data: nativeDraft(empty) }, invoiceId, expectedFor({}))).toBe(true);
  });
});

describe('invoice header allowlist', () => {
  it('refuses a populated unclassified header key and ignores an empty one', () => {
    expect(map({ SomeNewFortnoxKey: 'x' })).toEqual({
      blocked: expect.stringContaining(
        `${INVOICE_REFUSAL.fieldUnclassified}: populated source key SomeNewFortnoxKey`,
      ),
    });
    expect(map({ SomeNewFortnoxKey: 0 })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.fieldUnclassified),
    });
    expect('blocked' in map({ SomeNewFortnoxKey: '', Other: null, More: [] })).toBe(false);
  });

  it.each([0, '0', null])('treats a zero row Cost (%j) as neutral', (cost) => {
    const base = record();
    const source = base.sourceResult as Obj;
    const rows = source.InvoiceRows as Obj[];
    const patched = {
      ...base,
      sourceResult: { ...source, InvoiceRows: [{ ...rows[0], Cost: cost }] },
    };
    expect('blocked' in mapInvoiceDraft(patched, binding, lookupFor())).toBe(false);
  });

  it('refuses a nonzero row Cost', () => {
    const base = record();
    const source = base.sourceResult as Obj;
    const rows = source.InvoiceRows as Obj[];
    const patched = {
      ...base,
      sourceResult: { ...source, InvoiceRows: [{ ...rows[0], Cost: 12.5 }] },
    };
    expect(mapInvoiceDraft(patched, binding, lookupFor())).toEqual({
      blocked: expect.stringContaining(
        `${INVOICE_REFUSAL.fieldUnsupported}: row Cost is populated`,
      ),
    });
  });

  it('refuses a populated unclassified row key', () => {
    const base = record();
    const source = base.sourceResult as Obj;
    const rows = source.InvoiceRows as Obj[];
    const patched = {
      ...base,
      sourceResult: { ...source, InvoiceRows: [{ ...rows[0], Surprise: 'x' }] },
    };
    expect(mapInvoiceDraft(patched, binding, lookupFor())).toEqual({
      blocked: expect.stringContaining(
        `${INVOICE_REFUSAL.fieldUnclassified}: populated source row key Surprise`,
      ),
    });
  });

  it.each([
    'OfferReference',
    'TimeBasisReference',
    'ExternalInvoiceReference1',
    'ExternalInvoiceReference2',
    'InvoicePeriodStart',
    'InvoicePeriodEnd',
    'Labels',
    'NoxFinans',
    'EUQuarterlyReport',
    'NotCompleted',
    'Reminders',
    'LastRemindDate',
    'VoucherNumber',
    'VoucherSeries',
    'VoucherYear',
    'PaymentWay',
    'BasisTaxReduction',
    'TermsOfDelivery',
    'WayOfDelivery',
  ])('refuses populated %s and treats none markers as neutral', (field) => {
    const populatedValue =
      field === 'Labels'
        ? [{ Id: 1 }]
        : field.startsWith('No') || field.startsWith('EU') || field === 'NotCompleted'
          ? true
          : 'x';
    expect(map({ [field]: populatedValue })).toEqual({
      blocked: expect.stringContaining(
        field.endsWith('Reference') && !field.startsWith('External')
          ? INVOICE_REFUSAL.linkedDocumentUnsupported
          : INVOICE_REFUSAL.fieldUnsupported,
      ),
    });
    for (const none of ['', null, 0, '0', false, []]) {
      expect('blocked' in map({ [field]: none })).toBe(false);
    }
  });

  it('refuses a populated CreditInvoiceReference with its own code and treats none markers as neutral', () => {
    expect(map({ CreditInvoiceReference: '55' })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.creditReferenceUnsupported),
    });
    for (const none of ['', null, 0, '0', false, []]) {
      expect('blocked' in map({ CreditInvoiceReference: none })).toBe(false);
    }
  });

  it('refuses a credit invoice (Credit true) with its own code, even with a mirrored original', () => {
    for (const credit of [true, 'true']) {
      expect(map({ Credit: credit, CreditInvoiceReference: '55' })).toEqual({
        blocked: expect.stringContaining(INVOICE_REFUSAL.creditInvoiceUnsupported),
      });
    }
  });

  it('keeps explicitly derived Fortnox values neutral', () => {
    const result = map({
      '@url': 'https://example.test/x',
      ContributionPercent: 12,
      ContributionValue: 3,
      Gross: 125,
      EDIInformation: { EDIGlobalLocationNumber: '' },
      FinalPayDate: '',
      OutboundDate: '2026-01-02',
      PrintTemplate: 'standard',
      WarehouseReady: false,
    });
    expect('blocked' in result).toBe(false);
  });

  it('maps DeliveryDate to delivery_date and refuses a non-date', () => {
    const result = map({ DeliveryDate: '2026-01-10' });
    if ('blocked' in result) throw new Error(result.blocked);
    expect(result.request).toMatchObject({ delivery_date: '2026-01-10' });
    expect(result.expected).toMatchObject({ delivery_date: '2026-01-10' });
    expect(map({ DeliveryDate: '2026-02-30' })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.headerTextInvalid),
    });
    const empty = map({ DeliveryDate: '' });
    if ('blocked' in empty) throw new Error(empty.blocked);
    expect(empty.request).not.toHaveProperty('delivery_date');
  });
});

describe('invoice copies of customer data', () => {
  const customer = {
    Name: 'Synthetic AB',
    OrganisationNumber: '556000-0000',
    Phone1: '08-1',
    Phone2: '',
  };

  it('accepts OrganisationNumber, Phone1, Phone2 and CustomerName equal to the customer', () => {
    const copy = {
      OrganisationNumber: '556000-0000',
      Phone1: '08-1',
      Phone2: '',
      CustomerName: 'Synthetic AB',
    };
    expect('blocked' in map(copy, customer)).toBe(false);
  });

  it.each([
    ['OrganisationNumber', '556999-9999'],
    ['Phone1', '08-2'],
    ['Phone2', '08-3'],
    ['CustomerName', 'Other AB'],
  ])('refuses %s differing from the customer', (field, value) => {
    expect(map({ [field]: value }, customer)).toEqual({
      blocked: expect.stringContaining(`${INVOICE_REFUSAL.addressMismatch}: Invoice ${field}`),
    });
  });

  it('refuses a populated copy without customer evidence', () => {
    expect(map({ CustomerName: 'Synthetic AB' })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.addressMismatch),
    });
  });
});

describe('mandatory customer evidence', () => {
  const lookupWith = (evidence: unknown) => (kind: ShadowResourceKind) =>
    ({ ...lookupFor()(kind), sourceCustomer: evidence }) as ShadowIdentityResolution;
  const complete = {
    Name: '',
    OrganisationNumber: '',
    Phone1: '',
    Phone2: '',
    Address1: '',
    Address2: '',
    ZipCode: '',
    City: '',
  };

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty object', {}],
    ['missing key', { ...complete, City: undefined }],
    ['non-string value', { ...complete, Phone1: 5 }],
    ['array', []],
  ])('refuses %s evidence even when every invoice copy field is empty', (_label, evidence) => {
    expect(mapInvoiceDraft(record(), binding, lookupWith(evidence))).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.customerEvidenceMissing),
    });
  });

  it('accepts complete evidence and always puts mirrored_customer in the expectation', () => {
    const result = mapInvoiceDraft(record(), binding, lookupWith(complete));
    if ('blocked' in result) throw new Error(result.blocked);
    expect(result.expected.mirrored_customer).toEqual({
      name: '',
      org_number: '',
      phone: '',
      address_line1: '',
      address_line2: '',
      postal_code: '',
      city: '',
    });
  });

  it('fails draft readback when the expectation carries no mirrored customer', () => {
    const { mirrored_customer: _omitted, ...rest } = expectedFor({});
    expect(matchesDraft({ data: nativeDraft() }, invoiceId, rest as never)).toBe(false);
    expect(
      matchesDraft({ data: nativeDraft() }, invoiceId, { ...rest, mirrored_customer: {} } as never),
    ).toBe(false);
  });
});

describe('EmailInformation and EDIInformation', () => {
  it('treats EmailInformation as neutral when absent, null or any plain object', () => {
    for (const value of [
      undefined,
      null,
      {},
      {
        EmailAddressTo: 'a@example.test',
        EmailSubject: 'S',
        EmailBody: 'B',
        EmailAddressFrom: '',
        EmailAddressCC: 'c@example.test',
        EmailAddressBCC: 'b@example.test',
      },
    ]) {
      expect('blocked' in map({ EmailInformation: value })).toBe(false);
    }
  });

  it.each(['text', 5, true, ['x']])('refuses non-object EmailInformation %j', (value) => {
    expect(map({ EmailInformation: value })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.informationMalformed),
    });
  });

  it.each(['text', 5, true, ['x']])('refuses non-object EDIInformation %j', (value) => {
    expect(map({ EDIInformation: value })).toEqual({
      blocked: expect.stringContaining(INVOICE_REFUSAL.informationMalformed),
    });
  });

  it('accepts EDIInformation that is absent, null, empty, or only holds EDIStatus', () => {
    for (const value of [undefined, null, {}, { EDIStatus: 'SENT' }, { EDIStatus: '' }]) {
      expect('blocked' in map({ EDIInformation: value })).toBe(false);
    }
  });

  it.each([
    'EDIGlobalLocationNumber',
    'EDIGlobalLocationNumberDelivery',
    'EDIInvoiceExtra1',
    'EDIInvoiceExtra2',
    'EDIOurElectronicReference',
    'EDIYourElectronicReference',
  ])('refuses populated EDIInformation.%s and accepts it empty', (key) => {
    expect(map({ EDIInformation: { EDIStatus: 'X', [key]: 'v' } })).toEqual({
      blocked: expect.stringContaining(`${INVOICE_REFUSAL.ediUnsupported}: EDIInformation.${key}`),
    });
    for (const none of ['', null, undefined]) {
      expect('blocked' in map({ EDIInformation: { [key]: none } })).toBe(false);
    }
  });

  it('refuses a populated unknown nested EDI key and ignores an empty one', () => {
    expect(map({ EDIInformation: { EDINewField: 'v' } })).toEqual({
      blocked: expect.stringContaining(
        `${INVOICE_REFUSAL.fieldUnclassified}: populated source key EDIInformation.EDINewField`,
      ),
    });
    expect('blocked' in map({ EDIInformation: { EDINewField: '' } })).toBe(false);
  });
});

describe('live target customer drift on invoice readback', () => {
  const mirrored = {
    ...ADDRESS,
    Name: 'Synthetic AB',
    OrganisationNumber: '556000-0000',
    Phone1: '08-1',
    Phone2: '',
  };
  const live = {
    name: 'Synthetic AB',
    org_number: '556000-0000',
    phone: '08-1',
    address_line1: 'Testgatan 1',
    address_line2: 'c/o Test',
    postal_code: '11122',
    city: 'Teststad',
  };
  const customerWith = (patch: Obj) => {
    const base = nativeDraft();
    return { data: { ...base, customer: { ...base.customer, ...live, ...patch } } };
  };

  it('carries the mirrored customer into the expectation', () => {
    expect(expectedFor({}, mirrored)).toMatchObject({ mirrored_customer: live });
    expect(expectedFor({})).toHaveProperty('mirrored_customer');
  });

  it('accepts a target customer that still matches', () => {
    expect(matchesDraft(customerWith({}), invoiceId, expectedFor({}, mirrored))).toBe(true);
  });

  it.each(Object.keys(live))('blocks drift of target customer %s', (key) => {
    expect(
      matchesDraft(customerWith({ [key]: 'drifted' }), invoiceId, expectedFor({}, mirrored)),
    ).toBe(false);
  });

  it('blocks a target customer whose address was cleared', () => {
    expect(
      matchesDraft(customerWith({ address_line1: null }), invoiceId, expectedFor({}, mirrored)),
    ).toBe(false);
  });
});

describe('optional invoice text input', () => {
  function withInput(inputPatch: Obj, headerPatch: Obj = {}): ShadowRecord {
    const base = record(headerPatch);
    return { ...base, args: [{ ...(base.args[0] as Obj), ...inputPatch }] };
  }
  const text = {
    Remarks: 'Workshop days.\nSee agreement',
    YourReference: 'Kim Kund',
    OurReference: 'Sam Säljare',
  };

  it('accepts Remarks, YourReference and OurReference echoed by the source', () => {
    const result = mapInvoiceDraft(withInput(text, text), binding, lookupFor());
    if ('blocked' in result) throw new Error(result.blocked);
    for (const target of [result.request, result.expected]) {
      expect(target).toMatchObject({
        notes: text.Remarks,
        your_reference: text.YourReference,
        our_reference: text.OurReference,
      });
    }
  });

  it('passes preflight with the text input', () => {
    expect(preflightInvoiceDraft(withInput(text), binding, lookupFor())).toEqual({ ok: true });
  });

  it.each(Object.keys(text))('refuses a source that does not echo %s', (field) => {
    const result = mapInvoiceDraft(
      withInput(text, { ...text, [field]: 'changed' }),
      binding,
      lookupFor(),
    );
    expect(result).toEqual({
      blocked: expect.stringContaining(`confirmed source ${field} does not match`),
    });
  });

  it.each([
    ['Remarks', 'x'.repeat(1025)],
    ['YourReference', 'x'.repeat(51)],
    ['OurReference', 'x'.repeat(51)],
    ['Remarks', ''],
    ['YourReference', 5],
    ['OurReference', null],
  ])('refuses invalid %s input %j in preflight and mapping', (field, value) => {
    const expected = { blocked: expect.stringContaining(INVOICE_REFUSAL.headerTextInvalid) };
    expect(preflightInvoiceDraft(withInput({ [field]: value }), binding, lookupFor())).toEqual(
      expected,
    );
    expect(
      mapInvoiceDraft(withInput({ [field]: value }, { [field]: value }), binding, lookupFor()),
    ).toEqual(expected);
  });

  it('accepts the maximum lengths', () => {
    const max = {
      Remarks: 'r'.repeat(1024),
      YourReference: 'y'.repeat(50),
      OurReference: 'o'.repeat(50),
    };
    expect(preflightInvoiceDraft(withInput(max), binding, lookupFor())).toEqual({ ok: true });
  });

  it('still refuses other header input such as YourOrderNumber', () => {
    expect(
      preflightInvoiceDraft(withInput({ YourOrderNumber: 'PO-1' }), binding, lookupFor()),
    ).toEqual({
      blocked: 'Unsupported invoice header fields: YourOrderNumber.',
    });
  });
});
