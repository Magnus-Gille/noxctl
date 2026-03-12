import type { Column } from './formatter.js';

const currency = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));

// --- Invoice views (target ≤80 cols) ---

// 7 + 2 + 20 + 2 + 10 + 2 + 10 + 2 + 10 + 2 + 10 = 77
export const invoiceListColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Doc #', width: 7, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 20 },
  { key: 'InvoiceDate', header: 'Date', width: 10 },
  { key: 'DueDate', header: 'Due', width: 10 },
  { key: 'Total', header: 'Total', width: 10, align: 'right', format: currency },
  { key: 'Balance', header: 'Balance', width: 10, align: 'right', format: currency },
];

export const invoiceDetailColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'CustomerName', header: 'Customer', width: 40 },
  { key: 'InvoiceDate', header: 'Invoice Date', width: 10 },
  { key: 'DueDate', header: 'Due Date', width: 10 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Balance', header: 'Balance', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Booked', header: 'Booked', width: 5 },
  { key: 'Sent', header: 'Sent', width: 5 },
  { key: 'OurReference', header: 'Our Reference', width: 30 },
  { key: 'CreditInvoiceReference', header: 'Credit Ref', width: 20 },
];

// --- Customer views (target ≤80 cols) ---

// 7 + 2 + 25 + 2 + 12 + 2 + 12 + 2 + 14 = 78
export const customerListColumns: Column[] = [
  { key: 'CustomerNumber', header: '#', width: 7, align: 'right' },
  { key: 'Name', header: 'Name', width: 25 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 12 },
  { key: 'City', header: 'City', width: 12 },
  { key: 'Email', header: 'Email', width: 14 },
];

export const customerDetailColumns: Column[] = [
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'Name', header: 'Name', width: 40 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 20 },
  { key: 'Email', header: 'Email', width: 40 },
  { key: 'Phone', header: 'Phone', width: 20 },
  { key: 'Address1', header: 'Address', width: 40 },
  { key: 'ZipCode', header: 'Zip Code', width: 10 },
  { key: 'City', header: 'City', width: 20 },
  { key: 'Country', header: 'Country', width: 5 },
  { key: 'VATNumber', header: 'VAT Number', width: 20 },
];

// --- Voucher views (target ≤80 cols) ---

// 6 + 2 + 7 + 2 + 10 + 2 + 45 = 74
export const voucherListColumns: Column[] = [
  { key: 'VoucherSeries', header: 'Series', width: 6 },
  { key: 'VoucherNumber', header: 'Number', width: 7, align: 'right' },
  { key: 'TransactionDate', header: 'Date', width: 10 },
  { key: 'Description', header: 'Description', width: 45 },
];

export const voucherDetailColumns: Column[] = [
  { key: 'VoucherSeries', header: 'Series', width: 10 },
  { key: 'VoucherNumber', header: 'Number', width: 10 },
  { key: 'TransactionDate', header: 'Date', width: 10 },
  { key: 'Description', header: 'Description', width: 50 },
];

// --- Account views (target ≤80 cols) ---

// 8 + 2 + 50 + 2 + 6 = 68
export const accountListColumns: Column[] = [
  { key: 'Number', header: 'Account', width: 8, align: 'right' },
  { key: 'Description', header: 'Description', width: 50 },
  { key: 'SRU', header: 'SRU', width: 6, align: 'right' },
];

// --- Company views ---

export const companyDetailColumns: Column[] = [
  { key: 'CompanyName', header: 'Company', width: 40 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 20 },
  { key: 'Address', header: 'Address', width: 40 },
  { key: 'ZipCode', header: 'Zip Code', width: 10 },
  { key: 'City', header: 'City', width: 20 },
  { key: 'Country', header: 'Country', width: 5 },
  { key: 'Email', header: 'Email', width: 40 },
  { key: 'DatabaseNumber', header: 'Database #', width: 10 },
];
