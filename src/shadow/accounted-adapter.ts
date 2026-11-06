import { z } from 'zod';
import { TargetReceiptPendingError } from './types.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createSupplierMapping } from './supplier-mapping.js';
import { AccountedArticleLinkAdapter } from './article-link-adapter.js';
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
  contact_person?: string;
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

/** Stable refusal reason: baselineCustomer arguments do not name exactly the read source customer. */
export const BASELINE_CUSTOMER_ARGS_INVALID = 'BASELINE_CUSTOMER_ARGS_INVALID';

/** Stable refusal reason: a populated source customer field has no Accounted counterpart. */
export const CUSTOMER_FIELD_UNSUPPORTED = 'CUSTOMER_FIELD_UNSUPPORTED';

/** Stable refusal reason: a populated source key that no allowlist group covers. */
export const CUSTOMER_FIELD_UNCLASSIFIED = 'CUSTOMER_FIELD_UNCLASSIFIED';

/**
 * Allowlist classification of every Fortnox customer key (docs/shadow-evaluation.md). "Populated"
 * means not undefined/null/''/[]. Unlisted populated keys are refused as unclassified.
 *  - mapped and verified: CustomerNumber, Name, OrganisationNumber, Email, Phone1, Address1/2,
 *    ZipCode, City, VATNumber, EmailInvoiceCC/BCC, Comments (notes), YourReference (contact_person);
 *  - mapped into `notes` (owner decision 2026-11-06, NOX-210; supersedes the earlier refusal):
 *    OurReference, WWW, Visiting* as labelled single-line entries after Comments (see the notes
 *    composition in the mapper); a non-string, padded value or one with control characters or line/paragraph separators is refused;
 *  - validated: Type, Country, CountryCode, Currency, VATType, Active (false refused), and
 *    EmailInvoice/EmailOffer/EmailOrder (neutral only when equal to Email);
 *  - derived/neutral: @url, DefaultDeliveryTypes, DefaultTemplates, PriceList, TermsOfPayment;
 *  - refused when populated (CUSTOMER_FIELD_UNSUPPORTED): the rest below. For the numeric and
 *    boolean ones 0 and false mean "none" and are neutral.
 */
/**
 * Owner decision 2026-11-06 (NOX-210), superseding the earlier refusal: Accounted has no fields
 * for these, so they are appended to `notes` as labelled single-line entries.
 */
const NOTES_LABELLED_FIELDS = [
  'OurReference',
  'WWW',
  'VisitingAddress',
  'VisitingZipCode',
  'VisitingCity',
  'VisitingCountry',
  'VisitingCountryCode',
] as const;
/** C0/C1 controls (incl. tab, CR, LF, VT, FF, NEL) and Unicode line/paragraph separators. */
const NOTES_LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CUSTOMER_MAPPED = new Set<string>([
  'CustomerNumber',
  'Name',
  'OrganisationNumber',
  'Email',
  'Phone1',
  'Address1',
  'Address2',
  'ZipCode',
  'City',
  'VATNumber',
  'EmailInvoiceCC',
  'EmailInvoiceBCC',
  'Comments',
  'YourReference',
  ...NOTES_LABELLED_FIELDS,
]);
const CUSTOMER_VALIDATED = new Set([
  'Type',
  'Country',
  'CountryCode',
  'Currency',
  'VATType',
  'Active',
  'EmailInvoice',
  'EmailOffer',
  'EmailOrder',
]);
const CUSTOMER_DERIVED = new Set([
  '@url',
  'DefaultDeliveryTypes',
  'DefaultTemplates',
  'PriceList',
  'TermsOfPayment',
]);
const UNMAPPABLE_SOURCE_FIELDS = [
  'GLN',
  'GLNDelivery',
  'DeliveryName',
  'DeliveryAddress1',
  'DeliveryAddress2',
  'DeliveryZipCode',
  'DeliveryCity',
  'DeliveryCountry',
  'DeliveryCountryCode',
  'DeliveryFax',
  'DeliveryPhone1',
  'DeliveryPhone2',
  'EmailOfferCC',
  'EmailOfferBCC',
  'EmailOrderCC',
  'EmailOrderBCC',
  'ExternalReference',
  'Fax',
  'InvoiceRemark',
  'Phone2',
  'TermsOfDelivery',
  'WayOfDelivery',
  'CostCenter',
  'Project',
  'SalesAccount',
  'InvoiceAdministrationFee',
  'InvoiceDiscount',
  'InvoiceFreight',
  'ShowPriceVATIncluded',
] as const;
const ZERO_NEUTRAL_FIELDS: ReadonlySet<string> = new Set([
  'SalesAccount',
  'InvoiceAdministrationFee',
  'InvoiceDiscount',
  'InvoiceFreight',
  'ShowPriceVATIncluded',
]);
const CUSTOMER_CLASSIFIED = new Set<string>([
  ...CUSTOMER_MAPPED,
  ...CUSTOMER_VALIDATED,
  ...CUSTOMER_DERIVED,
  ...UNMAPPABLE_SOURCE_FIELDS,
]);

function populated(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

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

/** Optional target fields a customer request may set; when absent from the request they must be empty. */
const OPTIONAL_CUSTOMER_KEYS: readonly string[] = [
  'org_number',
  'email',
  'phone',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'vat_number',
  'invoice_email_cc_addresses',
  'invoice_email_bcc_addresses',
  'notes',
  'contact_person',
];

function emptyTargetValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
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
    private readonly optionalKeys: readonly string[] = [],
  ) {
    this.resourcePath = `/api/v1/companies/${encodeURIComponent(targetCompany)}/${resource}`;
  }

  /** Mapped values equal, and optional fields not requested hold nothing. */
  private matches(data: Record<string, unknown>, expected: Record<string, unknown>): boolean {
    return (
      matchesMappedValues(data, expected) &&
      this.optionalKeys.every((key) => Object.hasOwn(expected, key) || emptyTargetValue(data[key]))
    );
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
    if (!this.matches(createdData, expected)) {
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
        !this.matches(readbackData, expected)
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
      !this.matches(receiptData, prepared.request as Record<string, unknown>)
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
      !this.matches(data, prepared.request as Record<string, unknown>)
    )
      return false;
    return (
      receiptData.id === data.id &&
      this.matches(data, prepared.request as Record<string, unknown>) &&
      this.matches(receiptData, prepared.request as Record<string, unknown>)
    );
  }
}

/** Limited field mapping, not full customer parity. Unrequested defaults are not transferred. */
export class AccountedShadowAdapter extends AccountedCreateAdapter {
  constructor(targetCompany: string, request: AccountedRequestCallback) {
    super(targetCompany, request, 'customers', OPTIONAL_CUSTOMER_KEYS);
  }

  prepare(record: ShadowRecord): { request: unknown } | { blocked: string } {
    if (record.targetCompany !== this.targetCompany)
      return { blocked: 'Target company does not match the adapter binding.' };
    if (record.operation !== 'createCustomer' && record.operation !== 'baselineCustomer')
      return { blocked: `Unsupported operation: ${record.operation}.` };
    if (!Array.isArray(record.args) || record.args.length !== 1 || !plainObject(record.args[0])) {
      return { blocked: `${record.operation} requires exactly one plain object argument.` };
    }
    const input = record.args[0];
    if (record.operation === 'baselineCustomer') {
      // NOX-213: the source result is a Fortnox READ of an existing customer; the argument only
      // names it. Everything else goes through the identical createCustomer mapping below.
      const keys = Object.keys(input);
      if (
        keys.length !== 1 ||
        keys[0] !== 'CustomerNumber' ||
        !plainObject(record.sourceResult) ||
        !nonemptyString(input.CustomerNumber) ||
        record.sourceResult.CustomerNumber !== input.CustomerNumber
      ) {
        return {
          blocked: `${BASELINE_CUSTOMER_ARGS_INVALID}: baselineCustomer requires exactly { CustomerNumber } equal to the source customer's number.`,
        };
      }
    }
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

    for (const [field, value] of Object.entries(source)) {
      if (!CUSTOMER_CLASSIFIED.has(field) && populated(value)) {
        return {
          blocked: `${CUSTOMER_FIELD_UNCLASSIFIED}: populated source key ${field} is not classified.`,
        };
      }
    }
    if (source.Active === false) {
      return {
        blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source customer is inactive (Active=false).`,
      };
    }
    for (const field of UNMAPPABLE_SOURCE_FIELDS) {
      const value = source[field];
      const none = ZERO_NEUTRAL_FIELDS.has(field) && (value === 0 || value === false);
      if (populated(value) && !none) {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: populated source ${field} has no Accounted mapping.`,
        };
      }
    }

    // Fortnox per-document e-mail routing: accepted only as an exact copy of Email.
    for (const field of ['EmailInvoice', 'EmailOffer', 'EmailOrder'] as const) {
      if (!emptyCountry(source[field]) && source[field] !== source.Email) {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source ${field} differs from Email (or Email is empty); it has no Accounted mapping.`,
        };
      }
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
    if (!emptyCountry(source.YourReference)) {
      const reference = source.YourReference;
      if (
        typeof reference !== 'string' ||
        reference.length > 200 ||
        reference !== reference.trim()
      ) {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source YourReference must be a string of at most 200 characters without surrounding whitespace (contact_person is trimmed).`,
        };
      }
      body.contact_person = reference;
    }
    const noteParts: string[] = [];
    if (!emptyCountry(source.Comments)) {
      if (typeof source.Comments !== 'string') {
        return { blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source Comments must be a string.` };
      }
      noteParts.push(source.Comments);
    }
    const labelled: Partial<Record<(typeof NOTES_LABELLED_FIELDS)[number], string>> = {};
    for (const key of NOTES_LABELLED_FIELDS) {
      const value = source[key];
      if (emptyCountry(value)) continue;
      if (typeof value !== 'string') {
        return { blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source ${key} must be a string.` };
      }
      if (NOTES_LINE_BREAK_OR_CONTROL.test(value) || value !== value.trim()) {
        return {
          blocked: `${CUSTOMER_FIELD_UNSUPPORTED}: source ${key} must be a single line without control characters or surrounding whitespace to be mirrored into notes.`,
        };
      }
      labelled[key] = value;
    }
    if (labelled.OurReference) noteParts.push(`Vår referens: ${labelled.OurReference}`);
    if (labelled.WWW) noteParts.push(`Webb: ${labelled.WWW}`);
    const zipCity = [labelled.VisitingZipCode, labelled.VisitingCity].filter(Boolean).join(' ');
    const visiting = [
      labelled.VisitingAddress,
      zipCity,
      labelled.VisitingCountry || labelled.VisitingCountryCode,
    ].filter((part): part is string => Boolean(part));
    if (visiting.length > 0) noteParts.push(`Besöksadress: ${visiting.join(', ')}`);
    if (noteParts.length > 0) body.notes = noteParts.join('\n');
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
  private readonly articles: AccountedArticleLinkAdapter;

  constructor(
    binding: ShadowBinding,
    request: AccountedRequestCallback,
    supplierClassifications: ReadonlyMap<string, 'swedish_business'> = new Map(),
  ) {
    this.binding = { ...binding };
    this.customers = new AccountedShadowAdapter(binding.targetCompany, request);
    this.suppliers = new AccountedSupplierAdapter(binding, request, supplierClassifications);
    this.articles = new AccountedArticleLinkAdapter(binding.targetCompany, request);
  }

  private select(record: ShadowRecord): ShadowAdapter | undefined {
    if (
      record.sourceCompany !== this.binding.sourceCompany ||
      record.targetCompany !== this.binding.targetCompany
    )
      return undefined;
    if (record.operation === 'createCustomer' || record.operation === 'baselineCustomer')
      return this.customers;
    if (record.operation === 'createSupplier') return this.suppliers;
    if (record.operation === 'baselineArticle') return this.articles;
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
    return adapter?.verify ? adapter.verify(record) : false;
  }
}
