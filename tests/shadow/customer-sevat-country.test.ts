import { describe, expect, it } from 'vitest';
import type { ShadowRecord } from '../../src/shadow/types.js';
import {
  AccountedShadowAdapter,
  CUSTOMER_COUNTRY_UNVERIFIED,
} from '../../src/shadow/accounted-adapter.js';

const base = {
  CustomerNumber: 'C-100',
  Name: 'Exempel AB',
  Type: 'COMPANY',
  VATType: 'SEVAT',
  Currency: 'SEK',
  Country: null as unknown,
  CountryCode: null as unknown,
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
  return (adapter as unknown as { prepare(r: ShadowRecord): Record<string, unknown> }).prepare(
    record,
  );
}

const accepted = {
  request: {
    name: 'Exempel AB',
    customer_type: 'swedish_business',
    country: 'SE',
    customer_number: 'C-100',
  },
};

describe('customer without country (owner decision 2026-11-05)', () => {
  it('accepts COMPANY + SEVAT + SEK with null Country and CountryCode', () => {
    expect(prepare({})).toEqual(accepted);
  });
  it('accepts empty-string and missing country fields', () => {
    expect(prepare({ Country: '', CountryCode: '' })).toEqual(accepted);
    expect(prepare({ Country: undefined, CountryCode: undefined })).toEqual(accepted);
  });
  it.each([
    ['EUVAT', { VATType: 'EUVAT' }],
    ['EXPORT', { VATType: 'EXPORT' }],
    ['SEREVERSEDVAT', { VATType: 'SEREVERSEDVAT' }],
    ['missing VATType', { VATType: undefined }],
    ['EUR currency', { Currency: 'EUR' }],
    ['missing currency', { Currency: undefined }],
  ])('refuses with stable reason: %s', (_n, over) => {
    const r = prepare(over);
    expect(String(r.blocked)).toContain(CUSTOMER_COUNTRY_UNVERIFIED);
  });
  it.each([
    ['explicit Country, empty code', { Country: 'Norge', CountryCode: '' }],
    ['explicit Country, null code', { Country: 'Norge', CountryCode: null }],
    ['explicit non-SE code', { CountryCode: 'NO' }],
    ['non-SE code with Country', { Country: 'Norge', CountryCode: 'NO' }],
    ['code only non-SE', { Country: '', CountryCode: 'DE' }],
    ['Sverige name but no code', { Country: 'Sverige', CountryCode: null }],
  ])('keeps refusing: %s', (_n, over) => {
    const r = prepare(over);
    expect(r.request).toBeUndefined();
    expect(String(r.blocked)).toBe('Only confirmed Swedish customers are supported.');
  });
  it('refuses PRIVATE type (existing COMPANY gate)', () => {
    const r = prepare({ Type: 'PRIVATE' });
    expect(r.request).toBeUndefined();
    expect(String(r.blocked)).toContain('COMPANY');
  });
  it('existing SE customers are unchanged, regardless of VATType/currency', () => {
    expect(
      prepare({ CountryCode: 'SE', Country: 'Sverige', VATType: 'EUVAT', Currency: 'EUR' }),
    ).toEqual(accepted);
  });
  it('still requires input consistency with source', () => {
    expect(String(prepare({}, { CountryCode: 'SE' }).blocked)).toContain('CountryCode');
  });
});
