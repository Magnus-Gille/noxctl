import type { SchemaAuditMapping } from './schema-audit.js';

/**
 * First-wave write-schema coverage mappings.
 *
 * Component names are already part of the committed opaque API fingerprint. The
 * OpenAPI document and its property names remain in the git-ignored local cache.
 */
export const SCHEMA_AUDIT_MAPPINGS: readonly SchemaAuditMapping[] = [
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
    id: 'supplier',
    toolName: 'fortnox_create_supplier',
    toolSchemaPointer: '',
    specSchemaName: 'fortnox_Lf_SupplierSinglePayloadItem',
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
