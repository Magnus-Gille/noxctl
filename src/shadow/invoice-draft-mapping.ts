import type { ShadowBinding, ShadowRecord } from './types.js';
import type {
  ShadowIdentityResolution,
  ShadowResourceKind,
  ShadowSourceCustomer,
} from './identity.js';

export interface InvoiceDraftItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_rate: 25;
  revenue_account: string;
  /** Target catalog article UUID; present only for article-linked source rows. */
  article_id?: string;
}

/**
 * Purely descriptive row. The target requires quantity, unit and unit_price to be present;
 * it stores 0, '' and 0 and excludes the row from totals and VAT.
 */
export interface InvoiceDraftTextItem {
  line_type: 'text';
  description: string;
  quantity: 0;
  unit: '';
  unit_price: 0;
}

export interface InvoiceDraftBody {
  customer_id: string;
  invoice_date: string;
  due_date: string;
  currency: 'SEK';
  document_type: 'invoice';
  payment_link_auto: false;
  ore_rounding: false;
  /** Fortnox OurReference / YourReference / Remarks, verbatim; omitted when empty. */
  our_reference?: string;
  your_reference?: string;
  notes?: string;
  /** Fortnox YourOrderNumber, verbatim (at most 200 characters); omitted when empty. */
  invoice_marking?: string;
  /** Fortnox DeliveryDate (ISO date); omitted when empty. */
  delivery_date?: string;
  items: Array<InvoiceDraftItem | InvoiceDraftTextItem>;
}

export interface InvoiceDraftExpectedItem extends InvoiceDraftItem {
  line_total: number;
  vat_amount: number;
  discount_percent: 0;
}

export interface InvoiceDraftExpectedTextItem extends InvoiceDraftTextItem {
  line_total: 0;
  vat_amount: 0;
}

/** Expected live target customer values (target keys); '' means the target must hold none. */
export type MirroredCustomer = Record<
  'name' | 'org_number' | 'phone' | 'address_line1' | 'address_line2' | 'postal_code' | 'city',
  string
>;

const CUSTOMER_EVIDENCE_KEYS = [
  'Name',
  'OrganisationNumber',
  'Phone1',
  'Phone2',
  'Address1',
  'Address2',
  'ZipCode',
  'City',
] as const;

function isCompleteCustomerEvidence(value: unknown): value is ShadowSourceCustomer {
  return (
    isPlainObject(value) && CUSTOMER_EVIDENCE_KEYS.every((key) => typeof value[key] === 'string')
  );
}

function mirroredCustomerKeys(source: ShadowSourceCustomer): MirroredCustomer {
  return {
    name: source.Name,
    org_number: source.OrganisationNumber,
    phone: source.Phone1,
    address_line1: source.Address1,
    address_line2: source.Address2,
    postal_code: source.ZipCode,
    city: source.City,
  };
}

export interface InvoiceDraftExpected extends Omit<InvoiceDraftBody, 'items'> {
  mirrored_customer: MirroredCustomer;
  status: 'draft';
  invoice_number: null;
  subtotal: number;
  vat_amount: number;
  total: number;
  remaining_amount: number;
  items: Array<InvoiceDraftExpectedItem | InvoiceDraftExpectedTextItem>;
}

export type InvoiceDraftMappingResult =
  | { blocked: string }
  | {
      request: InvoiceDraftBody;
      expected: InvoiceDraftExpected;
      sourceInvoiceId: string;
    };

export type CustomerIdentityLookup = (
  resource: ShadowResourceKind,
  sourceId: string,
) => ShadowIdentityResolution;

type ValidatedRow = {
  /** 'text' rows are purely descriptive and carry no amount, VAT, account or article. */
  kind: 'product' | 'text';
  description: string;
  quantity: number;
  unit: string;
  priceCents: number;
  accountNumber: string;
  articleNumber: string | null;
  netCents: number;
  vatCents: number;
};
type ValidatedDraft = {
  customerNumber: string;
  invoiceDate: string;
  dueDate: string;
  sourceInvoiceId: string;
  texts: {
    our_reference?: string;
    your_reference?: string;
    notes?: string;
    invoice_marking?: string;
    delivery_date?: string;
  };
  /** Populated invoice address that must equal the mirrored customer's address. */
  /** Populated customer-copied header values to compare with the mirrored customer. */
  copies: Record<string, string>;
  rows: ValidatedRow[];
  netCents: number;
  vatCents: number;
  totalCents: number;
};

type ValidationResult = { blocked: string } | ValidatedDraft;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_FIELDS = new Set([
  'CustomerNumber',
  'InvoiceDate',
  'DueDate',
  'Currency',
  'InvoiceRows',
]);
const ROW_FIELDS = new Set([
  'Description',
  'DeliveredQuantity',
  'Price',
  'VAT',
  'Unit',
  'AccountNumber',
  'ArticleNumber',
]);
const MAX_CUSTOMER_ID_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_QUANTITY = 10_000;
const MAX_UNIT_LENGTH = 50;
const MAX_UNIT_PRICE = 1_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCustomerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CUSTOMER_ID_LENGTH &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1]!;
}

function inputFieldsBlock(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  scope: 'header' | 'row',
): string | undefined {
  const keys = Reflect.ownKeys(value);
  const stringKeys = keys.filter((key): key is string => typeof key === 'string');
  if (stringKeys.length !== keys.length || stringKeys.length !== Object.keys(value).length) {
    return `Malformed invoice ${scope} fields.`;
  }
  const unsupported = stringKeys.filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    return `Unsupported invoice ${scope} fields: ${unsupported.join(', ')}.`;
  }
  return undefined;
}

function toCents(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return undefined;
  const difference = Math.abs(cents / 100 - value);
  if (difference > Number.EPSILON * Math.max(1, Math.abs(value))) return undefined;
  return cents;
}

function sourceDocumentId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function sourceQuantity(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const quantity = Number(value);
    if (Number.isSafeInteger(quantity) && quantity > 0) return quantity;
  }
  return undefined;
}

function sourceAccountNumber(value: unknown): string | undefined {
  let digits: string;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    digits = String(value);
  } else if (typeof value === 'string' && /^\d{1,4}$/.test(value)) {
    digits = value.padStart(4, '0');
  } else {
    return undefined;
  }
  return /^3\d{3}$/.test(digits) ? digits : undefined;
}

function explicitAccountNumber(value: unknown): string | undefined {
  return typeof value === 'string' && /^3\d{3}$/.test(value) ? value : undefined;
}

function amountMatches(value: unknown, expectedCents: number): boolean {
  return toCents(value) === expectedCents;
}

/** Stable refusal-reason prefixes for article-linked rows. */
export const ARTICLE_REFUSAL = {
  invalid: 'ARTICLE_NUMBER_INVALID',
  inputMismatch: 'ARTICLE_NUMBER_INPUT_MISMATCH',
  unmapped: 'ARTICLE_UNMAPPED',
  unresolved: 'ARTICLE_IDENTITY_UNRESOLVED',
  conflict: 'ARTICLE_IDENTITY_CONFLICT',
  malformed: 'ARTICLE_IDENTITY_MALFORMED',
} as const;

/** Stable refusal-reason prefixes for row shapes that are not mapped. */
export const ROW_REFUSAL = {
  /** Quantity 0 or negative on a row that is not purely descriptive. */
  nonpositiveQuantity: 'ROW_NONPOSITIVE_QUANTITY',
  /** An invoice made only of text rows has no amount to reconcile. */
  noProductRow: 'ROW_NO_PRODUCT_ROW',
  /** A text row (or its source) carries fields a purely descriptive row must not have. */
  textRowInvalid: 'ROW_TEXT_INVALID',
} as const;

/** Stable refusal-reason prefixes for invoice-level fields that are not mapped. */
export const INVOICE_REFUSAL = {
  /** Fortnox RoundOff is nonzero; Accounted's ore_rounding is display-only and stores no amount. */
  roundoffUnsupported: 'ROUNDOFF_UNSUPPORTED',
  /** Fortnox YourOrderNumber exceeds Accounted's 200-character invoice_marking limit. */
  yourOrderNumberTooLong: 'INVOICE_YOUR_ORDER_NUMBER_TOO_LONG',
  /** Fortnox internal Comments have no Accounted counterpart. */
  commentsUnsupported: 'INVOICE_COMMENTS_UNSUPPORTED',
  /** A delivery address field is populated; Accounted invoices carry no delivery address. */
  deliveryAddressUnsupported: 'INVOICE_DELIVERY_ADDRESS_UNSUPPORTED',
  /** Invoice address is populated but not equal to the mirrored customer's address. */
  addressMismatch: 'INVOICE_ADDRESS_MISMATCH',
  /** InvoiceReference / OrderReference / ContractReference links the invoice to another document. */
  linkedDocumentUnsupported: 'INVOICE_LINKED_DOCUMENT_UNSUPPORTED',
  /** The ready customer identity carries no complete, correctly typed mirrored customer evidence. */
  customerEvidenceMissing: 'INVOICE_CUSTOMER_EVIDENCE_MISSING',
  /** EDIInformation holds a populated field with no Accounted mapping. */
  ediUnsupported: 'INVOICE_EDI_UNSUPPORTED',
  /** EmailInformation / EDIInformation is not a plain object. */
  informationMalformed: 'INVOICE_INFORMATION_MALFORMED',
  /** A populated header field with no Accounted mapping (references, period, labels, vouchers ...). */
  fieldUnsupported: 'INVOICE_FIELD_UNSUPPORTED',
  /** A populated source key that no allowlist group covers. */
  fieldUnclassified: 'INVOICE_FIELD_UNCLASSIFIED',
  /** A mapped text header field (OurReference, YourReference, Remarks, YourOrderNumber) is not a string/null. */
  headerTextInvalid: 'INVOICE_HEADER_TEXT_INVALID',
} as const;

/**
 * Allowlist classification of every Fortnox invoice header key (docs/shadow-evaluation.md).
 * "Populated" means not undefined/null/''/[]; for the refused groups 0, '0' and false are
 * neutral ("none"). A key outside every group that is populated is refused as unclassified.
 *  - validated elsewhere against the confirmed amounts/settings (HEADER_VALIDATED);
 *  - mapped and verified on readback: OurReference -> our_reference, YourReference ->
 *    your_reference, Remarks -> notes, YourOrderNumber -> invoice_marking (max 200),
 *    DeliveryDate -> delivery_date (ISO date); all verbatim, empty -> omitted, and the target
 *    must hold none when not requested;
 *  - copied from the customer (HEADER_CUSTOMER_COPIED): Address1/2, ZipCode, City,
 *    OrganisationNumber, Phone1, Phone2 and CustomerName are neutral when empty and otherwise
 *    must equal the mirrored customer's value, which is also verified live on readback;
 *  - refused when populated: Comments, Delivery* address fields, document links, external
 *    references, period, labels, flags, reminders, voucher and payment data (HEADER_REFUSED);
 *  - derived/neutral Fortnox values (HEADER_DERIVED), not inspected.
 */
const HEADER_VALIDATED = new Set([
  'AccountingMethod',
  'AdministrationFee',
  'AdministrationFeeVAT',
  'Balance',
  'Booked',
  'Cancelled',
  'CostCenter',
  'Country',
  'Credit',
  'Currency',
  'CurrencyRate',
  'CurrencyUnit',
  'CustomerNumber',
  'DocumentNumber',
  'DueDate',
  'Freight',
  'FreightVAT',
  'HouseWork',
  'InvoiceDate',
  'InvoiceRows',
  'InvoiceType',
  'Net',
  'Project',
  'RoundOff',
  'Sent',
  'TaxReduction',
  'TaxReductionType',
  'Total',
  'TotalToPay',
  'TotalVAT',
  'VATIncluded',
]);
const HEADER_MAPPED = [
  ['OurReference', 'our_reference'],
  ['YourReference', 'your_reference'],
  ['Remarks', 'notes'],
  ['YourOrderNumber', 'invoice_marking'],
  ['DeliveryDate', 'delivery_date'],
] as const;
const ADDRESS_FIELDS = ['Address1', 'Address2', 'ZipCode', 'City'] as const;
const HEADER_CUSTOMER_COPIED = [
  ...ADDRESS_FIELDS,
  'OrganisationNumber',
  'Phone1',
  'Phone2',
  'CustomerName',
] as const;
const HEADER_DERIVED = new Set([
  '@url',
  '@urlTaxReductionList',
  'ContributionPercent',
  'ContributionValue',
  'Gross',
  'FinalPayDate',
  'OutboundDate',
  'PrintTemplate',
  'WarehouseReady',
  'Language',
  'PriceList',
  'TermsOfPayment',
  'OCR',
]);
const DELIVERY_FIELDS = [
  'DeliveryName',
  'DeliveryAddress1',
  'DeliveryAddress2',
  'DeliveryZipCode',
  'DeliveryCity',
  'DeliveryCountry',
] as const;
const LINK_FIELDS = [
  'InvoiceReference',
  'OrderReference',
  'ContractReference',
  'CreditInvoiceReference',
  'OfferReference',
  'TimeBasisReference',
] as const;
const OTHER_REFUSED_FIELDS = [
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
] as const;
const HEADER_CLASSIFIED = new Set<string>([
  'EDIInformation',
  'EmailInformation',
  ...HEADER_VALIDATED,
  ...HEADER_MAPPED.map(([field]) => field),
  ...HEADER_CUSTOMER_COPIED,
  ...HEADER_DERIVED,
  'Comments',
  ...DELIVERY_FIELDS,
  ...LINK_FIELDS,
  ...OTHER_REFUSED_FIELDS,
]);

/**
 * Invoice row keys: validated against the input/confirmed amounts (Description, DeliveredQuantity,
 * Price, VAT, Unit, AccountNumber, ArticleNumber, PriceExcludingVAT, TotalExcludingVAT, Total,
 * Discount, HouseWork, CostCenter, Project), Cost (the internal purchase cost: neutral only when
 * zero, otherwise refused) or derived/neutral Fortnox values (the rest). Any other populated row key
 * is refused as INVOICE_FIELD_UNCLASSIFIED.
 */
const ROW_CLASSIFIED = new Set([
  'Cost',
  'Description',
  'DeliveredQuantity',
  'Price',
  'VAT',
  'Unit',
  'AccountNumber',
  'ArticleNumber',
  'PriceExcludingVAT',
  'TotalExcludingVAT',
  'Total',
  'Discount',
  'HouseWork',
  'CostCenter',
  'Project',
  '@url',
  'ContributionPercent',
  'ContributionValue',
  'DiscountType',
  'HouseWorkHoursToReport',
  'HouseWorkType',
  'RowId',
  'StockPointCode',
  'VATCode',
  'OrderedQuantity',
]);

/**
 * EDIInformation nested keys: EDIStatus is neutral (transmission status); the others are refused
 * when populated; any other populated nested key is unclassified.
 * EmailInformation (EmailAddressFrom/To/CC/BCC, EmailSubject, EmailBody) is NEUTRAL by explicit
 * owner decision: e-mail delivery settings are not bookkeeping data and the shadow lane never
 * sends e-mail. Only its shape (plain object or absent) is validated.
 */
const EDI_REFUSED_KEYS = new Set([
  'EDIGlobalLocationNumber',
  'EDIGlobalLocationNumberDelivery',
  'EDIInvoiceExtra1',
  'EDIInvoiceExtra2',
  'EDIOurElectronicReference',
  'EDIYourElectronicReference',
]);

function emptyHeaderValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Empty, or a "none" marker (0, '0', false) for flag/link/number fields. */
function emptyLink(value: unknown): boolean {
  return emptyHeaderValue(value) || value === 0 || value === '0' || value === false;
}

/** Header fields beyond the amounts; returns a refusal or the validated pieces. */
function validateHeaderFields(
  source: Record<string, unknown>,
): { blocked: string } | { texts: ValidatedDraft['texts']; copies: Record<string, string> } {
  if (!emptyHeaderValue(source.Comments)) {
    return {
      blocked: `${INVOICE_REFUSAL.commentsUnsupported}: Comments has no Accounted mapping.`,
    };
  }
  for (const field of DELIVERY_FIELDS) {
    if (!emptyHeaderValue(source[field])) {
      return {
        blocked: `${INVOICE_REFUSAL.deliveryAddressUnsupported}: ${field} is populated; Accounted invoices have no delivery address.`,
      };
    }
  }
  for (const field of LINK_FIELDS) {
    if (!emptyLink(source[field])) {
      return {
        blocked: `${INVOICE_REFUSAL.linkedDocumentUnsupported}: ${field} links another document.`,
      };
    }
  }
  for (const field of OTHER_REFUSED_FIELDS) {
    if (!emptyLink(source[field])) {
      return {
        blocked: `${INVOICE_REFUSAL.fieldUnsupported}: ${field} is populated and has no Accounted mapping.`,
      };
    }
  }
  for (const field of ['EmailInformation', 'EDIInformation'] as const) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (!isPlainObject(value)) {
      return {
        blocked: `${INVOICE_REFUSAL.informationMalformed}: ${field} must be an object.`,
      };
    }
    if (field === 'EDIInformation') {
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'EDIStatus') continue;
        if (!EDI_REFUSED_KEYS.has(key)) {
          if (!emptyHeaderValue(nested)) {
            return {
              blocked: `${INVOICE_REFUSAL.fieldUnclassified}: populated source key EDIInformation.${key} is not classified.`,
            };
          }
        } else if (!emptyHeaderValue(nested)) {
          return {
            blocked: `${INVOICE_REFUSAL.ediUnsupported}: EDIInformation.${key} is populated and has no Accounted mapping.`,
          };
        }
      }
    }
  }
  for (const [field, value] of Object.entries(source)) {
    if (!HEADER_CLASSIFIED.has(field) && !emptyHeaderValue(value)) {
      return {
        blocked: `${INVOICE_REFUSAL.fieldUnclassified}: populated source key ${field} is not classified.`,
      };
    }
  }
  const texts: ValidatedDraft['texts'] = {};
  for (const [field, key] of HEADER_MAPPED) {
    const value = source[field];
    if (emptyHeaderValue(value)) continue;
    if (typeof value !== 'string') {
      return { blocked: `${INVOICE_REFUSAL.headerTextInvalid}: ${field} must be a string.` };
    }
    if (key === 'invoice_marking' && value.length > 200) {
      return {
        blocked: `${INVOICE_REFUSAL.yourOrderNumberTooLong}: YourOrderNumber exceeds 200 characters.`,
      };
    }
    if (key === 'delivery_date' && !isRealDate(value)) {
      return {
        blocked: `${INVOICE_REFUSAL.headerTextInvalid}: DeliveryDate must be a real ISO date.`,
      };
    }
    texts[key] = value;
  }
  const copies: Record<string, string> = {};
  for (const field of HEADER_CUSTOMER_COPIED) {
    const value = source[field];
    if (emptyHeaderValue(value)) continue;
    if (typeof value !== 'string') {
      return { blocked: `${INVOICE_REFUSAL.addressMismatch}: ${field} must be a string.` };
    }
    copies[field] = value;
  }
  return { texts, copies };
}

/** Stable refusal-reason prefix for invoice-row units. */
export const UNIT_REFUSAL = {
  invalid: 'UNIT_INVALID',
} as const;

/** A unit is exactly '' ("not specified") or an unpadded string without control characters. */
function isValidUnit(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  return (
    value.trim() === value &&
    value.length <= MAX_UNIT_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  );
}

/** ArticleNumber is an opaque string; never coerced, trimmed, or parsed as a number. */
function sourceArticleNumber(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value === 'string' &&
    value.length <= MAX_CUSTOMER_ID_LENGTH &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  ) {
    return value;
  }
  return undefined;
}

function absentOrZero(value: unknown): boolean {
  return value === undefined || value === 0;
}

/** Source numeric strings such as "0" are accepted for zero only. */
function sourceZero(value: unknown): boolean {
  return value === 0 || value === '0';
}

/**
 * A purely descriptive input row: no quantity, price, VAT, unit, account or article
 * (absent or the neutral zero/empty value). Anything priced or quantified is not text.
 */
function isTextInputRow(row: Record<string, unknown>): boolean {
  return (
    absentOrZero(row.DeliveredQuantity) &&
    absentOrZero(row.Price) &&
    absentOrZero(row.VAT) &&
    (row.Unit === undefined || row.Unit === '') &&
    (row.AccountNumber === undefined || row.AccountNumber === '') &&
    (row.ArticleNumber === undefined || row.ArticleNumber === '')
  );
}

/** Fortnox returns null for "no dimension"; null, absent and '' are all the empty dimension. */
function optionalDimensionIsEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Fortnox returns null/'none' for "no house-work (ROT/RUT) type"; any other value is real. */
function houseWorkTypeIsNone(value: unknown): boolean {
  return value === undefined || value === null || value === '' || value === 'none';
}

function validateDraft(record: ShadowRecord, binding: ShadowBinding): ValidationResult {
  if (
    !isPlainObject(record) ||
    !isPlainObject(binding) ||
    typeof binding.sourceCompany !== 'string' ||
    !binding.sourceCompany.trim() ||
    typeof binding.targetCompany !== 'string' ||
    !binding.targetCompany.trim()
  ) {
    return { blocked: 'Invoice draft company binding is missing.' };
  }
  if (
    record.sourceCompany !== binding.sourceCompany ||
    record.targetCompany !== binding.targetCompany
  ) {
    return { blocked: 'Invoice draft company binding does not match the record.' };
  }
  if (record.operation !== 'createInvoice') {
    return { blocked: 'Only createInvoice is supported for invoice draft mapping.' };
  }
  if (!Array.isArray(record.args) || record.args.length !== 1 || !isPlainObject(record.args[0])) {
    return { blocked: 'Invoice draft requires exactly one plain object argument.' };
  }

  const input = record.args[0];
  const unsupportedHeader = inputFieldsBlock(input, INPUT_FIELDS, 'header');
  if (unsupportedHeader) return { blocked: unsupportedHeader };
  for (const field of INPUT_FIELDS) {
    if (!Object.hasOwn(input, field)) return { blocked: `Invoice input is missing ${field}.` };
  }

  const customerNumber = input.CustomerNumber;
  if (!isCustomerId(customerNumber)) {
    return { blocked: 'CustomerNumber must be a nonempty, unpadded source identity.' };
  }
  if (!isRealDate(input.InvoiceDate))
    return { blocked: 'InvoiceDate must be a real YYYY-MM-DD date.' };
  if (!isRealDate(input.DueDate)) return { blocked: 'DueDate must be a real YYYY-MM-DD date.' };
  if (input.DueDate < input.InvoiceDate) {
    return { blocked: 'DueDate cannot be earlier than InvoiceDate.' };
  }
  if (input.Currency !== 'SEK') return { blocked: 'Only SEK invoice drafts are supported.' };

  if (!Array.isArray(input.InvoiceRows) || input.InvoiceRows.length === 0) {
    return { blocked: 'Invoice draft requires a nonempty ordered row array.' };
  }
  const rows: Array<ValidatedRow & { inputAccount?: string; inputArticle?: unknown }> = [];
  let netCents = 0;
  let vatCents = 0;
  let targetNet = 0;
  let targetVat = 0;
  for (const row of input.InvoiceRows) {
    if (!isPlainObject(row)) return { blocked: 'Invoice draft row must be a plain object.' };
    const unsupportedRow = inputFieldsBlock(row, ROW_FIELDS, 'row');
    if (unsupportedRow) return { blocked: unsupportedRow };

    if (isTextInputRow(row)) {
      const text = row.Description;
      if (
        typeof text !== 'string' ||
        text.trim().length === 0 ||
        text.length > MAX_DESCRIPTION_LENGTH
      ) {
        return {
          blocked: `${ROW_REFUSAL.textRowInvalid}: Text row Description must be nonempty and at most 2000 characters.`,
        };
      }
      rows.push({
        kind: 'text',
        articleNumber: null,
        description: text,
        quantity: 0,
        unit: '',
        priceCents: 0,
        accountNumber: '',
        netCents: 0,
        vatCents: 0,
      });
      continue;
    }

    const description = row.Description;
    if (
      typeof description !== 'string' ||
      description.trim().length === 0 ||
      description.length > MAX_DESCRIPTION_LENGTH
    ) {
      return { blocked: 'Description must be nonempty and at most 2000 characters.' };
    }
    const quantity = row.DeliveredQuantity;
    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      const reason = 'DeliveredQuantity must be an integer from 1 through 10000.';
      return {
        blocked:
          typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity < 1
            ? `${ROW_REFUSAL.nonpositiveQuantity}: ${reason}`
            : reason,
      };
    }
    const price = row.Price;
    if (
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > MAX_UNIT_PRICE
    ) {
      return { blocked: 'Price must be a positive SEK amount up to 1000000 with cent precision.' };
    }
    const priceCents = toCents(price);
    if (priceCents === undefined || priceCents <= 0) {
      return { blocked: 'Price must be a positive SEK amount up to 1000000 with cent precision.' };
    }
    if (row.VAT !== 25) return { blocked: 'Only 25 percent VAT is supported.' };
    const unit = row.Unit;
    if (!isValidUnit(unit)) {
      return {
        blocked: `${UNIT_REFUSAL.invalid}: Invoice product unit must be exactly empty or an unpadded string without control characters.`,
      };
    }

    const inputAccount = Object.hasOwn(row, 'AccountNumber')
      ? explicitAccountNumber(row.AccountNumber)
      : undefined;
    if (Object.hasOwn(row, 'AccountNumber') && inputAccount === undefined) {
      return { blocked: 'AccountNumber must be a four-digit class-3 account string.' };
    }

    const rowNet = priceCents * quantity;
    const rowVat = Math.round(rowNet / 4);
    if (!Number.isSafeInteger(rowNet) || !Number.isSafeInteger(rowVat))
      return { blocked: 'Invoice row exceeds safe integer-cent limits.' };
    netCents += rowNet;
    vatCents += rowVat;
    if (!Number.isSafeInteger(netCents) || !Number.isSafeInteger(vatCents))
      return { blocked: 'Invoice totals exceed safe integer-cent limits.' };
    // Match the pinned target's actual no-discount arithmetic, not an idealization.
    const actualNet = quantity * (priceCents / 100);
    const actualVat = Math.round(((actualNet * 25) / 100) * 100) / 100;
    if (actualNet !== rowNet / 100 || actualVat !== rowVat / 100)
      return { blocked: 'Target row arithmetic cannot preserve the source cents.' };
    targetNet += actualNet;
    targetVat += actualVat;
    rows.push({
      kind: 'product',
      articleNumber: null,
      description,
      quantity,
      unit,
      priceCents,
      inputAccount,
      inputArticle: Object.hasOwn(row, 'ArticleNumber') ? row.ArticleNumber : undefined,
      accountNumber: '',
      netCents: rowNet,
      vatCents: rowVat,
    });
  }
  if (!rows.some((row) => row.kind === 'product')) {
    return { blocked: `${ROW_REFUSAL.noProductRow}: Invoice needs at least one non-text row.` };
  }
  const totalCents = netCents + vatCents;
  if (!Number.isSafeInteger(totalCents))
    return { blocked: 'Invoice totals exceed safe integer-cent limits.' };
  if (
    targetNet !== netCents / 100 ||
    targetVat !== vatCents / 100 ||
    targetNet + targetVat !== totalCents / 100
  )
    return { blocked: 'Target aggregate arithmetic cannot preserve the source cents.' };

  if (!isPlainObject(record.sourceResult)) {
    return { blocked: 'A confirmed source invoice result is required.' };
  }
  const source = record.sourceResult;
  const sourceInvoiceId = sourceDocumentId(source.DocumentNumber);
  if (!sourceInvoiceId)
    return { blocked: 'A positive canonical source DocumentNumber is required.' };
  if (source.CustomerNumber !== customerNumber) {
    return { blocked: 'Confirmed source CustomerNumber does not match the invoice input.' };
  }
  if (source.InvoiceDate !== input.InvoiceDate || source.DueDate !== input.DueDate) {
    return { blocked: 'Confirmed source invoice dates do not match the invoice input.' };
  }
  if (source.Currency !== 'SEK')
    return { blocked: 'Confirmed source invoice currency must be SEK.' };
  if (source.AccountingMethod !== 'CASH') {
    return { blocked: 'Only confirmed CASH accounting method is supported.' };
  }
  if (source.InvoiceType !== 'INVOICE') {
    return { blocked: 'Only confirmed standard invoices are supported.' };
  }
  // Fortnox leaves the invoice Country empty for domestic customers whose customer record has no
  // country. The invoice copies no address, and the customer identity lookup below resolves only
  // for a customer the customer mapper confirmed as CountryCode SE (the readback also requires a
  // Swedish business customer). Together with SEK and 25 percent domestic VAT, '' is accepted;
  // any other country is still refused.
  if (source.Country !== 'Sverige' && source.Country !== '') {
    return { blocked: 'Only confirmed source country Sverige is supported.' };
  }
  if (source.Booked !== false || source.Sent !== false || source.Cancelled !== false) {
    return { blocked: 'Source invoice must be unbooked, unsent, and not cancelled.' };
  }
  if (source.Credit !== false && source.Credit !== 'false') {
    return { blocked: 'Credit invoices are not supported.' };
  }
  if (source.VATIncluded !== false || source.CurrencyRate !== 1 || source.CurrencyUnit !== 1) {
    return { blocked: 'Source invoice currency and VAT settings are unsupported.' };
  }
  if (source.RoundOff !== 0) {
    return {
      blocked: `${INVOICE_REFUSAL.roundoffUnsupported}: Accounted ore_rounding is display-only and stores no rounding amount.`,
    };
  }
  for (const field of ['AdministrationFee', 'AdministrationFeeVAT', 'Freight', 'FreightVAT']) {
    if (source[field] !== 0) return { blocked: `Confirmed source ${field} must be zero.` };
  }
  if (source.HouseWork !== false) return { blocked: 'HouseWork invoices are not supported.' };
  // Fortnox returns TaxReduction null for an invoice without a tax reduction. Null is the neutral
  // "none" only when the invoice and every row carry no house-work flag or type; otherwise (and for
  // any nonzero amount) the invoice is refused.
  if (source.TaxReduction !== 0) {
    const rowsClean =
      Array.isArray(source.InvoiceRows) &&
      source.InvoiceRows.every(
        (row) =>
          isPlainObject(row) && row.HouseWork === false && houseWorkTypeIsNone(row.HouseWorkType),
      );
    if (
      source.TaxReduction !== null ||
      !houseWorkTypeIsNone(source.TaxReductionType) ||
      !rowsClean
    ) {
      return { blocked: 'Confirmed source TaxReduction must be zero.' };
    }
  }
  if (!optionalDimensionIsEmpty(source.CostCenter) || !optionalDimensionIsEmpty(source.Project)) {
    return { blocked: 'Source CostCenter and Project must be empty.' };
  }

  const header = validateHeaderFields(source);
  if ('blocked' in header) return header;

  const headerAmounts: Array<[string, number]> = [
    ['Net', netCents],
    ['TotalVAT', vatCents],
    ['Total', totalCents],
    ['TotalToPay', totalCents],
    ['Balance', totalCents],
  ];
  for (const [field, expectedCents] of headerAmounts) {
    if (!amountMatches(source[field], expectedCents)) {
      return { blocked: `Confirmed source ${field} does not match the computed invoice amount.` };
    }
  }

  if (!Array.isArray(source.InvoiceRows) || source.InvoiceRows.length !== rows.length) {
    return { blocked: 'Confirmed source invoice must contain the same ordered row count.' };
  }
  for (let index = 0; index < rows.length; index++) {
    const validated = rows[index]!;
    const {
      description,
      unit,
      quantity,
      priceCents,
      inputAccount,
      inputArticle,
      netCents: rowNet,
    } = validated;
    const sourceRow = source.InvoiceRows[index];
    if (!isPlainObject(sourceRow)) return { blocked: 'Confirmed source invoice row is malformed.' };
    const cost = sourceRow.Cost;
    if (!emptyHeaderValue(cost) && cost !== 0 && cost !== '0') {
      return {
        blocked: `${INVOICE_REFUSAL.fieldUnsupported}: row Cost is populated and has no Accounted mapping.`,
      };
    }
    for (const [field, value] of Object.entries(sourceRow)) {
      if (!ROW_CLASSIFIED.has(field) && !emptyHeaderValue(value)) {
        return {
          blocked: `${INVOICE_REFUSAL.fieldUnclassified}: populated source row key ${field} is not classified.`,
        };
      }
    }
    if (validated.kind === 'text') {
      if (
        sourceRow.Description !== description ||
        sourceRow.Unit !== '' ||
        sourceRow.VAT !== 0 ||
        !sourceZero(sourceRow.DeliveredQuantity) ||
        !amountMatches(sourceRow.Price, 0) ||
        !amountMatches(sourceRow.PriceExcludingVAT, 0) ||
        !amountMatches(sourceRow.TotalExcludingVAT, 0) ||
        !amountMatches(sourceRow.Total, 0) ||
        sourceRow.Discount !== 0 ||
        sourceRow.HouseWork !== false ||
        !optionalDimensionIsEmpty(sourceRow.CostCenter) ||
        !optionalDimensionIsEmpty(sourceRow.Project) ||
        (sourceRow.ArticleNumber !== undefined && sourceRow.ArticleNumber !== '') ||
        (sourceRow.AccountNumber !== undefined &&
          sourceRow.AccountNumber !== '' &&
          !sourceZero(sourceRow.AccountNumber))
      ) {
        return {
          blocked: `${ROW_REFUSAL.textRowInvalid}: Confirmed source row is not a purely descriptive text row.`,
        };
      }
      continue;
    }
    if (sourceRow.Description !== description || sourceRow.Unit !== unit || sourceRow.VAT !== 25) {
      return {
        blocked: 'Confirmed source row description, unit, or VAT does not match the input.',
      };
    }
    if (sourceQuantity(sourceRow.DeliveredQuantity) !== quantity) {
      return { blocked: 'Confirmed source row quantity does not match the input.' };
    }
    if (
      !amountMatches(sourceRow.Price, priceCents) ||
      !amountMatches(sourceRow.PriceExcludingVAT, priceCents) ||
      !amountMatches(sourceRow.TotalExcludingVAT, rowNet) ||
      !amountMatches(sourceRow.Total, rowNet)
    ) {
      return { blocked: 'Confirmed source row amounts do not match the computed invoice amounts.' };
    }
    if (sourceRow.Discount !== 0) return { blocked: 'Source row discounts are not supported.' };
    if (sourceRow.HouseWork !== false) return { blocked: 'Source row HouseWork must be false.' };
    if (
      !optionalDimensionIsEmpty(sourceRow.CostCenter) ||
      !optionalDimensionIsEmpty(sourceRow.Project)
    ) {
      return { blocked: 'Source row CostCenter and Project must be empty.' };
    }
    const articleNumber = sourceArticleNumber(sourceRow.ArticleNumber);
    if (articleNumber === undefined) {
      return {
        blocked: `${ARTICLE_REFUSAL.invalid}: Source ArticleNumber must be an opaque nonblank string.`,
      };
    }
    if (inputArticle !== undefined) {
      const wanted = sourceArticleNumber(inputArticle);
      if (wanted === undefined || wanted !== articleNumber) {
        return {
          blocked: `${ARTICLE_REFUSAL.inputMismatch}: Input ArticleNumber does not match the confirmed source row.`,
        };
      }
    }
    validated.articleNumber = articleNumber;
    const accountNumber = sourceAccountNumber(sourceRow.AccountNumber);
    if (!accountNumber) {
      return { blocked: 'Confirmed source AccountNumber must be a four-digit class-3 account.' };
    }
    if (inputAccount !== undefined && inputAccount !== accountNumber) {
      return { blocked: 'Input AccountNumber does not match the confirmed source account.' };
    }

    validated.accountNumber = accountNumber;
  }

  return {
    customerNumber,
    invoiceDate: input.InvoiceDate,
    dueDate: input.DueDate,
    sourceInvoiceId,
    texts: header.texts,
    copies: header.copies,
    rows,
    netCents,
    vatCents,
    totalCents,
  };
}

function isMatchingCustomerIdentity(
  value: unknown,
  binding: ShadowBinding,
  sourceId: string,
): value is Extract<ShadowIdentityResolution, { state: 'ready' }> {
  return (
    isPlainObject(value) &&
    value.state === 'ready' &&
    value.resource === 'customer' &&
    value.sourceId === sourceId &&
    value.sourceCompany === binding.sourceCompany &&
    value.targetCompany === binding.targetCompany &&
    typeof value.targetId === 'string' &&
    UUID_PATTERN.test(value.targetId)
  );
}

function isMatchingArticleIdentity(
  value: unknown,
  binding: ShadowBinding,
  sourceId: string,
): value is Extract<ShadowIdentityResolution, { state: 'ready' }> {
  return (
    isPlainObject(value) &&
    value.state === 'ready' &&
    value.resource === 'article' &&
    value.sourceId === sourceId &&
    value.sourceCompany === binding.sourceCompany &&
    value.targetCompany === binding.targetCompany &&
    typeof value.targetId === 'string' &&
    UUID_PATTERN.test(value.targetId)
  );
}

function resolveArticle(
  lookup: CustomerIdentityLookup,
  binding: ShadowBinding,
  articleNumber: string,
): { blocked: string } | { targetId: string } {
  let resolution: ShadowIdentityResolution;
  try {
    resolution = lookup('article', articleNumber);
  } catch (cause) {
    return {
      blocked: `${ARTICLE_REFUSAL.unresolved}: Article identity lookup failed (${
        cause instanceof Error ? cause.name : 'error'
      }).`,
    };
  }
  const state = isPlainObject(resolution) ? resolution.state : undefined;
  if (state === 'missing') {
    return {
      blocked: `${ARTICLE_REFUSAL.unmapped}: Source article has no applied createArticle or baselineArticle receipt.`,
    };
  }
  if (state === 'unresolved') {
    return {
      blocked: `${ARTICLE_REFUSAL.unresolved}: Article identity receipt is incomplete or has an unknown outcome.`,
    };
  }
  if (state === 'conflict') {
    return {
      blocked: `${ARTICLE_REFUSAL.conflict}: Article identity is ambiguous or conflicting.`,
    };
  }
  if (!isMatchingArticleIdentity(resolution, binding, articleNumber)) {
    return { blocked: `${ARTICLE_REFUSAL.malformed}: Article identity evidence is malformed.` };
  }
  return { targetId: resolution.targetId };
}

/**
 * Purely map one confirmed standard invoice into a native draft request shape.
 * This does not call the target API or claim legal, accounting, or native behavior parity.
 */
export function mapInvoiceDraft(
  record: ShadowRecord,
  binding: ShadowBinding,
  lookup: CustomerIdentityLookup,
): InvoiceDraftMappingResult {
  const validated = validateDraft(record, binding);
  if ('blocked' in validated) return validated;

  const customer = lookup('customer', validated.customerNumber);
  if (!isMatchingCustomerIdentity(customer, binding, validated.customerNumber)) {
    return { blocked: 'Confirmed customer identity is missing, unresolved, or conflicting.' };
  }
  const mirrored = customer.sourceCustomer;
  if (!isCompleteCustomerEvidence(mirrored)) {
    return {
      blocked: `${INVOICE_REFUSAL.customerEvidenceMissing}: Customer identity lacks complete mirrored customer evidence.`,
    };
  }
  const copied = Object.entries(validated.copies);
  if (copied.length > 0) {
    const evidence = mirrored as unknown as Record<string, unknown>;
    for (const [field, value] of copied) {
      if (evidence[field === 'CustomerName' ? 'Name' : field] !== value) {
        return {
          blocked: `${INVOICE_REFUSAL.addressMismatch}: Invoice ${field} differs from the mirrored customer's value (Accounted uses the customer record).`,
        };
      }
    }
  }
  const mirroredCustomer = mirroredCustomerKeys(mirrored);

  const subtotal = validated.netCents / 100;
  const vatAmount = validated.vatCents / 100;
  const total = validated.totalCents / 100;
  const articleIds = new Map<string, string>();
  for (const row of validated.rows) {
    if (row.articleNumber === null || articleIds.has(row.articleNumber)) continue;
    const article = resolveArticle(lookup, binding, row.articleNumber);
    if ('blocked' in article) return article;
    articleIds.set(row.articleNumber, article.targetId.toLowerCase());
  }
  const items: Array<InvoiceDraftItem | InvoiceDraftTextItem> = validated.rows.map((row) =>
    row.kind === 'text'
      ? ({
          line_type: 'text',
          description: row.description,
          quantity: 0,
          unit: '',
          unit_price: 0,
        } as const)
      : productItem(row, articleIds),
  );
  function productItem(row: ValidatedRow, ids: Map<string, string>): InvoiceDraftItem {
    return {
      description: row.description,
      quantity: row.quantity,
      unit: row.unit,
      unit_price: row.priceCents / 100,
      vat_rate: 25,
      revenue_account: row.accountNumber,
      ...(row.articleNumber === null ? {} : { article_id: ids.get(row.articleNumber)! }),
    };
  }
  const request: InvoiceDraftBody = {
    customer_id: customer.targetId,
    invoice_date: validated.invoiceDate,
    due_date: validated.dueDate,
    currency: 'SEK',
    document_type: 'invoice',
    payment_link_auto: false,
    ore_rounding: false,
    ...validated.texts,
    items,
  };
  const expected: InvoiceDraftExpected = {
    customer_id: customer.targetId,
    invoice_date: validated.invoiceDate,
    due_date: validated.dueDate,
    currency: 'SEK',
    document_type: 'invoice',
    payment_link_auto: false,
    ore_rounding: false,
    ...validated.texts,
    mirrored_customer: mirroredCustomer,
    status: 'draft',
    invoice_number: null,
    subtotal,
    vat_amount: vatAmount,
    total,
    remaining_amount: total,
    items: validated.rows.map((row, index) => {
      const item = items[index]!;
      return 'line_type' in item
        ? ({ ...item, line_total: 0, vat_amount: 0 } as const)
        : ({
            ...item,
            line_total: row.netCents / 100,
            vat_amount: row.vatCents / 100,
            discount_percent: 0,
          } as const);
    }),
  };

  return { request, expected, sourceInvoiceId: validated.sourceInvoiceId };
}
