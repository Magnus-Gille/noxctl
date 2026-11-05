import type { ShadowBinding, ShadowRecord } from './types.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from './identity.js';

export interface InvoiceDraftItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  vat_rate: 25;
  revenue_account: string;
}

export interface InvoiceDraftBody {
  customer_id: string;
  invoice_date: string;
  due_date: string;
  currency: 'SEK';
  document_type: 'invoice';
  payment_link_auto: false;
  ore_rounding: false;
  items: InvoiceDraftItem[];
}

export interface InvoiceDraftExpectedItem extends InvoiceDraftItem {
  line_total: number;
  vat_amount: number;
  discount_percent: 0;
}

export interface InvoiceDraftExpected extends Omit<InvoiceDraftBody, 'items'> {
  status: 'draft';
  invoice_number: null;
  subtotal: number;
  vat_amount: number;
  total: number;
  remaining_amount: number;
  items: InvoiceDraftExpectedItem[];
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
  description: string;
  quantity: number;
  unit: string;
  priceCents: number;
  accountNumber: string;
  netCents: number;
  vatCents: number;
};
type ValidatedDraft = {
  customerNumber: string;
  invoiceDate: string;
  dueDate: string;
  sourceInvoiceId: string;
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
]);
const MAX_CUSTOMER_ID_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_QUANTITY = 10_000;
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

function optionalDimensionIsEmpty(value: unknown): boolean {
  return value === undefined || value === '';
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
  const rows: Array<ValidatedRow & { inputAccount?: string }> = [];
  let netCents = 0;
  let vatCents = 0;
  let targetNet = 0;
  let targetVat = 0;
  for (const row of input.InvoiceRows) {
    if (!isPlainObject(row)) return { blocked: 'Invoice draft row must be a plain object.' };
    const unsupportedRow = inputFieldsBlock(row, ROW_FIELDS, 'row');
    if (unsupportedRow) return { blocked: unsupportedRow };

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
      return { blocked: 'DeliveredQuantity must be an integer from 1 through 10000.' };
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
    if (typeof unit !== 'string' || !unit.trim())
      return { blocked: 'Invoice product unit must be a nonblank string.' };

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
      description,
      quantity,
      unit,
      priceCents,
      inputAccount,
      accountNumber: '',
      netCents: rowNet,
      vatCents: rowVat,
    });
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
  if (source.Country !== 'Sverige') {
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
  for (const field of [
    'AdministrationFee',
    'AdministrationFeeVAT',
    'Freight',
    'FreightVAT',
    'RoundOff',
    'TaxReduction',
  ]) {
    if (source[field] !== 0) return { blocked: `Confirmed source ${field} must be zero.` };
  }
  if (source.HouseWork !== false) return { blocked: 'HouseWork invoices are not supported.' };
  if (!optionalDimensionIsEmpty(source.CostCenter) || !optionalDimensionIsEmpty(source.Project)) {
    return { blocked: 'Source CostCenter and Project must be empty.' };
  }

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
    const { description, unit, quantity, priceCents, inputAccount, netCents: rowNet } = validated;
    const sourceRow = source.InvoiceRows[index];
    if (!isPlainObject(sourceRow)) return { blocked: 'Confirmed source invoice row is malformed.' };
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
    if (!optionalDimensionIsEmpty(sourceRow.ArticleNumber)) {
      return { blocked: 'Source ArticleNumber catalog links are not supported.' };
    }
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

  const subtotal = validated.netCents / 100;
  const vatAmount = validated.vatCents / 100;
  const total = validated.totalCents / 100;
  const items: InvoiceDraftItem[] = validated.rows.map((row) => ({
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    unit_price: row.priceCents / 100,
    vat_rate: 25,
    revenue_account: row.accountNumber,
  }));
  const request: InvoiceDraftBody = {
    customer_id: customer.targetId,
    invoice_date: validated.invoiceDate,
    due_date: validated.dueDate,
    currency: 'SEK',
    document_type: 'invoice',
    payment_link_auto: false,
    ore_rounding: false,
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
    status: 'draft',
    invoice_number: null,
    subtotal,
    vat_amount: vatAmount,
    total,
    remaining_amount: total,
    items: validated.rows.map((row, index) => ({
      ...items[index]!,
      line_total: row.netCents / 100,
      vat_amount: row.vatCents / 100,
      discount_percent: 0,
    })),
  };

  return { request, expected, sourceInvoiceId: validated.sourceInvoiceId };
}
