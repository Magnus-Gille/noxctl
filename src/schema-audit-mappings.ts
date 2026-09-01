import type { MutationAuditException, SchemaAuditMapping } from './schema-audit.js';

const root = (id: string, toolName: string, specSchemaName: string): SchemaAuditMapping => ({
  id,
  toolName,
  toolSchemaPointer: '',
  specSchemaName,
});

/**
 * Reviewed structured mutation contracts. Component identifiers are already
 * represented in the committed opaque API fingerprint; property inventories
 * and raw diagnostics remain confined to the ignored local OpenAPI cache.
 */
export const SCHEMA_AUDIT_MAPPINGS: readonly SchemaAuditMapping[] = [
  root(
    'absence-create',
    'fortnox_create_absencetransaction',
    'fortnox_Lon_AbsenceTransactionsSinglePayloadItem',
  ),
  root(
    'absence-update',
    'fortnox_update_absencetransaction',
    'fortnox_Lon_AbsenceTransactionsSinglePayloadItem',
  ),
  root('account-create', 'fortnox_create_account', 'fortnox_Bf_AccountSinglePayloadItem'),
  root('account-update', 'fortnox_update_account', 'fortnox_Bf_AccountSinglePayloadItem'),
  root('article-create', 'fortnox_create_article', 'fortnox_ArticleSinglePayloadItem'),
  root('article-update', 'fortnox_update_article', 'fortnox_ArticleSinglePayloadItem'),
  root(
    'attendance-create',
    'fortnox_create_attendancetransaction',
    'fortnox_Lon_AttendanceTransactionsSinglePayloadItem',
  ),
  root(
    'attendance-update',
    'fortnox_update_attendancetransaction',
    'fortnox_Lon_AttendanceTransactionsSinglePayloadItem',
  ),
  root(
    'contract-accrual-create',
    'fortnox_create_contract_accrual',
    'fortnox_ContractInvoice_ContractAccrualSinglePayloadItem',
  ),
  root(
    'contract-accrual-update',
    'fortnox_update_contract_accrual',
    'fortnox_ContractInvoice_ContractAccrualSinglePayloadItem',
  ),
  root(
    'contract-create',
    'fortnox_create_contract',
    'fortnox_ContractInvoice_ContractCreatePayload',
  ),
  root(
    'contract-update',
    'fortnox_update_contract',
    'fortnox_ContractInvoice_ContractUpdatePayload',
  ),
  root('cost-center-create', 'fortnox_create_costcenter', 'fortnox_CostCenterSinglePayloadItem'),
  root('cost-center-update', 'fortnox_update_costcenter', 'fortnox_CostCenterSinglePayloadItem'),
  root('customer', 'fortnox_create_customer', 'fortnox_Kf_CustomerSinglePayloadItem'),
  root('customer-update', 'fortnox_update_customer', 'fortnox_Kf_CustomerSinglePayloadItem'),
  root('employee-create', 'fortnox_create_employee', 'fortnox_Lon_EmployeeSinglePayloadItem'),
  root('employee-update', 'fortnox_update_employee', 'fortnox_Lon_EmployeeSinglePayloadItem'),
  root(
    'financial-year-create',
    'fortnox_create_financialyear',
    'fortnox_Bf_FinancialYearSinglePayloadItem',
  ),
  root(
    'invoice-accrual-create',
    'fortnox_create_invoice_accrual',
    'fortnox_Kf_InvoiceAccrualSinglePayloadItem',
  ),
  root(
    'invoice-accrual-update',
    'fortnox_update_invoice_accrual',
    'fortnox_Kf_InvoiceAccrualSinglePayloadItem',
  ),
  root('invoice-create', 'fortnox_create_invoice', 'fortnox_Kf_InvoiceSinglePayloadItem'),
  root('invoice-update', 'fortnox_update_invoice', 'fortnox_Kf_InvoiceSinglePayloadItem'),
  root(
    'invoice-payment-create',
    'fortnox_create_invoice_payment',
    'fortnox_Kf_InvoicePaymentSinglePayloadItem',
  ),
  root(
    'invoice-payment-update',
    'fortnox_update_invoice_payment',
    'fortnox_Kf_InvoicePaymentSinglePayloadItem',
  ),
  root('offer-create', 'fortnox_create_offer', 'fortnox_Offer_OfferSinglePayloadItem'),
  root('offer-update', 'fortnox_update_offer', 'fortnox_Offer_OfferSinglePayloadItem'),
  root('order-create', 'fortnox_create_order', 'fortnox_Order_OrderSinglePayloadItem'),
  root('order-update', 'fortnox_update_order', 'fortnox_Order_OrderSinglePayloadItem'),
  root('price-create', 'fortnox_create_price', 'fortnox_PriceSinglePayloadItem'),
  root('price-update', 'fortnox_update_price', 'fortnox_PriceSinglePayloadItem'),
  root('price-list-create', 'fortnox_create_pricelist', 'fortnox_PriceListSinglePayloadItem'),
  root('price-list-update', 'fortnox_update_pricelist', 'fortnox_PriceListSinglePayloadItem'),
  root('project-create', 'fortnox_create_project', 'fortnox_Project_ProjectSinglePayloadItem'),
  root('project-update', 'fortnox_update_project', 'fortnox_Project_ProjectSinglePayloadItem'),
  root(
    'salary-transaction-create',
    'fortnox_create_salarytransaction',
    'fortnox_Lon_SalaryTransactionsSinglePayloadItem',
  ),
  root(
    'salary-transaction-update',
    'fortnox_update_salarytransaction',
    'fortnox_Lon_SalaryTransactionsSinglePayloadItem',
  ),
  root(
    'schedule-time-update',
    'fortnox_update_scheduletime',
    'fortnox_Lon_ScheduleTimeSinglePayloadItem',
  ),
  root(
    'schedule-time-reset',
    'fortnox_reset_scheduletime_day',
    'fortnox_Lon_ScheduleTimeSinglePayloadItem',
  ),
  root('supplier', 'fortnox_create_supplier', 'fortnox_Lf_SupplierSinglePayloadItem'),
  root('supplier-update', 'fortnox_update_supplier', 'fortnox_Lf_SupplierSinglePayloadItem'),
  root(
    'supplier-invoice-create',
    'fortnox_create_supplier_invoice',
    'fortnox_Lf_SupplierInvoiceSinglePayloadItem',
  ),
  root(
    'supplier-invoice-update',
    'fortnox_update_supplier_invoice',
    'fortnox_Lf_SupplierInvoiceSinglePayloadItem',
  ),
  root(
    'supplier-invoice-accrual-create',
    'fortnox_create_supplier_invoice_accrual',
    'fortnox_Lf_SupplierInvoiceAccrualSinglePayloadItem',
  ),
  root(
    'supplier-invoice-accrual-update',
    'fortnox_update_supplier_invoice_accrual',
    'fortnox_Lf_SupplierInvoiceAccrualSinglePayloadItem',
  ),
  root(
    'supplier-invoice-payment-create',
    'fortnox_create_supplier_invoice_payment',
    'fortnox_Lf_SupplierInvoicePaymentSinglePayloadItem',
  ),
  root(
    'supplier-invoice-payment-update',
    'fortnox_update_supplier_invoice_payment',
    'fortnox_Lf_SupplierInvoicePaymentSinglePayloadItem',
  ),
  root(
    'supplier-invoice-file-connection-create',
    'fortnox_create_supplier_invoice_file_connection',
    'fortnox_Da_SupplierInvoiceFileConnectionSinglePayloadItem',
  ),
  root('tax-reduction-create', 'fortnox_create_taxreduction', 'fortnox_TaxReductionCreatePayload'),
  root('tax-reduction-update', 'fortnox_update_taxreduction', 'fortnox_TaxReductionUpdatePayload'),
  root('voucher-create', 'fortnox_create_voucher', 'fortnox_Bf_VoucherSinglePayloadItem'),
  root(
    'document-attachment-create',
    'fortnox_create_document_attachment',
    'fileattachments_Attachment',
  ),
  root(
    'document-attachment-update',
    'fortnox_update_document_attachment',
    'fileattachments_Attachment',
  ),
  root(
    'recurring-invoice-request-create',
    'fortnox_create_recurring_invoice_request',
    'Recurring-API_CreateInvoiceRequest',
  ),
  {
    id: 'document-attachment-validate-item',
    toolName: 'fortnox_validate_attachments_on_send',
    toolSchemaPointer: '/properties/attachments/items',
    specSchemaName: 'fileattachments_Attachment',
  },
  {
    id: 'recurring-patch-document',
    toolName: 'fortnox_patch_recurring',
    toolSchemaPointer: '/properties/operations',
    specSchemaName: 'Recurring-API_JsonPatchDocument',
  },
  // Preserve the original high-risk nested mapping IDs and their history.
  {
    id: 'invoice-row',
    toolName: 'fortnox_create_invoice',
    toolSchemaPointer: '/properties/InvoiceRows/items',
    specSchemaName: 'fortnox_Kf_InvoiceRowSinglePayloadItem',
  },
  {
    id: 'offer-row',
    toolName: 'fortnox_create_offer',
    toolSchemaPointer: '/properties/OfferRows/items',
    specSchemaName: 'fortnox_Offer_OfferRowSinglePayloadItem',
  },
  {
    id: 'order-row',
    toolName: 'fortnox_create_order',
    toolSchemaPointer: '/properties/OrderRows/items',
    specSchemaName: 'fortnox_Order_OrderRowSinglePayloadItem',
  },
  {
    id: 'supplier-invoice-row',
    toolName: 'fortnox_create_supplier_invoice',
    toolSchemaPointer: '/properties/SupplierInvoiceRows/items',
    specSchemaName: 'fortnox_Lf_SupplierInvoiceRowSinglePayloadItem',
  },
  {
    id: 'voucher-row',
    toolName: 'fortnox_create_voucher',
    toolSchemaPointer: '/properties/VoucherRows/items',
    specSchemaName: 'fortnox_Bf_VoucherRowSinglePayloadItem',
  },
];

const action = (id: string, toolName: string, rationale: string): MutationAuditException => ({
  id,
  toolName,
  kind: 'no-structured-body',
  rationale,
});

const fileAction = (id: string, toolName: string, rationale: string): MutationAuditException => ({
  id,
  toolName,
  kind: 'binary-or-local-file',
  rationale,
});

/** Reviewed non-schema exceptions. Every passthrough names its preservation test. */
export const SCHEMA_AUDIT_EXCEPTIONS: readonly MutationAuditException[] = [
  action(
    'supplier-invoice-approval-bookkeep',
    'fortnox_approval_bookkeep_supplier_invoice',
    'Identifier-only workflow transition; no JSON request object is accepted.',
  ),
  action(
    'supplier-invoice-approval-payment',
    'fortnox_approval_payment_supplier_invoice',
    'Identifier-only workflow transition; no JSON request object is accepted.',
  ),
  fileAction(
    'invoice-file-orchestration',
    'fortnox_attach_invoice_files',
    'Local file upload plus attachment orchestration is covered by binary-safety and payload-preservation tests.',
  ),
  fileAction(
    'voucher-file-orchestration',
    'fortnox_attach_voucher_files',
    'Local file upload plus voucher connection orchestration is covered by binary-safety and payload-preservation tests.',
  ),
  action('invoice-bookkeep', 'fortnox_bookkeep_invoice', 'Identifier-only workflow transition.'),
  action(
    'invoice-payment-bookkeep',
    'fortnox_bookkeep_invoice_payment',
    'Identifier-only workflow transition.',
  ),
  action(
    'supplier-invoice-bookkeep',
    'fortnox_bookkeep_supplier_invoice',
    'Identifier-only workflow transition.',
  ),
  action(
    'supplier-payment-bookkeep',
    'fortnox_bookkeep_supplier_invoice_payment',
    'Identifier-only workflow transition.',
  ),
  action('invoice-cancel', 'fortnox_cancel_invoice', 'Identifier-only workflow transition.'),
  action('offer-cancel', 'fortnox_cancel_offer', 'Identifier-only workflow transition.'),
  action('order-cancel', 'fortnox_cancel_order', 'Identifier-only workflow transition.'),
  action(
    'supplier-invoice-cancel',
    'fortnox_cancel_supplier_invoice',
    'Identifier-only workflow transition.',
  ),
  action(
    'invoice-from-contract',
    'fortnox_create_invoice_from_contract',
    'Identifier-only conversion action.',
  ),
  action(
    'invoice-from-offer',
    'fortnox_create_invoice_from_offer',
    'Identifier-only conversion action.',
  ),
  action(
    'invoice-from-order',
    'fortnox_create_invoice_from_order',
    'Identifier-only conversion action.',
  ),
  action(
    'order-from-offer',
    'fortnox_create_order_from_offer',
    'Identifier-only conversion action.',
  ),
  {
    id: 'recurring-create-passthrough',
    toolName: 'fortnox_create_recurring',
    kind: 'passthrough',
    rationale:
      'The modern recurring provider contract is intentionally passed through unchanged and guarded by ETag workflow tests.',
    preservationTest: 'tests/tools/recurrings.test.ts:create preserves provider payload',
  },
  {
    id: 'recurring-replace-passthrough',
    toolName: 'fortnox_replace_recurring',
    kind: 'passthrough',
    rationale:
      'The modern recurring provider contract is intentionally passed through unchanged and guarded by ETag workflow tests.',
    preservationTest: 'tests/tools/recurrings.test.ts:replace preserves provider payload',
  },
  action('invoice-credit', 'fortnox_credit_invoice', 'Identifier-only workflow transition.'),
  action(
    'supplier-invoice-credit',
    'fortnox_credit_supplier_invoice',
    'Identifier-only workflow transition.',
  ),
  action('absence-delete', 'fortnox_delete_absencetransaction', 'Identifier-only delete.'),
  action('account-delete', 'fortnox_delete_account', 'Identifier-only delete.'),
  action('archive-entry-delete', 'fortnox_delete_archive_entry', 'Identifier/path-only delete.'),
  action('archive-path-delete', 'fortnox_delete_archive_path', 'Path-only delete.'),
  action('article-delete', 'fortnox_delete_article', 'Identifier-only delete.'),
  action('attendance-delete', 'fortnox_delete_attendancetransaction', 'Identifier-only delete.'),
  action('contract-accrual-delete', 'fortnox_delete_contract_accrual', 'Identifier-only delete.'),
  action('cost-center-delete', 'fortnox_delete_costcenter', 'Identifier-only delete.'),
  action('customer-delete', 'fortnox_delete_customer', 'Identifier-only delete.'),
  action('inbox-entry-delete', 'fortnox_delete_inbox_entry', 'Identifier-only delete.'),
  action('invoice-accrual-delete', 'fortnox_delete_invoice_accrual', 'Identifier-only delete.'),
  action('invoice-payment-delete', 'fortnox_delete_invoice_payment', 'Identifier-only delete.'),
  action('price-delete', 'fortnox_delete_price', 'Composite-identifier-only delete.'),
  action('project-delete', 'fortnox_delete_project', 'Identifier-only delete.'),
  action(
    'salary-transaction-delete',
    'fortnox_delete_salarytransaction',
    'Identifier-only delete.',
  ),
  action(
    'supplier-invoice-accrual-delete',
    'fortnox_delete_supplier_invoice_accrual',
    'Identifier-only delete.',
  ),
  action(
    'supplier-invoice-file-delete',
    'fortnox_delete_supplier_invoice_file_connection',
    'Identifier-only delete.',
  ),
  action(
    'supplier-invoice-payment-delete',
    'fortnox_delete_supplier_invoice_payment',
    'Identifier-only delete.',
  ),
  action('tax-reduction-delete', 'fortnox_delete_taxreduction', 'Identifier-only delete.'),
  action(
    'voucher-file-delete',
    'fortnox_delete_voucher_file_connection',
    'Identifier-only delete.',
  ),
  action(
    'document-attachment-delete',
    'fortnox_detach_document_attachment',
    'Identifier-only delete.',
  ),
  action('offer-email', 'fortnox_email_offer', 'Identifier-only delivery action.'),
  action('order-email', 'fortnox_email_order', 'Identifier-only delivery action.'),
  action('invoice-eprint', 'fortnox_eprint_invoice', 'Identifier-only delivery action.'),
  action(
    'invoice-external-print',
    'fortnox_external_print_invoice',
    'Identifier-only delivery action.',
  ),
  action(
    'offer-external-print',
    'fortnox_external_print_offer',
    'Identifier-only delivery action.',
  ),
  action(
    'order-external-print',
    'fortnox_external_print_order',
    'Identifier-only delivery action.',
  ),
  action('contract-finish', 'fortnox_finish_contract', 'Identifier-only workflow transition.'),
  action(
    'contract-increase-count',
    'fortnox_increase_contract_invoice_count',
    'Identifier-only workflow transition.',
  ),
  action(
    'invoice-send',
    'fortnox_send_invoice',
    'Delivery options are query parameters rather than a Fortnox JSON request contract.',
  ),
  fileAction(
    'invoice-pdf',
    'fortnox_invoice_pdf',
    'Binary preview/print workflow; mutation controls and file bytes are covered by PDF safety tests.',
  ),
  fileAction(
    'invoice-reminder-pdf',
    'fortnox_invoice_reminder_pdf',
    'Binary reminder-print workflow; mutation controls and file bytes are covered by PDF safety tests.',
  ),
  fileAction(
    'offer-pdf',
    'fortnox_offer_pdf',
    'Binary preview/print workflow; mutation controls and file bytes are covered by PDF safety tests.',
  ),
  fileAction(
    'order-pdf',
    'fortnox_order_pdf',
    'Binary preview/print workflow; mutation controls and file bytes are covered by PDF safety tests.',
  ),
  fileAction(
    'archive-upload',
    'fortnox_upload_archive_file',
    'Multipart binary upload; verified by file operation and safety tests.',
  ),
  fileAction(
    'inbox-upload',
    'fortnox_upload_inbox_file',
    'Multipart binary upload; verified by file operation and safety tests.',
  ),
];
