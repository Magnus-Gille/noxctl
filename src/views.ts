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

// 8 + 2 + 12 + 2 + 12 + 2 + 30 = 68
export const voucherRowColumns: Column[] = [
  { key: 'Account', header: 'Account', width: 8, align: 'right' },
  { key: 'Debit', header: 'Debit', width: 12, align: 'right', format: currency },
  { key: 'Credit', header: 'Credit', width: 12, align: 'right', format: currency },
  { key: 'Description', header: 'Description', width: 30 },
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
