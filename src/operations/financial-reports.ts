import { fortnoxRequest } from '../fortnox-client.js';

interface AccountEntry {
  Number: number;
  Description: string;
  BalanceBroughtForward: number;
  [key: string]: unknown;
}

interface AccountsResponse {
  Accounts: AccountEntry[];
  MetaInformation?: { '@TotalPages': number; '@CurrentPage': number };
}

interface VoucherRow {
  Account: number;
  Debit: number;
  Credit: number;
}

interface VouchersResponse {
  Vouchers: { VoucherRows?: VoucherRow[]; [key: string]: unknown }[];
  MetaInformation?: { '@TotalPages': number; '@CurrentPage': number };
}

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

/** Fetch all pages of accounts for a financial year. */
async function fetchAllAccounts(financialYear?: number): Promise<AccountEntry[]> {
  const all: AccountEntry[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await fortnoxRequest<AccountsResponse>('accounts', {
      params: { financialyear: financialYear, page },
    });
    all.push(...data.Accounts);
    totalPages = data.MetaInformation?.['@TotalPages'] ?? 1;
    page++;
  } while (page <= totalPages);

  return all;
}

interface VoucherDetailResponse {
  Voucher: { VoucherRows?: VoucherRow[]; [key: string]: unknown };
}

/** Fetch all vouchers (list + individual details) and sum debit/credit per account. */
async function fetchVoucherSums(
  financialYear?: number,
  fromDate?: string,
  toDate?: string,
): Promise<Map<number, { debit: number; credit: number }>> {
  const sums = new Map<number, { debit: number; credit: number }>();

  // Step 1: List all vouchers to get series/number identifiers
  const vouchers: { series: string; number: number }[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await fortnoxRequest<VouchersResponse>('vouchers', {
      params: {
        financialyear: financialYear,
        fromdate: fromDate,
        todate: toDate,
        page,
        limit: 100,
      },
    });
    for (const v of data.Vouchers ?? []) {
      vouchers.push({
        series: v.VoucherSeries as string,
        number: v.VoucherNumber as number,
      });
    }
    totalPages = data.MetaInformation?.['@TotalPages'] ?? 1;
    page++;
  } while (page <= totalPages);

  // Step 2: Fetch each voucher individually to get VoucherRows
  const yearParam = financialYear ? `?financialyear=${financialYear}` : '';
  for (const v of vouchers) {
    const detail = await fortnoxRequest<VoucherDetailResponse>(
      `vouchers/${encodeURIComponent(v.series)}/${v.number}${yearParam}`,
    );
    for (const row of detail.Voucher.VoucherRows ?? []) {
      const existing = sums.get(row.Account) ?? { debit: 0, credit: 0 };
      existing.debit += row.Debit || 0;
      existing.credit += row.Credit || 0;
      sums.set(row.Account, existing);
    }
  }

  return sums;
}

interface AccountBalance {
  number: number;
  description: string;
  closingBalance: number;
}

/** Compute closing balances: BalanceBroughtForward + debit - credit for each account. */
async function computeBalances(
  financialYear?: number,
  fromDate?: string,
  toDate?: string,
): Promise<AccountBalance[]> {
  const [accounts, voucherSums] = await Promise.all([
    fetchAllAccounts(financialYear),
    fetchVoucherSums(financialYear, fromDate, toDate),
  ]);

  return accounts
    .map((a) => {
      const movement = voucherSums.get(a.Number);
      const debit = movement?.debit ?? 0;
      const credit = movement?.credit ?? 0;
      // For period-scoped income statements (fromDate set), skip BBF
      // since we only want the period's movements for P&L accounts.
      // For balance sheets, always include BBF.
      const bbf = fromDate ? 0 : a.BalanceBroughtForward;
      const closingBalance = bbf + debit - credit;
      return {
        number: a.Number,
        description: a.Description,
        closingBalance,
      };
    })
    .filter((a) => a.closingBalance !== 0);
}

/** Compute balance sheet balances: always includes BBF + movements up to toDate. */
async function computeBalanceSheetBalances(
  financialYear?: number,
  toDate?: string,
): Promise<AccountBalance[]> {
  const [accounts, voucherSums] = await Promise.all([
    fetchAllAccounts(financialYear),
    fetchVoucherSums(financialYear, undefined, toDate),
  ]);

  return accounts
    .map((a) => {
      const movement = voucherSums.get(a.Number);
      const debit = movement?.debit ?? 0;
      const credit = movement?.credit ?? 0;
      const closingBalance = a.BalanceBroughtForward + debit - credit;
      return {
        number: a.Number,
        description: a.Description,
        closingBalance,
      };
    })
    .filter((a) => a.closingBalance !== 0);
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
    total: lines.reduce((sum, l) => sum + l.balance, 0),
  };
}

export async function getIncomeStatement(
  params: FinancialReportParams = {},
): Promise<IncomeStatement> {
  const balances = await computeBalances(params.financialYear, params.fromDate, params.toDate);

  const sections: ReportSection[] = [];
  for (const group of INCOME_STATEMENT_GROUPS) {
    const section = buildSection(balances, group.range, group.label);
    if (section) sections.push(section);
  }

  const netResult = sections.reduce((sum, s) => sum + s.total, 0);

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

export async function getBalanceSheet(params: FinancialReportParams = {}): Promise<BalanceSheet> {
  const balances = await computeBalanceSheetBalances(params.financialYear, params.toDate);

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
    totalAssets: assets.reduce((sum, s) => sum + s.total, 0),
    liabilitiesAndEquity,
    totalLiabilitiesAndEquity: liabilitiesAndEquity.reduce((sum, s) => sum + s.total, 0),
  };
}
