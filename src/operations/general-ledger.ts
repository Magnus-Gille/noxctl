import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { fetchSie } from '../sie.js';

export interface GeneralLedgerEntry {
  series: string;
  voucherNumber: string;
  transactionDate: string;
  registrationDate?: string;
  account: string;
  accountDescription?: string;
  costCenter?: string;
  project?: string;
  text: string;
  debit: number;
  credit: number;
}

export interface GeneralLedgerParams {
  fromDate: string;
  toDate: string;
  financialYear?: number;
}

// SIE dates are YYYYMMDD with no separators.
function formatSieDate(date: string): string {
  if (!/^\d{8}$/.test(date)) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

export function createGeneralLedgerOperations(transport: FortnoxTransport) {
  // The flat, dated, per-account transaction list every other report in this
  // file is built from — one #TRANS line in, one row out. Requires a date
  // range: fetchSie proxies straight to Fortnox's SIE export, which needs
  // one to scope the file it generates.
  async function getGeneralLedger(params: GeneralLedgerParams): Promise<GeneralLedgerEntry[]> {
    const parsed = await fetchSie(transport, params);
    return parsed.transactions
      .map((t): GeneralLedgerEntry => ({
        series: t.series,
        voucherNumber: t.voucherNumber,
        transactionDate: formatSieDate(t.voucherDate),
        registrationDate: t.registrationDate ? formatSieDate(t.registrationDate) : undefined,
        account: t.account,
        accountDescription: parsed.accounts.get(t.account)?.description,
        costCenter: t.costCenter,
        project: t.project,
        text: t.text ?? t.voucherDescription,
        debit: t.amount > 0 ? t.amount : 0,
        credit: t.amount < 0 ? -t.amount : 0,
      }))
      .sort(
        (a, b) =>
          a.transactionDate.localeCompare(b.transactionDate) ||
          a.series.localeCompare(b.series) ||
          Number(a.voucherNumber) - Number(b.voucherNumber),
      );
  }

  return { getGeneralLedger };
}

export const { getGeneralLedger } = createGeneralLedgerOperations(defaultFortnoxTransport);
