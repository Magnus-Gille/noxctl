/**
 * One cheap read endpoint per OAuth scope, used by `noxctl doctor` and
 * `fortnox_status` to check what the current credentials are actually
 * authorized for.
 *
 * Shared by both callers so the two cannot drift: a scope with no probe here is
 * silently skipped by the validation loop, which previously let doctor report
 * "all N scopes authorized" while never checking five of them. `scope-probes`
 * test coverage asserts this map matches the requestable scope sets exactly.
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
};
