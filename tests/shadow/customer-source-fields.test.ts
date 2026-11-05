import { describe, expect, it } from 'vitest';
import type { ShadowRecord } from '../../src/shadow/types.js';
import {
  AccountedShadowAdapter,
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
    'WWW',
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
  it.each([
    [{ ...body, invoice_email_cc_addresses: ['other@example.test'] }],
    [{ ...body, invoice_email_cc_addresses: null }],
    [{ ...body, notes: 'X' }],
  ])('blocks a differing readback', async (stored) => {
    await expect(run(stored)).rejects.toThrow();
  });
});
