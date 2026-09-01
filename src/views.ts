import type { Column } from './formatter.js';

const currency = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));

export const referenceDataColumns: Column[] = [
  { key: 'Code', header: 'Code', width: 16 },
  { key: 'Name', header: 'Name', width: 24 },
  { key: 'Description', header: 'Description', width: 36 },
];

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

export const invoiceConfirmColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Booked', header: 'Booked', width: 5 },
  { key: 'Sent', header: 'Sent', width: 5 },
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
  { key: 'Type', header: 'Type', width: 8 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 20 },
  { key: 'Email', header: 'Email', width: 40 },
  // The real Fortnox field is Phone1 (there is no bare "Phone") — see the write
  // schema fix in tools/customers.ts for the same mismatch on the write side.
  { key: 'Phone1', header: 'Phone', width: 20 },
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

// Fortnox can void a single voucher row (`Removed: true`) without deleting it —
// the replacement row stays in the same voucher. Rendered plainly, a voided line
// is indistinguishable from a live one and reads as a double-booking, so mark it
// up front where truncation cannot hide it.
const voucherRowDescription = (value: unknown, row: Record<string, unknown>) => {
  const text = String(value ?? '');
  return row.Removed === true ? `[REMOVED] ${text}`.trimEnd() : text;
};

// 8 + 2 + 12 + 2 + 12 + 2 + 30 = 68
export const voucherRowColumns: Column[] = [
  { key: 'Account', header: 'Account', width: 8, align: 'right' },
  { key: 'Debit', header: 'Debit', width: 12, align: 'right', format: currency },
  { key: 'Credit', header: 'Credit', width: 12, align: 'right', format: currency },
  { key: 'Description', header: 'Description', width: 30, format: voucherRowDescription },
];

// --- Article views (target ≤80 cols) ---

// 10 + 2 + 30 + 2 + 10 + 2 + 6 + 2 + 10 = 74
export const articleListColumns: Column[] = [
  { key: 'ArticleNumber', header: 'Art #', width: 10, align: 'right' },
  { key: 'Description', header: 'Description', width: 30 },
  { key: 'SalesPrice', header: 'Price', width: 10, align: 'right', format: currency },
  { key: 'Unit', header: 'Unit', width: 6 },
  { key: 'Active', header: 'Active', width: 10 },
];

export const articleDetailColumns: Column[] = [
  { key: 'ArticleNumber', header: 'Article #', width: 20 },
  { key: 'Description', header: 'Description', width: 40 },
  { key: 'SalesPrice', header: 'Sales Price', width: 20, format: currency },
  { key: 'PurchasePrice', header: 'Purchase Price', width: 20, format: currency },
  { key: 'Unit', header: 'Unit', width: 10 },
  { key: 'SalesAccount', header: 'Sales Account', width: 10 },
  { key: 'VAT', header: 'VAT %', width: 10 },
  { key: 'Active', header: 'Active', width: 5 },
];

// --- Supplier views (target ≤80 cols) ---

// 7 + 2 + 25 + 2 + 12 + 2 + 12 + 2 + 14 = 78
export const supplierListColumns: Column[] = [
  { key: 'SupplierNumber', header: '#', width: 7, align: 'right' },
  { key: 'Name', header: 'Name', width: 25 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 12 },
  { key: 'City', header: 'City', width: 12 },
  { key: 'Email', header: 'Email', width: 14 },
];

export const supplierDetailColumns: Column[] = [
  { key: 'SupplierNumber', header: 'Supplier #', width: 20 },
  { key: 'Name', header: 'Name', width: 40 },
  { key: 'OrganisationNumber', header: 'Org Nr', width: 20 },
  { key: 'Email', header: 'Email', width: 40 },
  { key: 'Phone1', header: 'Phone', width: 20 },
  { key: 'Address1', header: 'Address', width: 40 },
  { key: 'ZipCode', header: 'Zip Code', width: 10 },
  { key: 'City', header: 'City', width: 20 },
  { key: 'BG', header: 'Bankgiro', width: 15 },
  { key: 'PG', header: 'Plusgiro', width: 15 },
  { key: 'BankAccountNumber', header: 'Bank Account', width: 20 },
];

// --- Supplier invoice views (target ≤80 cols) ---

// 7 + 2 + 20 + 2 + 10 + 2 + 10 + 2 + 10 + 2 + 10 = 77
export const supplierInvoiceListColumns: Column[] = [
  { key: 'GivenNumber', header: 'Inv #', width: 7, align: 'right' },
  { key: 'SupplierName', header: 'Supplier', width: 20 },
  { key: 'InvoiceDate', header: 'Date', width: 10 },
  { key: 'DueDate', header: 'Due', width: 10 },
  { key: 'Total', header: 'Total', width: 10, align: 'right', format: currency },
  { key: 'Balance', header: 'Balance', width: 10, align: 'right', format: currency },
];

export const supplierInvoiceDetailColumns: Column[] = [
  { key: 'GivenNumber', header: 'Given #', width: 20 },
  { key: 'SupplierNumber', header: 'Supplier #', width: 20 },
  { key: 'SupplierName', header: 'Supplier', width: 40 },
  { key: 'InvoiceNumber', header: 'Invoice Nr', width: 20 },
  { key: 'InvoiceDate', header: 'Invoice Date', width: 10 },
  { key: 'DueDate', header: 'Due Date', width: 10 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Balance', header: 'Balance', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Booked', header: 'Booked', width: 5 },
  { key: 'OCR', header: 'OCR', width: 20 },
  { key: 'Comments', header: 'Comments', width: 40 },
];

export const supplierInvoiceConfirmColumns: Column[] = [
  { key: 'GivenNumber', header: 'Given #', width: 20 },
  { key: 'SupplierNumber', header: 'Supplier #', width: 20 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Booked', header: 'Booked', width: 5 },
];

export const supplierInvoiceAttachmentColumns: Column[] = [
  { key: 'fileName', header: 'File', width: 40 },
  { key: 'fileId', header: 'File ID', width: 36 },
];

// --- Invoice payment views (target ≤80 cols) ---

// 8 + 2 + 10 + 2 + 10 + 2 + 12 + 2 + 10 + 2 + 10 = 70
export const invoicePaymentListColumns: Column[] = [
  { key: 'Number', header: '#', width: 8, align: 'right' },
  { key: 'InvoiceNumber', header: 'Invoice #', width: 10, align: 'right' },
  { key: 'PaymentDate', header: 'Date', width: 10 },
  { key: 'Amount', header: 'Amount', width: 12, align: 'right', format: currency },
  { key: 'Currency', header: 'Currency', width: 10 },
  { key: 'Source', header: 'Source', width: 10 },
];

export const invoicePaymentDetailColumns: Column[] = [
  { key: 'Number', header: 'Payment #', width: 20 },
  { key: 'InvoiceNumber', header: 'Invoice #', width: 20 },
  { key: 'PaymentDate', header: 'Payment Date', width: 10 },
  { key: 'Amount', header: 'Amount', width: 20, format: currency },
  { key: 'AmountCurrency', header: 'Amount (Currency)', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Source', header: 'Source', width: 20 },
];

// --- Supplier invoice payment views (target ≤80 cols) ---

export const supplierInvoicePaymentListColumns: Column[] = [
  { key: 'Number', header: '#', width: 8, align: 'right' },
  { key: 'InvoiceNumber', header: 'Invoice #', width: 10, align: 'right' },
  { key: 'PaymentDate', header: 'Date', width: 10 },
  { key: 'Amount', header: 'Amount', width: 12, align: 'right', format: currency },
  { key: 'Currency', header: 'Currency', width: 10 },
  { key: 'Source', header: 'Source', width: 10 },
];

export const supplierInvoicePaymentDetailColumns: Column[] = [
  { key: 'Number', header: 'Payment #', width: 20 },
  { key: 'InvoiceNumber', header: 'Invoice #', width: 20 },
  { key: 'PaymentDate', header: 'Payment Date', width: 10 },
  { key: 'Amount', header: 'Amount', width: 20, format: currency },
  { key: 'AmountCurrency', header: 'Amount (Currency)', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Source', header: 'Source', width: 20 },
];

// --- Offer views (target ≤80 cols) ---

// 7 + 2 + 20 + 2 + 10 + 2 + 10 + 2 + 10 + 2 + 10 = 77
export const offerListColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Doc #', width: 7, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 20 },
  { key: 'OfferDate', header: 'Date', width: 10 },
  { key: 'ExpireDate', header: 'Expires', width: 10 },
  { key: 'Total', header: 'Total', width: 10, align: 'right', format: currency },
  { key: 'Sent', header: 'Sent', width: 10 },
];

export const offerDetailColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'CustomerName', header: 'Customer', width: 40 },
  { key: 'OfferDate', header: 'Offer Date', width: 10 },
  { key: 'ExpireDate', header: 'Expire Date', width: 10 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Sent', header: 'Sent', width: 5 },
  { key: 'Cancelled', header: 'Cancelled', width: 5 },
  { key: 'OurReference', header: 'Our Reference', width: 30 },
  { key: 'YourReference', header: 'Your Reference', width: 30 },
];

export const offerConfirmColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Sent', header: 'Sent', width: 5 },
];

// --- Order views (target ≤80 cols) ---

// 7 + 2 + 20 + 2 + 10 + 2 + 10 + 2 + 10 + 2 + 10 = 77
export const orderListColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Doc #', width: 7, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 20 },
  { key: 'OrderDate', header: 'Date', width: 10 },
  { key: 'DeliveryDate', header: 'Delivery', width: 10 },
  { key: 'Total', header: 'Total', width: 10, align: 'right', format: currency },
  { key: 'Sent', header: 'Sent', width: 10 },
];

export const orderDetailColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'CustomerName', header: 'Customer', width: 40 },
  { key: 'OrderDate', header: 'Order Date', width: 10 },
  { key: 'DeliveryDate', header: 'Delivery Date', width: 10 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Currency', header: 'Currency', width: 5 },
  { key: 'Sent', header: 'Sent', width: 5 },
  { key: 'Cancelled', header: 'Cancelled', width: 5 },
  { key: 'OurReference', header: 'Our Reference', width: 30 },
  { key: 'YourReference', header: 'Your Reference', width: 30 },
];

export const orderConfirmColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 20 },
  { key: 'CustomerNumber', header: 'Customer #', width: 20 },
  { key: 'Total', header: 'Total', width: 20, format: currency },
  { key: 'Sent', header: 'Sent', width: 5 },
];

// --- Project views (target ≤80 cols) ---

// 10 + 2 + 30 + 2 + 10 + 2 + 10 + 2 + 10 = 78
export const projectListColumns: Column[] = [
  { key: 'ProjectNumber', header: 'Proj #', width: 10, align: 'right' },
  { key: 'Description', header: 'Description', width: 30 },
  { key: 'Status', header: 'Status', width: 10 },
  { key: 'StartDate', header: 'Start', width: 10 },
  { key: 'EndDate', header: 'End', width: 10 },
];

export const projectDetailColumns: Column[] = [
  { key: 'ProjectNumber', header: 'Project #', width: 20 },
  { key: 'Description', header: 'Description', width: 40 },
  { key: 'Status', header: 'Status', width: 10 },
  { key: 'StartDate', header: 'Start Date', width: 10 },
  { key: 'EndDate', header: 'End Date', width: 10 },
  { key: 'ContactPerson', header: 'Contact', width: 30 },
  { key: 'ProjectLeader', header: 'Leader', width: 30 },
  { key: 'Comments', header: 'Comments', width: 40 },
];

// --- Cost Center views (target ≤80 cols) ---

// 10 + 2 + 40 + 2 + 10 = 64
export const costCenterListColumns: Column[] = [
  { key: 'Code', header: 'Code', width: 10 },
  { key: 'Description', header: 'Description', width: 40 },
  { key: 'Active', header: 'Active', width: 10 },
];

export const costCenterDetailColumns: Column[] = [
  { key: 'Code', header: 'Code', width: 20 },
  { key: 'Description', header: 'Description', width: 40 },
  { key: 'Active', header: 'Active', width: 5 },
  { key: 'Note', header: 'Note', width: 40 },
];

// --- Tax Reduction views (target ≤80 cols) ---

// 6 + 2 + 20 + 2 + 5 + 2 + 10 + 2 + 12 + 2 + 12 = 75
export const taxReductionListColumns: Column[] = [
  { key: 'Id', header: 'ID', width: 6, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 20 },
  { key: 'TypeOfReduction', header: 'Type', width: 5 },
  { key: 'ReferenceNumber', header: 'Ref #', width: 10 },
  { key: 'AskedAmount', header: 'Asked', width: 12, align: 'right', format: currency },
  { key: 'ApprovedAmount', header: 'Approved', width: 12, align: 'right', format: currency },
];

export const taxReductionDetailColumns: Column[] = [
  { key: 'Id', header: 'ID', width: 10 },
  { key: 'CustomerName', header: 'Customer', width: 40 },
  { key: 'TypeOfReduction', header: 'Type', width: 5 },
  { key: 'ReferenceNumber', header: 'Reference #', width: 20 },
  { key: 'ReferenceDocumentType', header: 'Doc Type', width: 10 },
  { key: 'AskedAmount', header: 'Asked Amount', width: 20, format: currency },
  { key: 'ApprovedAmount', header: 'Approved Amount', width: 20, format: currency },
  { key: 'PropertyDesignation', header: 'Property', width: 30 },
];

// --- Price List views (target ≤80 cols) ---

// 10 + 2 + 30 + 2 + 20 + 2 + 10 = 76
export const priceListListColumns: Column[] = [
  { key: 'Code', header: 'Code', width: 10 },
  { key: 'Description', header: 'Description', width: 30 },
  { key: 'Comments', header: 'Comments', width: 20 },
  { key: 'PreSelected', header: 'Default', width: 10 },
];

export const priceListDetailColumns: Column[] = [
  { key: 'Code', header: 'Code', width: 20 },
  { key: 'Description', header: 'Description', width: 40 },
  { key: 'Comments', header: 'Comments', width: 40 },
  { key: 'PreSelected', header: 'Pre-selected', width: 5 },
];

// --- Price views (target ≤80 cols) ---

// 12 + 2 + 10 + 2 + 12 + 2 + 12 + 2 + 10 = 64
export const priceListColumns: Column[] = [
  { key: 'ArticleNumber', header: 'Article #', width: 12 },
  { key: 'PriceList', header: 'List', width: 10 },
  { key: 'Price', header: 'Price', width: 12, align: 'right', format: currency },
  { key: 'FromQuantity', header: 'From Qty', width: 12, align: 'right' },
  { key: 'Percent', header: 'Discount %', width: 10, align: 'right' },
];

export const priceDetailColumns: Column[] = [
  { key: 'ArticleNumber', header: 'Article #', width: 20 },
  { key: 'PriceList', header: 'Price List', width: 20 },
  { key: 'Price', header: 'Price', width: 20, format: currency },
  { key: 'FromQuantity', header: 'From Quantity', width: 20 },
  { key: 'Percent', header: 'Discount %', width: 10 },
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

// --- Financial year views ---

export const financialYearListColumns: Column[] = [
  { key: 'Id', header: 'Id', width: 4, align: 'right' },
  { key: 'FromDate', header: 'From', width: 10 },
  { key: 'ToDate', header: 'To', width: 10 },
  { key: 'AccountingMethod', header: 'Method', width: 8 },
  { key: 'AccountChartType', header: 'Account Chart', width: 30 },
];

export const financialYearDetailColumns: Column[] = financialYearListColumns;

export const lockedPeriodDetailColumns: Column[] = [
  { key: 'EndDate', header: 'Locked Through', width: 10 },
];

// --- Contract views ---

export const contractListColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Doc #', width: 7, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 20 },
  { key: 'PeriodStart', header: 'Start', width: 10 },
  { key: 'PeriodEnd', header: 'End', width: 10 },
  { key: 'InvoiceInterval', header: 'Interval', width: 8, align: 'right' },
  { key: 'Continuous', header: 'Cont.', width: 5 },
  { key: 'Total', header: 'Total', width: 10, align: 'right', format: currency },
];

export const contractDetailColumns: Column[] = [
  { key: 'DocumentNumber', header: 'Document #', width: 10 },
  { key: 'CustomerNumber', header: 'Customer #', width: 10 },
  { key: 'CustomerName', header: 'Customer', width: 30 },
  { key: 'Active', header: 'Active', width: 5 },
  { key: 'Continuous', header: 'Continuous', width: 5 },
  { key: 'ContractDate', header: 'Contract Date', width: 10 },
  { key: 'ContractLength', header: 'Length (months)', width: 6, align: 'right' },
  { key: 'PeriodStart', header: 'Period Start', width: 10 },
  { key: 'PeriodEnd', header: 'Period End', width: 10 },
  { key: 'InvoiceInterval', header: 'Invoice Interval', width: 6, align: 'right' },
  { key: 'InvoicesRemaining', header: 'Invoices Remaining', width: 6, align: 'right' },
  { key: 'LastInvoiceDate', header: 'Last Invoice', width: 10 },
  { key: 'Total', header: 'Total', width: 12, align: 'right', format: currency },
  { key: 'TotalVAT', header: 'VAT', width: 12, align: 'right', format: currency },
  { key: 'Comments', header: 'Comments', width: 40 },
];

// --- Recurring billing views ---

export const recurringListColumns: Column[] = [
  { key: 'serial_number', header: '#', width: 7, align: 'right' },
  { key: 'id', header: 'ID', width: 36 },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'invoice_handling', header: 'Handling', width: 12 },
  { key: 'created_at', header: 'Created', width: 20 },
];

export const recurringDetailColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'serial_number', header: 'Serial #', width: 10, align: 'right' },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'invoice_handling', header: 'Invoice handling', width: 16 },
  { key: 'amount_per_invoicing', header: 'Periods/invoice', width: 10, align: 'right' },
  { key: 'created_at', header: 'Created', width: 20 },
  { key: 'modified_at', header: 'Modified', width: 20 },
  { key: 'etag', header: 'ETag', width: 36 },
  { key: 'last_modified', header: 'Last-Modified', width: 29 },
];

export const invoiceRequestListColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'processing_mode', header: 'Mode', width: 8 },
  { key: 'created_at', header: 'Created', width: 20 },
  { key: 'processed_at', header: 'Processed', width: 20 },
];

export const invoiceRequestDetailColumns: Column[] = invoiceRequestListColumns;

// --- Analytics views ---

export const topCustomerColumns: Column[] = [
  { key: 'CustomerNumber', header: 'Cust #', width: 8, align: 'right' },
  { key: 'CustomerName', header: 'Customer', width: 30 },
  { key: 'total', header: 'Invoiced', width: 14, align: 'right', format: currency },
  { key: 'invoiceCount', header: 'Invoices', width: 8, align: 'right' },
];

export const monthlyRevenueColumns: Column[] = [
  { key: 'month', header: 'Month', width: 7 },
  { key: 'total', header: 'Invoiced', width: 14, align: 'right', format: currency },
  { key: 'invoiceCount', header: 'Invoices', width: 8, align: 'right' },
];

// --- Voucher file attachment views ---

export const voucherAttachmentColumns: Column[] = [
  { key: 'fileName', header: 'File', width: 40 },
  { key: 'fileId', header: 'File ID', width: 36 },
  { key: 'voucherYear', header: 'Year', width: 5, align: 'right' },
];

// --- Invoice file attachment views ---

export const invoiceAttachmentColumns: Column[] = [
  { key: 'fileName', header: 'File', width: 40 },
  { key: 'fileId', header: 'File ID', width: 36 },
  { key: 'includeOnSend', header: 'On send', width: 8 },
];

export const invoiceAttachmentListColumns: Column[] = [
  { key: 'fileId', header: 'File ID', width: 36 },
  { key: 'includeOnSend', header: 'On send', width: 8 },
  { key: 'id', header: 'Attachment ID', width: 36 },
];

// --- Payroll / Lön views (target ≤80 cols) ---

const redactPayrollValue = (): string => '[redacted — use JSON/includeRaw for explicit access]';

// Employees
export const employeeListColumns: Column[] = [
  { key: 'EmployeeId', header: 'Emp #', width: 12 },
  { key: 'FullName', header: 'Name', width: 26 },
  { key: 'JobTitle', header: 'Title', width: 20 },
  { key: 'Inactive', header: 'Inactive', width: 8 },
];

export const employeeDetailColumns: Column[] = [
  { key: 'EmployeeId', header: 'Employee #', width: 15 },
  { key: 'FirstName', header: 'First Name', width: 20 },
  { key: 'LastName', header: 'Last Name', width: 20 },
  { key: 'FullName', header: 'Full Name', width: 30 },
  { key: 'Email', header: 'Email', width: 30 },
  {
    key: 'PersonalIdentityNumber',
    header: 'Personnr',
    width: 14,
    format: redactPayrollValue,
  },
  { key: 'JobTitle', header: 'Job Title', width: 30 },
  { key: 'EmploymentDate', header: 'Employed', width: 10 },
  { key: 'EmployedTo', header: 'Employed To', width: 10 },
  { key: 'EmploymentForm', header: 'Form', width: 6 },
  { key: 'PersonelType', header: 'Type', width: 6 },
  { key: 'SalaryForm', header: 'Salary Form', width: 6 },
  {
    key: 'MonthlySalary',
    header: 'Monthly',
    width: 12,
    align: 'right',
    format: redactPayrollValue,
  },
  {
    key: 'HourlyPay',
    header: 'Hourly',
    width: 12,
    align: 'right',
    format: redactPayrollValue,
  },
  { key: 'TaxTable', header: 'Tax Table', width: 10 },
  { key: 'TaxColumn', header: 'Tax Col', width: 7, align: 'right' },
  { key: 'Inactive', header: 'Inactive', width: 8 },
];

// Salary transactions
export const salaryTransactionListColumns: Column[] = [
  { key: 'SalaryRow', header: 'Row', width: 8, align: 'right' },
  { key: 'EmployeeId', header: 'Emp #', width: 12 },
  { key: 'SalaryCode', header: 'Code', width: 10 },
  { key: 'Date', header: 'Date', width: 12 },
  { key: 'Amount', header: 'Amount', width: 12, align: 'right' },
];

export const salaryTransactionDetailColumns: Column[] = [
  { key: 'SalaryRow', header: 'Row', width: 10, align: 'right' },
  { key: 'EmployeeId', header: 'Employee #', width: 15 },
  { key: 'SalaryCode', header: 'Salary Code', width: 12 },
  { key: 'Date', header: 'Date', width: 12 },
  { key: 'Amount', header: 'Amount', width: 12, align: 'right' },
  { key: 'Number', header: 'Number', width: 12 },
  { key: 'CostCenter', header: 'Cost Center', width: 12 },
  { key: 'Project', header: 'Project', width: 12 },
  { key: 'Expense', header: 'Expense', width: 8 },
  { key: 'TextRow', header: 'Text', width: 40 },
  { key: 'Total', header: 'Total', width: 12, align: 'right' },
  { key: 'VAT', header: 'VAT', width: 10, align: 'right' },
];

// Attendance transactions
export const attendanceTransactionListColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'EmployeeId', header: 'Emp #', width: 12 },
  { key: 'CauseCode', header: 'Cause', width: 6 },
  { key: 'Date', header: 'Date', width: 10 },
  { key: 'Hours', header: 'Hours', width: 6, align: 'right' },
];

export const attendanceTransactionDetailColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'EmployeeId', header: 'Employee #', width: 15 },
  { key: 'CauseCode', header: 'Cause Code', width: 10 },
  { key: 'Date', header: 'Date', width: 12 },
  { key: 'Hours', header: 'Hours', width: 10, align: 'right' },
  { key: 'CostCenter', header: 'Cost Center', width: 12 },
  { key: 'Project', header: 'Project', width: 12 },
];

// Absence transactions
export const absenceTransactionListColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'EmployeeId', header: 'Emp #', width: 12 },
  { key: 'CauseCode', header: 'Cause', width: 6 },
  { key: 'Date', header: 'Date', width: 10 },
  { key: 'Hours', header: 'Hours', width: 6, align: 'right' },
];

export const absenceTransactionDetailColumns: Column[] = [
  { key: 'id', header: 'ID', width: 36 },
  { key: 'EmployeeId', header: 'Employee #', width: 15 },
  { key: 'CauseCode', header: 'Cause Code', width: 10 },
  { key: 'Date', header: 'Date', width: 12 },
  { key: 'Hours', header: 'Hours', width: 10, align: 'right' },
  { key: 'Extent', header: 'Extent', width: 8, align: 'right' },
  { key: 'HolidayEntitling', header: 'Holiday', width: 8 },
  { key: 'CostCenter', header: 'Cost Center', width: 12 },
  { key: 'Project', header: 'Project', width: 12 },
];

// Schedule times
export const scheduleTimeDetailColumns: Column[] = [
  { key: 'EmployeeId', header: 'Employee #', width: 15 },
  { key: 'Date', header: 'Date', width: 12 },
  { key: 'Hours', header: 'Hours', width: 10, align: 'right' },
  { key: 'ScheduleId', header: 'Schedule', width: 12 },
  { key: 'IWH1', header: 'IWH1', width: 8 },
  { key: 'IWH2', header: 'IWH2', width: 8 },
  { key: 'IWH3', header: 'IWH3', width: 8 },
  { key: 'IWH4', header: 'IWH4', width: 8 },
  { key: 'IWH5', header: 'IWH5', width: 8 },
];
