import { z } from 'zod';
import type { ShadowBinding, ShadowRecord } from './types.js';

type SupplierType = 'swedish_business';
type SupplierRequest = Record<string, unknown>;
type SupplierMappingResult = { request: SupplierRequest } | { blocked: string };

const INPUT_TO_TARGET: ReadonlyArray<[string, string]> = [
  ['Email', 'email'],
  ['Phone1', 'phone'],
  ['Address1', 'address_line1'],
  ['Address2', 'address_line2'],
  ['ZipCode', 'postal_code'],
  ['City', 'city'],
  ['OrganisationNumber', 'org_number'],
  ['VATNumber', 'vat_number'],
];
const ALLOWED_INPUTS = new Set([
  'Name',
  'CountryCode',
  'Email',
  'Phone1',
  'Address1',
  'Address2',
  'ZipCode',
  'City',
  'OrganisationNumber',
  'VATNumber',
]);
const EMAIL = z.string().email();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a pure, fail-closed supplier translation from confirmed Fortnox data.
 * Accounted's supplier defaults (including 30-day terms and SEK) are not copied
 * as source parity claims; unrequested defaults are excluded from this body.
 */
export function createSupplierMapping(
  binding: ShadowBinding,
  classifications: ReadonlyMap<string, SupplierType>,
): (record: ShadowRecord) => SupplierMappingResult {
  const expectedBinding = { ...binding };
  const supplierClassifications = new Map(classifications);

  return (record) => {
    if (record.sourceCompany !== expectedBinding.sourceCompany) {
      return { blocked: 'Source company does not match the supplier mapping binding.' };
    }
    if (record.targetCompany !== expectedBinding.targetCompany) {
      return { blocked: 'Target company does not match the supplier mapping binding.' };
    }
    if (record.operation !== 'createSupplier')
      return { blocked: `Unsupported operation: ${record.operation}.` };
    if (!Array.isArray(record.args) || record.args.length !== 1 || !isPlainObject(record.args[0])) {
      return { blocked: 'createSupplier requires exactly one plain object argument.' };
    }
    const input = record.args[0];
    if (Object.hasOwn(input, 'SupplierNumber')) {
      return {
        blocked: 'SupplierNumber is a Fortnox source identity and is not writable in Accounted.',
      };
    }
    const unsupported = Object.keys(input).filter((field) => !ALLOWED_INPUTS.has(field));
    if (unsupported.length > 0) {
      return { blocked: `Unsupported supplier input fields: ${unsupported.join(', ')}.` };
    }
    if (!isPlainObject(record.sourceResult))
      return { blocked: 'A confirmed source supplier result is required.' };
    const source = record.sourceResult;
    if (!nonemptyString(source.SupplierNumber))
      return { blocked: 'Confirmed source SupplierNumber is required.' };
    if (!nonemptyString(source.Name)) return { blocked: 'Confirmed source Name is required.' };
    if (source.CountryCode !== 'SE')
      return { blocked: 'Only confirmed Swedish suppliers are supported.' };
    if (supplierClassifications.get(source.SupplierNumber) !== 'swedish_business') {
      return { blocked: 'SupplierNumber has no confirmed swedish_business classification.' };
    }

    for (const field of Object.keys(input)) {
      if (!Object.hasOwn(source, field) || source[field] !== input[field]) {
        return { blocked: `Confirmed source value is missing or inconsistent for ${field}.` };
      }
      if (field !== 'CountryCode' && !nonemptyString(input[field])) {
        return { blocked: `Requested ${field} must be a nonempty string.` };
      }
    }

    const body: SupplierRequest = {
      name: source.Name,
      supplier_type: 'swedish_business',
      country: 'SE',
    };
    for (const [sourceField, targetField] of INPUT_TO_TARGET) {
      if (!Object.hasOwn(input, sourceField)) continue;
      const value = source[sourceField];
      if (!nonemptyString(value))
        return { blocked: `Confirmed source ${sourceField} must be a nonempty string.` };
      if (sourceField === 'Email' && !EMAIL.safeParse(value).success) {
        return { blocked: 'Confirmed source Email is not a valid email address.' };
      }
      if (sourceField === 'OrganisationNumber' && !/^\d{10}$/.test(value)) {
        return {
          blocked:
            'OrganisationNumber must contain exactly 10 digits; other formats need an explicit canonicalization mapping.',
        };
      }
      body[targetField] = value;
    }
    return { request: body };
  };
}
