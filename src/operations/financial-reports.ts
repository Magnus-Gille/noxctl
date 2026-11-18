import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { fetchSie, type ParsedSie } from '../sie.js';
import { createFinancialYearOperations } from './financial-years.js';

export interface FinancialReportParams {
  financialYear?: number;
  fromDate?: string;
  toDate?: string;
}

export interface ReportLine {
  account: number;
  description: string;
  balance: number;
}

export interface ReportSection {
  label: string;
  lines: ReportLine[];
  total: number;
}

export interface IncomeStatement {
  type: 'income-statement';
  financialYear?: number;
  period?: { from: string; to: string };
  sections: ReportSection[];
  netResult: number;
}

export interface BalanceSheet {
  type: 'balance-sheet';
  financialYear?: number;
  asOfDate?: string;
  assets: ReportSection[];
  totalAssets: number;
  liabilitiesAndEquity: ReportSection[];
  totalLiabilitiesAndEquity: number;
}

// BAS account plan groupings
const INCOME_STATEMENT_GROUPS: { range: [number, number]; label: string }[] = [
  { range: [3000, 3999], label: 'Nettoomsättning (Revenue)' },
  { range: [4000, 4999], label: 'Varuinköp/direkta kostnader (COGS)' },
  { range: [5000, 6999], label: 'Övriga externa kostnader (Other external costs)' },
  { range: [7000, 7699], label: 'Personalkostnader (Personnel costs)' },
  { range: [7700, 7899], label: 'Nedskrivningar/avskrivningar (Depreciation)' },
  { range: [7900, 7999], label: 'Övriga rörelsekostnader (Other operating costs)' },
  { range: [8000, 8399], label: 'Finansiella intäkter (Financial income)' },
  { range: [8400, 8799], label: 'Finansiella kostnader (Financial costs)' },
  { range: [8800, 8899], label: 'Bokslutsdispositioner (Year-end appropriations)' },
  { range: [8900, 8999], label: 'Skatt (Tax)' },
];

const BALANCE_SHEET_ASSET_GROUPS: { range: [number, number]; label: string }[] = [
  { range: [1000, 1399], label: 'Immateriella anläggningstillgångar (Intangible assets)' },
  { range: [1400, 1499], label: 'Materiella anläggningstillgångar (Tangible assets)' },
  { range: [1500, 1599], label: 'Finansiella anläggningstillgångar (Financial assets)' },
  { range: [1600, 1699], label: 'Kundfordringar (Accounts receivable)' },
  { range: [1700, 1799], label: 'Övriga fordringar (Other receivables)' },
  { range: [1800, 1899], label: 'Kortfristiga placeringar (Short-term investments)' },
  { range: [1900, 1999], label: 'Kassa och bank (Cash and bank)' },
];

const BALANCE_SHEET_LIABILITY_GROUPS: { range: [number, number]; label: string }[] = [
  { range: [2000, 2099], label: 'Eget kapital (Equity)' },
  { range: [2100, 2199], label: 'Obeskattade reserver (Untaxed reserves)' },
  { range: [2200, 2299], label: 'Avsättningar (Provisions)' },
  { range: [2300, 2399], label: 'Långfristiga skulder (Long-term liabilities)' },
  { range: [2400, 2499], label: 'Leverantörsskulder (Accounts payable)' },
  { range: [2500, 2599], label: 'Skatteskulder (Tax liabilities)' },
  { range: [2600, 2699], label: 'Momsskulder (VAT liabilities)' },
  { range: [2700, 2799], label: 'Personalens skatter/avgifter (Payroll liabilities)' },
  { range: [2800, 2899], label: 'Övriga kortfristiga skulder (Other current liabilities)' },
  { range: [2900, 2999], label: 'Upplupna kostnader (Accrued expenses)' },
];

interface ResolvedFinancialYear {
  id: number;
  fromDate: string;
  toDate: string;
}

interface AccountBalance {
  number: number;
  description: string;
  closingBalance: number;
}

function localIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// SIE dates are YYYYMMDD with no separators.
function sieDateToIso(date: string): string {
  if (!/^\d{8}$/.test(date)) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

// Sum in öre so many two-decimal amounts never drift (0.1 + 0.2 style).
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function sumAmounts(amounts: number[]): number {
  return amounts.reduce((sum, a) => sum + toCents(a), 0) / 100;
}

/*
 * Both reports are built from ONE SIE 4 export (#KONTO names, #IB opening
 * balances, #VER/#TRANS movements) — the same source `general-ledger` uses.
 * The earlier implementation listed every voucher and then fetched each one's
 * rows individually; under Fortnox's 25 requests / 5 s limit a normal year
 * (hundreds of vouchers) took minutes with no output, which looked like a hang
 * (NOX-224).
 */
export function createFinancialReportOperations(transport: FortnoxTransport) {
  const { listFinancialYears } = createFinancialYearOperations(transport);

  // Financial-year ids are per company, and the SIE export needs one: Fortnox
  // rejects a date range it cannot place in a year ("Perioden måste ligga inom
  // bokföringsåret"). Resolve the year, with its boundaries, explicitly.
  async function resolveFinancialYear(
    financialYear: number | undefined,
    date: string,
  ): Promise<ResolvedFinancialYear> {
    if (
      financialYear !== undefined &&
      (!Number.isSafeInteger(financialYear) || financialYear <= 0)
    ) {
      throw new Error('financialYear must be a positive safe integer.');
    }
    const years = ((await listFinancialYears()).FinancialYears ?? []) as Record<string, unknown>[];
    const match =
      financialYear !== undefined
        ? years.find((fy) => Number(fy.Id) === financialYear)
        : years.find((fy) => String(fy.FromDate) <= date && date <= String(fy.ToDate));
    if (!match) {
      throw new Error(
        financialYear !== undefined
          ? `Financial year ${financialYear} not found in Fortnox.`
          : `No financial year found covering ${date}. Pass financialYear explicitly.`,
      );
    }
    const id = Number(match.Id);
    const fromDate = String(match.FromDate ?? '');
    const toDate = String(match.ToDate ?? '');
    if (!Number.isSafeInteger(id) || id <= 0 || !fromDate || !toDate) {
      throw new Error('Invalid financial year returned by Fortnox. Pass financialYear explicitly.');
    }
    return { id, fromDate, toDate };
  }

  async function fetchYearSie(
    params: FinancialReportParams,
    mode: 'period' | 'balance',
  ): Promise<{ sie: ParsedSie; fromDate: string; toDate: string; financialYear: number }> {
    const anchor =
      (mode === 'period' ? params.fromDate : undefined) ??
      params.toDate ??
      localIsoDate(new Date());
    const year = await resolveFinancialYear(params.financialYear, anchor);

    // Clamp to the financial year; a balance sheet always starts at the year's
    // opening balance (#IB) so its range always starts on the first day.
    const fromDate =
      mode === 'period' && params.fromDate && params.fromDate > year.fromDate
        ? params.fromDate
        : year.fromDate;
    const toDate = params.toDate && params.toDate < year.toDate ? params.toDate : year.toDate;
    if (fromDate > toDate) {
      throw new Error(
        `Period ${fromDate}–${toDate} lies outside financial year ${year.id} (${year.fromDate}–${year.toDate}).`,
      );
    }

    const sie = await fetchSie(transport, { fromDate, toDate, financialYear: year.id });
    return { sie, fromDate, toDate, financialYear: year.id };
  }

  /** Per-account balances: optional opening balance + movements dated within [from, to]. */
  function accountBalances(
    sie: ParsedSie,
    fromDate: string,
    toDate: string,
    includeOpening: boolean,
  ): AccountBalance[] {
    const cents = new Map<string, number>();

    if (includeOpening) {
      for (const ib of sie.openingBalances) {
        if (ib.yearIndex !== 0) continue;
        cents.set(ib.account, (cents.get(ib.account) ?? 0) + toCents(ib.balance));
      }
    }

    // The export is already scoped by date, but filter again so the report is
    // correct regardless of how Fortnox treats the range boundaries.
    for (const t of sie.transactions) {
      const date = sieDateToIso(t.voucherDate || t.transactionDate);
      if (date < fromDate || date > toDate) continue;
      cents.set(t.account, (cents.get(t.account) ?? 0) + toCents(t.amount));
    }

    const balances: AccountBalance[] = [];
    for (const [account, value] of cents) {
      const number = Number(account);
      if (!Number.isInteger(number) || value === 0) continue;
      balances.push({
        number,
        description: sie.accounts.get(account)?.description ?? '',
        closingBalance: value / 100,
      });
    }
    return balances.sort((a, b) => a.number - b.number);
  }

  function buildSection(
    balances: AccountBalance[],
    range: [number, number],
    label: string,
  ): ReportSection | null {
    const lines = balances
      .filter((a) => a.number >= range[0] && a.number <= range[1])
      .map((a) => ({
        account: a.number,
        description: a.description,
        balance: a.closingBalance,
      }));

    if (lines.length === 0) return null;

    return {
      label,
      lines,
      total: sumAmounts(lines.map((l) => l.balance)),
    };
  }

  async function getIncomeStatement(params: FinancialReportParams = {}): Promise<IncomeStatement> {
    const { sie, fromDate, toDate } = await fetchYearSie(params, 'period');
    // P&L accounts carry no opening balance; only the period's movements count.
    const balances = accountBalances(sie, fromDate, toDate, false);

    const sections: ReportSection[] = [];
    for (const group of INCOME_STATEMENT_GROUPS) {
      const section = buildSection(balances, group.range, group.label);
      if (section) sections.push(section);
    }

    const netResult = sumAmounts(sections.map((s) => s.total));

    return {
      type: 'income-statement',
      financialYear: params.financialYear,
      period:
        params.fromDate || params.toDate
          ? { from: params.fromDate ?? '', to: params.toDate ?? '' }
          : undefined,
      sections,
      netResult,
    };
  }

  async function getBalanceSheet(params: FinancialReportParams = {}): Promise<BalanceSheet> {
    const { sie, fromDate, toDate } = await fetchYearSie(params, 'balance');
    const balances = accountBalances(sie, fromDate, toDate, true);

    const assets: ReportSection[] = [];
    for (const group of BALANCE_SHEET_ASSET_GROUPS) {
      const section = buildSection(balances, group.range, group.label);
      if (section) assets.push(section);
    }

    const liabilitiesAndEquity: ReportSection[] = [];
    for (const group of BALANCE_SHEET_LIABILITY_GROUPS) {
      const section = buildSection(balances, group.range, group.label);
      if (section) liabilitiesAndEquity.push(section);
    }

    return {
      type: 'balance-sheet',
      financialYear: params.financialYear,
      asOfDate: params.toDate,
      assets,
      totalAssets: sumAmounts(assets.map((s) => s.total)),
      liabilitiesAndEquity,
      totalLiabilitiesAndEquity: sumAmounts(liabilitiesAndEquity.map((s) => s.total)),
    };
  }

  return { getIncomeStatement, getBalanceSheet };
}

export const { getIncomeStatement, getBalanceSheet } =
  createFinancialReportOperations(defaultFortnoxTransport);
