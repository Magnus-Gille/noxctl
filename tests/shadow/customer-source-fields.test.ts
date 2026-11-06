import { describe, expect, it } from 'vitest';
import type { ShadowRecord } from '../../src/shadow/types.js';
import {
  AccountedShadowAdapter,
  CUSTOMER_FIELD_UNCLASSIFIED,
  CUSTOMER_FIELD_UNSUPPORTED,
} from '../../src/shadow/accounted-adapter.js';

const base = {
  CustomerNumber: 'C-100',
  Name: 'Exempel AB',
  Type: 'COMPANY',
  VATType: 'SEVAT',
  Currency: 'SEK',
  CountryCode: 'SE',
  Country: 'Sverige',
};

function prepare(over: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const source = { ...base, ...over };
  const record: ShadowRecord = {
    id: 'i',
    version: 1,
    operation: 'createCustomer',
    args: [{ Name: source.Name, ...args }],
    sourceCompany: 's',
    targetCompany: 'company-123',
    requestHash: 'h',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: source,
  };
  const adapter = new AccountedShadowAdapter(
    'company-123',
    async () => ({ status: 200, body: {} }) as never,
  );
  return adapter.prepare(record) as Record<string, unknown>;
}

const populated = {
  OrganisationNumber: '556000-0000',
  Email: 'kontakt@example.test',
  Phone1: '08-123 45 67',
  Address1: 'Testgatan 1',
  Address2: 'c/o Test',
  ZipCode: '11122',
  City: 'Teststad',
  VATNumber: 'SE556000000001',
};

describe('customer source-only fields', () => {
  it('maps every populated supported source field even when the input omits it', () => {
    expect(prepare(populated)).toEqual({
      request: {
        name: 'Exempel AB',
        customer_type: 'swedish_business',
        country: 'SE',
        customer_number: 'C-100',
        org_number: '556000-0000',
        email: 'kontakt@example.test',
        phone: '08-123 45 67',
        address_line1: 'Testgatan 1',
        address_line2: 'c/o Test',
        postal_code: '11122',
        city: 'Teststad',
        vat_number: 'SE556000000001',
      },
    });
  });

  it('omits empty, null and absent source fields', () => {
    const result = prepare({ Email: '', Phone1: null, Address1: undefined, City: 'Teststad' });
    expect(result.request).toEqual({
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: 'C-100',
      city: 'Teststad',
    });
  });

  it('still requires input/source equality for fields present in the input', () => {
    expect(prepare(populated, { City: 'Annanstad' })).toEqual({
      blocked: 'Confirmed source value is missing or inconsistent for City.',
    });
  });

  it('refuses a source-only Email the target schema would reject', () => {
    expect(prepare({ Email: 'not-an-email' })).toEqual({
      blocked: 'Email is not accepted by the Accounted customer schema.',
    });
  });

  it.each([
    'GLN',
    'GLNDelivery',
    'DeliveryCountryCode',
    'DeliveryFax',
    'DeliveryPhone1',
    'DeliveryPhone2',
    'ExternalReference',
    'InvoiceRemark',
    'SalesAccount',
    'InvoiceAdministrationFee',
    'InvoiceDiscount',
    'InvoiceFreight',
    'ShowPriceVATIncluded',
    'TermsOfDelivery',
    'WayOfDelivery',
    'CostCenter',
    'Project',
    'DeliveryName',
    'DeliveryAddress1',
    'DeliveryAddress2',
    'DeliveryZipCode',
    'DeliveryCity',
    'DeliveryCountry',
    'EmailOfferCC',
    'EmailOfferBCC',
    'EmailOrderCC',
    'EmailOrderBCC',
    'Phone2',
    'Fax',
  ])('refuses populated unmappable %s', (field) => {
    expect(prepare({ [field]: 'populated' })).toEqual({
      blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: populated source ${field}`),
    });
  });

  it('keeps Fortnox defaults and empty unmappable fields neutral', () => {
    const result = prepare({
      TermsOfPayment: '30',
      PriceList: 'A',
      DeliveryName: '',
      EmailInvoice: null,
      Comments: '',
      EmailInvoiceCC: '',
    });
    expect(result).toHaveProperty('request');
  });

  it('treats EmailInvoice/EmailOffer/EmailOrder equal to Email as neutral (nothing extra mapped)', () => {
    const result = prepare({
      Email: 'a@example.test',
      EmailInvoice: 'a@example.test',
      EmailOffer: 'a@example.test',
      EmailOrder: 'a@example.test',
    });
    expect(result.request).toEqual({
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: 'C-100',
      email: 'a@example.test',
    });
  });

  it.each([
    [{ Email: 'a@example.test', EmailInvoice: 'b@example.test' }],
    [{ Email: '', EmailInvoice: 'b@example.test' }],
    [{ EmailInvoice: 'b@example.test' }],
  ])('refuses EmailInvoice differing from Email %j', (over) => {
    expect(prepare(over)).toEqual({
      blocked: expect.stringContaining(
        `${CUSTOMER_FIELD_UNSUPPORTED}: source EmailInvoice differs`,
      ),
    });
  });

  it.each(['EmailOffer', 'EmailOrder'])('refuses %s differing from Email', (field) => {
    expect(prepare({ Email: 'a@example.test', [field]: 'b@example.test' })).toEqual({
      blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: source ${field} differs`),
    });
    expect(prepare({ [field]: 'b@example.test' })).toEqual({
      blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: source ${field} differs`),
    });
  });

  it('maps EmailInvoiceCC/BCC to address arrays, split on commas and semicolons', () => {
    const result = prepare({
      EmailInvoiceCC: 'c1@example.test; c2@example.test',
      EmailInvoiceBCC: 'b1@example.test,b2@example.test',
    });
    expect(result.request).toMatchObject({
      invoice_email_cc_addresses: ['c1@example.test', 'c2@example.test'],
      invoice_email_bcc_addresses: ['b1@example.test', 'b2@example.test'],
    });
  });

  it.each(['not-an-email', 'a@example.test;', 'a@example.test;bad', ';'])(
    'refuses invalid copy list %j',
    (value) => {
      expect(prepare({ EmailInvoiceCC: value })).toEqual({
        blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: source EmailInvoiceCC`),
      });
    },
  );

  it('refuses more than 19 copy recipients in total', () => {
    const list = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => `${p}${i}@example.test`).join(';');
    expect(
      'request' in prepare({ EmailInvoiceCC: list(10, 'c'), EmailInvoiceBCC: list(9, 'b') }),
    ).toBe(true);
    expect(prepare({ EmailInvoiceCC: list(10, 'c'), EmailInvoiceBCC: list(10, 'b') })).toEqual({
      blocked: expect.stringContaining('more than 19'),
    });
  });

  it('maps Comments verbatim to notes', () => {
    expect(prepare({ Comments: ' Hello\nworld ' }).request).toMatchObject({
      notes: ' Hello\nworld ',
    });
  });
});

describe('customer notes composed from source-only fields (NOX-210)', () => {
  const notesOf = (over: Record<string, unknown>) =>
    (prepare(over).request as Record<string, unknown> | undefined)?.notes;

  it('maps OurReference alone', () => {
    expect(notesOf({ OurReference: 'Anna' })).toBe('Vår referens: Anna');
  });
  it('maps WWW alone', () => {
    expect(notesOf({ WWW: 'https://example.test' })).toBe('Webb: https://example.test');
  });
  it('maps a visiting address alone', () => {
    expect(
      notesOf({
        VisitingAddress: 'Besöksgatan 2',
        VisitingZipCode: '11144',
        VisitingCity: 'Uppsala',
        VisitingCountry: 'Sverige',
      }),
    ).toBe('Besöksadress: Besöksgatan 2, 11144 Uppsala, Sverige');
  });
  it('composes everything in fixed order after multi-line Comments', () => {
    expect(
      notesOf({
        VisitingCity: 'Uppsala',
        WWW: 'https://example.test',
        VisitingZipCode: '11144',
        OurReference: 'Anna',
        Comments: 'Rad 1\nRad 2 ',
        VisitingAddress: 'Besöksgatan 2',
        VisitingCountryCode: 'SE',
      }),
    ).toBe(
      'Rad 1\nRad 2 \nVår referens: Anna\nWebb: https://example.test\nBesöksadress: Besöksgatan 2, 11144 Uppsala, SE',
    );
  });
  it('prefers VisitingCountry over VisitingCountryCode without duplicating', () => {
    expect(notesOf({ VisitingCountry: 'Norge', VisitingCountryCode: 'NO' })).toBe(
      'Besöksadress: Norge',
    );
    expect(notesOf({ VisitingCountryCode: 'NO' })).toBe('Besöksadress: NO');
  });
  it('handles partial zip/city', () => {
    expect(notesOf({ VisitingZipCode: '11144' })).toBe('Besöksadress: 11144');
    expect(notesOf({ VisitingCity: 'Uppsala' })).toBe('Besöksadress: Uppsala');
  });
  it('omits notes when nothing is populated', () => {
    expect(notesOf({ OurReference: '', WWW: null, VisitingAddress: undefined })).toBeUndefined();
  });
  it.each([
    'OurReference',
    'WWW',
    'VisitingAddress',
    'VisitingZipCode',
    'VisitingCity',
    'VisitingCountry',
    'VisitingCountryCode',
  ])('blocks non-string %s', (key) => {
    expect(prepare({ [key]: 5 })).toEqual({
      blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source ${key} must be a string.`,
    });
  });
  it.each([
    'a\nb',
    'a\rb',
    ' padded',
    'padded ',
    '\tx',
    'a\u2028b',
    'a\u2029b',
    'a\u0085b',
    'a\u000bb',
    'a\u000cb',
    'a\tb',
    'a\u0000b',
    'a\u007fb',
  ])('blocks multi-line, control-character or padded labelled value %j', (value) => {
    for (const key of [
      'OurReference',
      'WWW',
      'VisitingAddress',
      'VisitingZipCode',
      'VisitingCity',
      'VisitingCountry',
      'VisitingCountryCode',
    ]) {
      expect(prepare({ [key]: value })).toEqual({
        blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: source ${key}`),
      });
    }
  });
  it('still refuses GLN and GLNDelivery', () => {
    for (const f of ['GLN', 'GLNDelivery'])
      expect(prepare({ [f]: '123', OurReference: 'A' })).toEqual({
        blocked: expect.stringContaining(`populated source ${f}`),
      });
  });
});

describe('customer readback of array and notes fields', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const body = {
    name: 'Exempel AB',
    customer_type: 'swedish_business',
    country: 'SE',
    customer_number: 'C-100',
    invoice_email_cc_addresses: ['c1@example.test'],
    notes: 'N',
  };
  function run(stored: Record<string, unknown>) {
    const adapter = new AccountedShadowAdapter('company-123', async (req) =>
      req.method === 'POST'
        ? { status: 201, json: { data: { id, ...body } } }
        : { status: 200, json: { data: { id, ...stored } } },
    );
    const record = {
      id: 'i',
      version: 1,
      operation: 'createCustomer',
      args: [{ Name: 'Exempel AB' }],
      sourceCompany: 's',
      targetCompany: 'company-123',
      requestHash: 'h',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1,
      sourceResult: { ...base, EmailInvoiceCC: 'c1@example.test', Comments: 'N' },
    } as ShadowRecord;
    return adapter.apply(record, body);
  }
  it('accepts equal arrays and notes', async () => {
    await expect(run(body)).resolves.toMatchObject({ targetId: id });
  });
  it('verifies composed notes exactly', async () => {
    const composed = 'N\nVår referens: Anna\nWebb: https://example.test';
    const b = { ...body, notes: composed };
    const adapter = new AccountedShadowAdapter('company-123', async (req) =>
      req.method === 'POST'
        ? { status: 201, json: { data: { id, ...b } } }
        : { status: 200, json: { data: { id, ...b, notes: 'N\nVår referens: Anna' } } },
    );
    const record = {
      id: 'i',
      version: 1,
      operation: 'createCustomer',
      args: [{ Name: 'Exempel AB' }],
      sourceCompany: 's',
      targetCompany: 'company-123',
      requestHash: 'h',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1,
      sourceResult: {
        ...base,
        EmailInvoiceCC: 'c1@example.test',
        Comments: 'N',
        OurReference: 'Anna',
        WWW: 'https://example.test',
      },
    } as ShadowRecord;
    await expect(adapter.apply(record, b)).rejects.toThrow();
  });
  it.each([
    [{ ...body, invoice_email_cc_addresses: ['other@example.test'] }],
    [{ ...body, invoice_email_cc_addresses: null }],
    [{ ...body, notes: 'X' }],
  ])('blocks a differing readback', async (stored) => {
    await expect(run(stored)).rejects.toThrow();
  });
});

describe('customer allowlist', () => {
  it('refuses a populated unclassified key (including 0/false) and ignores empty ones', () => {
    for (const value of ['x', 0, false]) {
      expect(prepare({ BrandNewKey: value })).toEqual({
        blocked: expect.stringContaining(
          `${CUSTOMER_FIELD_UNCLASSIFIED}: populated source key BrandNewKey`,
        ),
      });
    }
    expect(prepare({ BrandNewKey: '', Other: null, More: [] })).toHaveProperty('request');
  });

  it.each([
    ['SalesAccount', 0],
    ['InvoiceAdministrationFee', 0],
    ['InvoiceDiscount', 0],
    ['InvoiceFreight', 0],
    ['ShowPriceVATIncluded', false],
  ])('treats %s=%j as none', (field, value) => {
    expect(prepare({ [field]: value })).toHaveProperty('request');
    expect(prepare({ [field]: field === 'ShowPriceVATIncluded' ? true : 5 })).toEqual({
      blocked: expect.stringContaining(CUSTOMER_FIELD_UNSUPPORTED),
    });
  });

  it('keeps derived Fortnox keys neutral', () => {
    expect(
      prepare({
        '@url': 'https://example.test/c',
        DefaultDeliveryTypes: { Invoice: 'PRINT' },
        DefaultTemplates: { Invoice: 'x' },
        PriceList: 'A',
        TermsOfPayment: '30',
        Active: true,
      }),
    ).toHaveProperty('request');
  });

  it('refuses an inactive customer', () => {
    expect(prepare({ Active: false })).toEqual({
      blocked: expect.stringContaining('inactive'),
    });
  });

  it('maps YourReference verbatim to contact_person', () => {
    expect(prepare({ YourReference: 'Kim Kontakt' }).request).toMatchObject({
      contact_person: 'Kim Kontakt',
    });
  });

  it.each([' padded', 'padded ', 'x'.repeat(201), 5])(
    'refuses YourReference %j that trim or length would change',
    (value) => {
      expect(prepare({ YourReference: value })).toEqual({
        blocked: expect.stringContaining(`${CUSTOMER_FIELD_UNSUPPORTED}: source YourReference`),
      });
    },
  );

  it('accepts a 200-character YourReference', () => {
    expect(prepare({ YourReference: 'x'.repeat(200) })).toHaveProperty('request');
  });
});

describe('customer readback of unrequested optional fields', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const minimal = {
    name: 'Exempel AB',
    customer_type: 'swedish_business',
    country: 'SE',
    customer_number: 'C-100',
  };
  function run(readback: Record<string, unknown>, mutation: Record<string, unknown> = {}) {
    const adapter = new AccountedShadowAdapter('company-123', async (req) =>
      req.method === 'POST'
        ? { status: 201, json: { data: { id, ...minimal, ...mutation } } }
        : { status: 200, json: { data: { id, ...minimal, ...readback } } },
    );
    const record = {
      id: 'i',
      version: 1,
      operation: 'createCustomer',
      args: [{ Name: 'Exempel AB' }],
      sourceCompany: 's',
      targetCompany: 'company-123',
      requestHash: 'h',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1,
      sourceResult: { ...base },
    } as ShadowRecord;
    return adapter.apply(record, minimal);
  }

  it('accepts null, empty and absent optional fields', async () => {
    await expect(
      run({ email: null, notes: '', invoice_email_cc_addresses: [], contact_person: null }),
    ).resolves.toMatchObject({ targetId: id });
  });

  it.each([
    ['email', 'x@example.test'],
    ['phone', '08-1'],
    ['address_line1', 'Gatan 1'],
    ['org_number', '556000-0000'],
    ['notes', 'unexpected'],
    ['contact_person', 'Someone'],
    ['invoice_email_cc_addresses', ['cc@example.test']],
    ['invoice_email_bcc_addresses', ['bcc@example.test']],
  ])('blocks an unexpected target %s on readback', async (key, value) => {
    await expect(run({ [key]: value })).rejects.toThrow();
  });

  it('blocks an unexpected cc array in the create receipt', async () => {
    await expect(run({}, { invoice_email_cc_addresses: ['cc@example.test'] })).rejects.toThrow();
  });

  it('verify() blocks an unexpected cc array appearing after creation', async () => {
    let drift: Record<string, unknown> = {};
    const adapter = new AccountedShadowAdapter('company-123', async (req) =>
      req.method === 'POST'
        ? { status: 201, json: { data: { id, ...minimal } } }
        : { status: 200, json: { data: { id, ...minimal, ...drift } } },
    );
    const record = {
      id: 'i',
      version: 1,
      operation: 'createCustomer',
      args: [{ Name: 'Exempel AB' }],
      sourceCompany: 's',
      targetCompany: 'company-123',
      requestHash: 'h',
      state: 'applied',
      createdAt: 1,
      updatedAt: 1,
      sourceResult: { ...base },
      targetId: id,
    } as ShadowRecord;
    const applied = await adapter.apply(record, minimal);
    const full = { ...record, targetReceipt: applied.receipt } as ShadowRecord;
    await expect(adapter.verify(full)).resolves.toBe(true);
    drift = { invoice_email_cc_addresses: ['cc@example.test'] };
    await expect(adapter.verify(full)).resolves.toBe(false);
  });
});
