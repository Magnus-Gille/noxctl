// Precomputed analytics views over invoice data. The aggregation functions are
// pure (invoice rows in, summary out) so they can be unit-tested without the
// API; the exported get* functions fetch via listInvoices and delegate.
//
// Amounts are summed in the invoice currency as returned by Fortnox (no FX
// conversion) — for single-currency (SEK) tenants the totals are exact.

import { listInvoices } from './invoices.js';
import { generateTaxReport } from './tax.js';

type InvoiceRow = Record<string, unknown>;

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function isCancelled(inv: InvoiceRow): boolean {
  return inv.Cancelled === true;
}

function isOpen(inv: InvoiceRow): boolean {
  return !isCancelled(inv) && num(inv.Balance) > 0;
}

function isOverdue(inv: InvoiceRow, today: string): boolean {
  return isOpen(inv) && String(inv.DueDate ?? '') < today;
}

export interface OverdueSummary {
  count: number;
  totalBalance: number;
  oldestDueDate: string | null;
  invoices: InvoiceRow[];
}

export function summarizeOverdue(invoices: InvoiceRow[], today: string): OverdueSummary {
  const overdue = invoices
    .filter((inv) => isOverdue(inv, today))
    .sort((a, b) => String(a.DueDate ?? '').localeCompare(String(b.DueDate ?? '')));
  return {
    count: overdue.length,
    totalBalance: overdue.reduce((sum, inv) => sum + num(inv.Balance), 0),
    oldestDueDate: overdue.length > 0 ? String(overdue[0].DueDate) : null,
    invoices: overdue,
  };
}

export interface UnpaidSummary {
  count: number;
  totalBalance: number;
  overdueCount: number;
  overdueBalance: number;
}

export function summarizeUnpaid(invoices: InvoiceRow[], today: string): UnpaidSummary {
  const open = invoices.filter(isOpen);
  const overdue = open.filter((inv) => isOverdue(inv, today));
  return {
    count: open.length,
    totalBalance: open.reduce((sum, inv) => sum + num(inv.Balance), 0),
    overdueCount: overdue.length,
    overdueBalance: overdue.reduce((sum, inv) => sum + num(inv.Balance), 0),
  };
}

export interface CustomerRevenue {
  CustomerNumber: string;
  CustomerName: string;
  total: number;
  invoiceCount: number;
}

export function topCustomersFrom(invoices: InvoiceRow[], limit: number): CustomerRevenue[] {
  const byCustomer = new Map<string, CustomerRevenue>();
  for (const inv of invoices) {
    if (isCancelled(inv)) continue;
    const key = String(inv.CustomerNumber ?? '');
    const entry = byCustomer.get(key) ?? {
      CustomerNumber: key,
      CustomerName: String(inv.CustomerName ?? ''),
      total: 0,
      invoiceCount: 0,
    };
    entry.total += num(inv.Total);
    entry.invoiceCount += 1;
    byCustomer.set(key, entry);
  }
  return [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

export interface MonthlyRevenue {
  month: string; // YYYY-MM
  total: number;
  invoiceCount: number;
}

export function monthlyRevenueFrom(invoices: InvoiceRow[]): MonthlyRevenue[] {
  const byMonth = new Map<string, MonthlyRevenue>();
  for (const inv of invoices) {
    if (isCancelled(inv)) continue;
    const month = String(inv.InvoiceDate ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const entry = byMonth.get(month) ?? { month, total: 0, invoiceCount: 0 };
    entry.total += num(inv.Total);
    entry.invoiceCount += 1;
    byMonth.set(month, entry);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Format a Date as YYYY-MM-DD using LOCAL calendar fields. Using toISOString()
// here would format in UTC, so between local midnight and the UTC offset (e.g.
// 00:00–02:00 in Sweden, UTC+1/+2) "today" would resolve to yesterday — skewing
// overdue classification and the dashboard window by a day.
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayIso(): string {
  return localIsoDate(new Date());
}

// Start of the dashboard revenue window: the 1st of the month (months - 1)
// months before `today`, in local time. Built via the Date(year, monthIndex, 1)
// overload so a negative/overflowing month index rolls the year correctly, and
// pinning the day to 1 avoids end-of-month overflow — e.g. mutating a Jul-31
// Date with setMonth(1) would land on "Feb 31" → March, silently dropping a
// whole month from the window.
export function dashboardWindowStart(today: Date, months: number): string {
  return localIsoDate(new Date(today.getFullYear(), today.getMonth() - (months - 1), 1));
}

export async function getOverdueSummary(): Promise<OverdueSummary> {
  const data = await listInvoices({ filter: 'unpaidoverdue', all: true });
  return summarizeOverdue(data.Invoices ?? [], todayIso());
}

export async function getUnpaidTotals(): Promise<UnpaidSummary> {
  const data = await listInvoices({ filter: 'unpaid', all: true });
  return summarizeUnpaid(data.Invoices ?? [], todayIso());
}

export interface TopCustomersParams {
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export async function getTopCustomers(params: TopCustomersParams = {}): Promise<{
  period: { from?: string; to?: string };
  customers: CustomerRevenue[];
}> {
  const data = await listInvoices({ fromDate: params.fromDate, toDate: params.toDate, all: true });
  return {
    period: { from: params.fromDate, to: params.toDate },
    customers: topCustomersFrom(data.Invoices ?? [], params.limit ?? 10),
  };
}

export interface VatSummaryParams {
  fromDate: string;
  toDate: string;
  financialYear?: number;
}

// Net VAT position across the report's VAT accounts: sum of (debit - credit).
// Negative = net VAT owed to Skatteverket; positive = a refund is due.
export function netVatFromVatAccounts(
  vatAccounts: Record<number, { debit?: number; credit?: number }> | undefined,
): number {
  let netVat = 0;
  for (const acct of Object.values(vatAccounts ?? {})) {
    netVat += (acct.debit ?? 0) - (acct.credit ?? 0);
  }
  return netVat;
}

// Thin wrapper over the tax report adding the bottom line scripted callers
// usually want: net VAT position (negative = owed to Skatteverket).
export async function getVatSummary(params: VatSummaryParams) {
  const report = await generateTaxReport(params);
  return { ...report, netVat: netVatFromVatAccounts(report.vatAccounts) };
}

export interface Dashboard {
  unpaid: UnpaidSummary;
  overdue: OverdueSummary;
  recentInvoices: InvoiceRow[];
  monthlyRevenue: MonthlyRevenue[];
}

// At-a-glance summary composed from a single full invoice fetch (plus one
// filtered fetch would be redundant — overdue/unpaid are derived locally).
export async function getDashboard(options: { months?: number } = {}): Promise<Dashboard> {
  const months = options.months ?? 6;
  const now = new Date();
  const today = localIsoDate(now);
  const from = dashboardWindowStart(now, months);

  // Two fetches: the windowed one for revenue/recent, and the unpaid filter
  // (which is date-independent — an old unpaid invoice may predate the window).
  const [windowed, unpaidData] = await Promise.all([
    listInvoices({ fromDate: from, toDate: today, all: true }),
    listInvoices({ filter: 'unpaid', all: true }),
  ]);

  const windowedRows = windowed.Invoices ?? [];
  const unpaidRows = unpaidData.Invoices ?? [];

  const recentInvoices = [...windowedRows]
    .filter((inv) => !isCancelled(inv))
    .sort((a, b) => String(b.InvoiceDate ?? '').localeCompare(String(a.InvoiceDate ?? '')))
    .slice(0, 5);

  return {
    unpaid: summarizeUnpaid(unpaidRows, today),
    overdue: summarizeOverdue(unpaidRows, today),
    recentInvoices,
    monthlyRevenue: monthlyRevenueFrom(windowedRows),
  };
}
