/**
 * One cheap read endpoint per OAuth scope, used by `noxctl doctor` and
 * `fortnox_status` to check what the current credentials are actually
 * authorized for.
 *
 * Shared by both callers so the two cannot drift. A scope with no probe here
 * used to be skipped silently while still counting toward "all N scopes
 * authorized"; both callers now report it as "not checked" instead, and the
 * scope-probes test asserts this map matches the requestable scope sets exactly.
 */
export const scopeProbeEndpoints: Record<string, string> = {
  article: 'articles?limit=1',
  customer: 'customers?limit=1',
  invoice: 'invoices?limit=1',
  payment: 'invoicepayments?limit=1',
  offer: 'offers?limit=1',
  order: 'orders?limit=1',
  supplier: 'suppliers?limit=1',
  supplierinvoice: 'supplierinvoices?limit=1',
  bookkeeping: 'vouchers?limit=1',
  companyinformation: 'companyinformation',
  settings: 'settings/company',
  project: 'projects?limit=1',
  costcenter: 'costcenters?limit=1',
  price: 'pricelists?limit=1',
  inbox: 'inbox',
  connectfile: 'voucherfileconnections?limit=1',
  salary: 'employees?limit=1',
  archive: 'archive',
};
