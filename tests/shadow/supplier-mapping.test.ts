import { describe, expect, it } from 'vitest';
import type { ShadowBinding, ShadowRecord } from '../../src/shadow/types.js';
import { createSupplierMapping } from '../../src/shadow/supplier-mapping.js';

const binding: ShadowBinding = { sourceCompany: 'source-company', targetCompany: 'target-company' };
const sourceSupplier = {
  SupplierNumber: 'S-100',
  Name: 'Exempel AB',
  CountryCode: 'SE',
  OrganisationNumber: '5566778899',
  Email: 'supplier@example.se',
  Phone1: '+46123456789',
  Address1: 'Storgatan 1',
  Address2: 'Port 2',
  ZipCode: '11122',
  City: 'Stockholm',
  VATNumber: 'SE556677889901',
};

function makeRecord(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    id: 'intent-1',
    version: 1,
    operation: 'createSupplier',
    args: [{ Name: sourceSupplier.Name, CountryCode: sourceSupplier.CountryCode }],
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    requestHash: 'request-hash',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: { ...sourceSupplier },
    ...overrides,
  };
}

function mapper(
  classifications = new Map([[sourceSupplier.SupplierNumber, 'swedish_business' as const]]),
) {
  return createSupplierMapping(binding, classifications);
}

describe('createSupplierMapping', () => {
  it('maps only the confirmed narrow Swedish business supplier fields', () => {
    const input = {
      Name: sourceSupplier.Name,
      CountryCode: sourceSupplier.CountryCode,
      OrganisationNumber: sourceSupplier.OrganisationNumber,
      Email: sourceSupplier.Email,
      Phone1: sourceSupplier.Phone1,
      Address1: sourceSupplier.Address1,
      Address2: sourceSupplier.Address2,
      ZipCode: sourceSupplier.ZipCode,
      City: sourceSupplier.City,
      VATNumber: sourceSupplier.VATNumber,
    };

    expect(mapper()(makeRecord({ args: [input] }))).toEqual({
      request: {
        name: 'Exempel AB',
        supplier_type: 'swedish_business',
        country: 'SE',
        org_number: '5566778899',
        email: 'supplier@example.se',
        phone: '+46123456789',
        address_line1: 'Storgatan 1',
        address_line2: 'Port 2',
        postal_code: '11122',
        city: 'Stockholm',
        vat_number: 'SE556677889901',
      },
    });
  });

  it.each([
    ['source company', { sourceCompany: 'other-source' }],
    ['target company', { targetCompany: 'other-target' }],
    ['operation', { operation: 'createCustomer' }],
    ['argument count', { args: [] }],
    ['array argument', { args: [[{ Name: sourceSupplier.Name }]] }],
    ['missing confirmed result', { sourceResult: undefined }],
    ['missing supplier number', { sourceResult: { ...sourceSupplier, SupplierNumber: '' } }],
    ['missing confirmed name', { sourceResult: { ...sourceSupplier, Name: '' } }],
    ['non-Swedish supplier', { sourceResult: { ...sourceSupplier, CountryCode: 'NO' } }],
  ])('blocks invalid %s', (_label, overrides) => {
    expect(mapper()(makeRecord(overrides as Partial<ShadowRecord>))).toHaveProperty('blocked');
  });

  it('blocks missing per-supplier classification and copies the classification map at construction', () => {
    const unclassified = createSupplierMapping(binding, new Map());
    expect(unclassified(makeRecord())).toHaveProperty('blocked');

    const classifications = new Map([[sourceSupplier.SupplierNumber, 'swedish_business' as const]]);
    const copied = createSupplierMapping(binding, classifications);
    classifications.clear();
    expect(copied(makeRecord())).toHaveProperty('request');
  });

  it('blocks an explicitly requested SupplierNumber instead of dropping it', () => {
    const result = mapper()(
      makeRecord({
        args: [{ Name: sourceSupplier.Name, CountryCode: 'SE', SupplierNumber: 'S-100' }],
      }),
    );
    expect(result).toHaveProperty('blocked');
    if ('blocked' in result) expect(result.blocked).toContain('SupplierNumber');
  });

  it.each([
    'TermsOfPayment',
    'Currency',
    'DefaultExpenseAccount',
    'BG',
    'PG',
    'BankAccountNumber',
    'Active',
    'Notes',
  ])('blocks unsupported requested field %s', (field) => {
    expect(
      mapper()(makeRecord({ args: [{ Name: 'Exempel AB', CountryCode: 'SE', [field]: 'value' }] })),
    ).toHaveProperty('blocked');
  });

  it('blocks any explicitly requested field that differs from the confirmed source result', () => {
    const result = mapper()(
      makeRecord({
        args: [{ Name: sourceSupplier.Name, CountryCode: 'SE', Email: 'other@example.se' }],
      }),
    );
    expect(result).toHaveProperty('blocked');
    if ('blocked' in result) expect(result.blocked).toContain('Email');
  });

  it('accepts only ten-digit organisation numbers without normalizing them', () => {
    const accepted = mapper()(
      makeRecord({
        args: [{ Name: sourceSupplier.Name, CountryCode: 'SE', OrganisationNumber: '5566778899' }],
      }),
    );
    expect(accepted).toMatchObject({ request: { org_number: '5566778899' } });

    for (const organisationNumber of ['556677-8899', '556677 8899', '556677889']) {
      const result = mapper()(
        makeRecord({
          args: [
            {
              Name: sourceSupplier.Name,
              CountryCode: 'SE',
              OrganisationNumber: organisationNumber,
            },
          ],
          sourceResult: { ...sourceSupplier, OrganisationNumber: organisationNumber },
        }),
      );
      expect(result).toHaveProperty('blocked');
    }
  });

  it('blocks invalid requested emails', () => {
    const result = mapper()(
      makeRecord({
        args: [{ Name: sourceSupplier.Name, CountryCode: 'SE', Email: 'not-an-email' }],
        sourceResult: { ...sourceSupplier, Email: 'not-an-email' },
      }),
    );
    expect(result).toHaveProperty('blocked');
    if ('blocked' in result) expect(result.blocked).toContain('Email');
  });
});
