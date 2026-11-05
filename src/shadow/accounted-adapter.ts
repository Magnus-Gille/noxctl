import { z } from 'zod';
import { TargetReceiptPendingError } from './types.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSupplierMapping } from './supplier-mapping.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord } from './types.js';

export interface AccountedRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export interface AccountedResponse {
  status: number;
  json: unknown;
}

export type AccountedRequestCallback = (request: AccountedRequest) => Promise<AccountedResponse>;

type CustomerBody = {
  name: string;
  customer_type: 'swedish_business';
  country: 'SE';
  customer_number: string;
  org_number?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  postal_code?: string;
  city?: string;
  vat_number?: string;
  invoice_email_cc_addresses?: string[];
  invoice_email_bcc_addresses?: string[];
  notes?: string;
};

type NativeData = Record<string, unknown> & { id: string };

const INPUT_TO_TARGET: ReadonlyArray<[string, keyof CustomerBody]> = [
  ['OrganisationNumber', 'org_number'],
  ['Email', 'email'],
  ['Phone1', 'phone'],
  ['Address1', 'address_line1'],
  ['Address2', 'address_line2'],
  ['ZipCode', 'postal_code'],
  ['City', 'city'],
  ['VATNumber', 'vat_number'],
];
const ALLOWED_INPUTS = new Set([
  'Name',
  'Type',
  'CountryCode',
  'CustomerNumber',
  'OrganisationNumber',
  'Email',
  'Phone1',
  'Address1',
  'Address2',
  'ZipCode',
  'City',
  'VATNumber',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable refusal reason: a populated source customer field has no Accounted counterpart. */
export const CUSTOMER_FIELD_UNSUPPORTED = 'CUSTOMER_FIELD_UNSUPPORTED';

/**
 * Populated source customer data that cannot be mirrored (Accounted has no delivery address,
 * offer/order e-mail routing, second phone, fax or web address). EmailInvoice is neutral only when
 * equal to Email; EmailInvoiceCC/BCC map to invoice_email_{cc,bcc}_addresses; Comments to notes. Fortnox
 * defaults/derived fields (Currency, VATType, TermsOfPayment, PriceList, ...) stay neutral.
 */
const UNMAPPABLE_SOURCE_FIELDS = [
  'DeliveryName',
  'DeliveryAddress1',
  'DeliveryAddress2',
  'DeliveryZipCode',
  'DeliveryCity',
  'DeliveryCountry',
  'EmailOffer',
  'EmailOfferCC',
  'EmailOfferBCC',
  'EmailOrder',
  'EmailOrderCC',
  'EmailOrderBCC',
  'Phone2',
  'Fax',
  'WWW',
] as const;

/** Stable refusal reason: customer has no country and does not meet the SEVAT/SEK/COMPANY rule. */
export const CUSTOMER_COUNTRY_UNVERIFIED = 'CUSTOMER_COUNTRY_UNVERIFIED';

function emptyCountry(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

const MAX_INVOICE_COPY_RECIPIENTS = 19;

/** Split a Fortnox ';'/','-separated address string exactly; undefined when any part is invalid. */
function parseAddressList(value: string): string[] | undefined {
  const parts = value.split(/[;,]/).map((part) => part.trim());
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part.length > 254) ||
    parts.some((part) => !z.string().email().safeParse(part).success)
  )
    return undefined;
  return parts;
}

function countryAbsent(source: Record<string, unknown>): boolean {
  return emptyCountry(source.Country) && emptyCountry(source.CountryCode);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function responseData(value: unknown): NativeData | null {
  if (!plainObject(value) || !plainObject(value.data) || !nonemptyString(value.data.id))
    return null;
  return value.data as NativeData;
}

function matchesMappedValues(
  data: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Array.isArray(value) ? isDeepStrictEqual(data[key], value) : data[key] === value,
  );
}

function sameObject(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/** Shared one-attempt create and UUID readback for fixed native master-data routes. */
abstract class AccountedCreateAdapter implements ShadowAdapter {
  private readonly resourcePath: string;

  constructor(
    protected readonly targetCompany: string,
    private readonly request: AccountedRequestCallback,
    private readonly resource: 'customers' | 'suppliers',
  ) {
    this.resourcePath = `/api/v1/companies/${encodeURIComponent(targetCompany)}/${resource}`;
  }

  abstract prepare(record: ShadowRecord): { request: unknown } | { blocked: string };

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: unknown }> {
    const prepared = this.prepare(record);
    if (!('request' in prepared) || !sameObject(prepared.request, request)) {
      throw new Error(`Accounted ${this.resource} request does not match the prepared mapping.`);
    }
    if (!nonemptyString(record.id) || !nonemptyString(record.requestHash)) {
      throw new Error('Shadow record identity and request hash are required for idempotency.');
    }
    const idempotencyKey = `shadow_${createHash('sha256')
      .update(JSON.stringify([this.targetCompany, record.id, record.requestHash]))
      .digest('hex')}`;

    const created = await this.request({
      method: 'POST',
      path: this.resourcePath,
      body: prepared.request,
      idempotencyKey,
    });
    const createdData = responseData(created.json);
    if (!createdData || !UUID.test(createdData.id)) {
      if (created.status !== 201)
        throw new Error(`Accounted ${this.resource} create returned HTTP ${created.status}.`);
      throw new Error(`Accounted ${this.resource} create returned an invalid receipt.`);
    }
    const expected = prepared.request as Record<string, unknown>;
    const pendingReceipt = {
      kind: 'master-data-create-incomplete',
      version: 1,
      complete: false,
      data: createdData,
      expected,
      mutation: { status: created.status },
    } as const;
    if (created.status !== 201) {
      throw new TargetReceiptPendingError(createdData.id, pendingReceipt, {
        cause: new Error(`Accounted ${this.resource} create returned HTTP ${created.status}.`),
      });
    }
    if (!matchesMappedValues(createdData, expected)) {
      throw new TargetReceiptPendingError(createdData.id, pendingReceipt, {
        cause: new Error(
          `Accounted ${this.resource} create receipt does not match the requested mapping.`,
        ),
      });
    }

    try {
      const readback = await this.request({
        method: 'GET',
        path: `${this.resourcePath}/${encodeURIComponent(createdData.id)}`,
      });
      if (readback.status !== 200)
        throw new Error(`Accounted ${this.resource} readback returned HTTP ${readback.status}.`);
      const readbackData = responseData(readback.json);
      if (
        !readbackData ||
        readbackData.id !== createdData.id ||
        !matchesMappedValues(readbackData, expected)
      ) {
        throw new Error(
          `Accounted ${this.resource} readback does not match the requested mapping.`,
        );
      }
    } catch (cause) {
      throw new TargetReceiptPendingError(
        createdData.id,
        { data: createdData, expected },
        { cause },
      );
    }

    return {
      targetId: createdData.id,
      receipt: { data: createdData, expected },
    };
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    if (
      record.targetCompany !== this.targetCompany ||
      !record.targetId ||
      !UUID.test(record.targetId)
    )
      return false;
    const prepared = this.prepare(record);
    if (
      !('request' in prepared) ||
      !plainObject(record.targetReceipt) ||
      !plainObject(record.targetReceipt.data) ||
      !plainObject(record.targetReceipt.expected)
    )
      return false;
    if (
      record.targetReceipt.kind === 'master-data-create-incomplete' ||
      (Object.hasOwn(record.targetReceipt, 'complete') && record.targetReceipt.complete !== true)
    )
      return false;
    if (!sameObject(prepared.request, record.targetReceipt.expected)) return false;
    const receiptData = record.targetReceipt.data as Record<string, unknown>;
    if (
      receiptData.id !== record.targetId ||
      !matchesMappedValues(receiptData, prepared.request as Record<string, unknown>)
    )
      return false;

    const response = await this.request({
      method: 'GET',
      path: `${this.resourcePath}/${encodeURIComponent(record.targetId)}`,
    });
    if (response.status !== 200) return false;
    const data = responseData(response.json);
    if (
      !data ||
      data.id !== record.targetId ||
      !matchesMappedValues(data, prepared.request as Record<string, unknown>)
    )
      return false;
    return (
      receiptData.id === data.id &&
      matchesMappedValues(data, prepared.request as Record<string, unknown>) &&
      matchesMappedValues(receiptData, prepared.request as Record<string, unknown>)
    );
  }
}

/** Limited field mapping, not full customer parity. Unrequested defaults are not transferred. */
export class AccountedShadowAdapter extends AccountedCreateAdapter {
  constructor(targetCompany: string, request: AccountedRequestCallback) {
    super(targetCompany, request, 'customers');
  }

  prepare(record: ShadowRecord): { request: unknown } | { blocked: string } {
    if (record.targetCompany !== this.targetCompany)
      return { blocked: 'Target company does not match the adapter binding.' };
    if (record.operation !== 'createCustomer')
      return { blocked: `Unsupported operation: ${record.operation}.` };
    if (!Array.isArray(record.args) || record.args.length !== 1 || !plainObject(record.args[0])) {
      return { blocked: 'createCustomer requires exactly one plain object argument.' };
    }
    const input = record.args[0];
    if (Object.hasOwn(input, 'TermsOfPayment')) {
      return {
        blocked:
          'TermsOfPayment is a Fortnox reference code; mapping is disabled pending a verified terms-reference mapping.',
      };
    }
    const unsupported = Object.keys(input).filter((key) => !ALLOWED_INPUTS.has(key));
    if (unsupported.length > 0) {
      return { blocked: `Unsupported customer input fields: ${unsupported.join(', ')}.` };
    }
    if (!plainObject(record.sourceResult))
      return { blocked: 'A confirmed source customer result is required.' };
    const source = record.sourceResult;
    if (!nonemptyString(source.CustomerNumber))
      return { blocked: 'Confirmed source CustomerNumber is required.' };
    if (source.CustomerNumber.length > 32 || source.CustomerNumber.trim() !== source.CustomerNumber)
      return { blocked: 'Accounted customer number must be unpadded and at most 32 characters.' };
    if (!nonemptyString(source.Name)) return { blocked: 'Confirmed source Name is required.' };
    if (source.Type !== 'COMPANY')
      return { blocked: 'Only confirmed COMPANY customers are supported.' };
    if (
      source.CountryCode === 'SE' &&
      !emptyCountry(source.Country) &&
      source.Country !== 'Sverige'
    ) {
      return { blocked: 'Only confirmed Swedish customers are supported.' };
    }
    if (source.CountryCode !== 'SE') {
      if (!countryAbsent(source))
        return { blocked: 'Only confirmed Swedish customers are supported.' };
      // Owner decision 2026-11-05: no country information at all is accepted only for a SEK
      // customer with Swedish VAT; anything else is unverifiable and refused.
      if (source.Type !== 'COMPANY' || source.VATType !== 'SEVAT' || source.Currency !== 'SEK')
        return {
          blocked: `${CUSTOMER_COUNTRY_UNVERIFIED}: customer has no country and is not a SEK SEVAT company.`,
        };
    }

    for (const field of UNMAPPABLE_SOURCE_FIELDS) {
      const value = source[field];
      if (value !== undefined && value !== null && value !== '') {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: populated source ${field} has no Accounted mapping.`,
        };
      }
    }

    if (!emptyCountry(source.EmailInvoice) && source.EmailInvoice !== source.Email) {
      return {
        blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source EmailInvoice differs from Email (or Email is empty); the invoice e-mail has no Accounted mapping.`,
      };
    }

    for (const key of Object.keys(input)) {
      if (source[key] !== input[key])
        return { blocked: `Confirmed source value is missing or inconsistent for ${key}.` };
    }
    const body: CustomerBody = {
      name: source.Name,
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: source.CustomerNumber,
    };
    for (const [sourceKey, targetKey] of INPUT_TO_TARGET) {
      const requested = input[sourceKey] !== undefined;
      const value = source[sourceKey];
      // Every supported field is mirrored from the confirmed source when populated, whether or
      // not the input carried it; a requested field must be populated.
      if (!requested && (value === undefined || value === null || value === '')) continue;
      if (!nonemptyString(value))
        return { blocked: `Confirmed source ${sourceKey} is required when requested.` };
      if (sourceKey === 'Email' && !z.string().email().safeParse(value).success)
        return { blocked: 'Email is not accepted by the Accounted customer schema.' };
      (body as Record<string, unknown>)[targetKey] = value;
    }
    const lists: Array<[string, 'invoice_email_cc_addresses' | 'invoice_email_bcc_addresses']> = [
      ['EmailInvoiceCC', 'invoice_email_cc_addresses'],
      ['EmailInvoiceBCC', 'invoice_email_bcc_addresses'],
    ];
    let copyCount = 0;
    for (const [sourceKey, targetKey] of lists) {
      const value = source[sourceKey];
      if (emptyCountry(value)) continue;
      const parsed = typeof value === 'string' ? parseAddressList(value) : undefined;
      if (!parsed) {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source ${sourceKey} is not a list of valid e-mail addresses.`,
        };
      }
      copyCount += parsed.length;
      body[targetKey] = parsed;
    }
    if (copyCount > MAX_INVOICE_COPY_RECIPIENTS) {
      return {
        blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: more than ${MAX_INVOICE_COPY_RECIPIENTS} invoice copy recipients.`,
      };
    }
    if (!emptyCountry(source.Comments)) {
      if (typeof source.Comments !== 'string') {
        return { blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source Comments must be a string.` };
      }
      body.notes = source.Comments;
    }
    return { request: body };
  }
}

class AccountedSupplierAdapter extends AccountedCreateAdapter {
  private readonly map: ReturnType<typeof createSupplierMapping>;

  constructor(
    binding: ShadowBinding,
    request: AccountedRequestCallback,
    classifications: ReadonlyMap<string, 'swedish_business'>,
  ) {
    super(binding.targetCompany, request, 'suppliers');
    this.map = createSupplierMapping(binding, classifications);
  }

  prepare(record: ShadowRecord): { request: unknown } | { blocked: string } {
    return this.map(record);
  }
}

/** Fixed operation routing and two-sided host binding. No user-supplied target paths. */
export class AccountedMasterDataAdapter implements ShadowAdapter {
  private readonly binding: ShadowBinding;
  private readonly customers: AccountedShadowAdapter;
  private readonly suppliers: AccountedSupplierAdapter;

  constructor(
    binding: ShadowBinding,
    request: AccountedRequestCallback,
    supplierClassifications: ReadonlyMap<string, 'swedish_business'> = new Map(),
  ) {
    this.binding = { ...binding };
    this.customers = new AccountedShadowAdapter(binding.targetCompany, request);
    this.suppliers = new AccountedSupplierAdapter(binding, request, supplierClassifications);
  }

  private select(record: ShadowRecord): AccountedCreateAdapter | undefined {
    if (
      record.sourceCompany !== this.binding.sourceCompany ||
      record.targetCompany !== this.binding.targetCompany
    )
      return undefined;
    if (record.operation === 'createCustomer') return this.customers;
    if (record.operation === 'createSupplier') return this.suppliers;
    return undefined;
  }

  prepare(record: ShadowRecord): { request: unknown } | { blocked: string } {
    const adapter = this.select(record);
    return adapter
      ? adapter.prepare(record)
      : { blocked: 'Unsupported operation or company binding.' };
  }

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: unknown }> {
    const adapter = this.select(record);
    if (!adapter) throw new Error('Unsupported operation or company binding.');
    return adapter.apply(record, request);
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    const adapter = this.select(record);
    return adapter ? adapter.verify(record) : false;
  }
}
