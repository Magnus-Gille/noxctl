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
    'EmailInvoice',
    'EmailInvoiceCC',
    'EmailInvoiceBCC',
    'EmailOffer',
    'EmailOfferCC',
    'EmailOfferBCC',
    'EmailOrder',
    'EmailOrderCC',
    'EmailOrderBCC',
    'Phone2',
    'Fax',
    'WWW',
    'Comments',
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
    });
    expect(result).toHaveProperty('request');
  });
});
