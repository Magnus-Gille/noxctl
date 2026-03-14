import { fortnoxRequest } from '../fortnox-client.js';

interface VouchersResponse {
  Vouchers: {
    VoucherRows?: {
      Account: number;
      Debit: number;
      Credit: number;
      Description?: string;
    }[];
    [key: string]: unknown;
  }[];
}

interface AccountsResponse {
  Accounts: {
    Number: number;
    Description: string;
    SRU: number;
    BalanceBroughtForward: number;
    BalanceCarriedForward: number;
    [key: string]: unknown;
  }[];
}

const VAT_ACCOUNT_NUMBERS = [2610, 2620, 2630, 2640, 2641, 2645, 2650];

export interface GenerateTaxReportParams {
  fromDate: string;
  toDate: string;
  financialYear?: number;
}

export interface TaxReport {
  period: { from: string; to: string };
  vatAccounts: Record<number, { debit: number; credit: number; description: string }>;
  accountBalances: { account: number; description: string; balance: number }[];
  summary: { note: string };
}

export async function generateTaxReport(params: GenerateTaxReportParams): Promise<TaxReport> {
  const data = await fortnoxRequest<AccountsResponse>('accounts', {
    params: {
      financialyear: params.financialYear,
    },
  });

  const vatAccounts = data.Accounts.filter((a) => VAT_ACCOUNT_NUMBERS.includes(a.Number));

  const voucherData = await fortnoxRequest<VouchersResponse>('vouchers', {
    params: {
      fromdate: params.fromDate,
      todate: params.toDate,
      financialyear: params.financialYear,
    },
  });

  const vatSummary: Record<number, { debit: number; credit: number; description: string }> = {};
  for (const voucher of voucherData.Vouchers || []) {
    for (const row of voucher.VoucherRows || []) {
      if (VAT_ACCOUNT_NUMBERS.includes(row.Account)) {
        if (!vatSummary[row.Account]) {
          vatSummary[row.Account] = { debit: 0, credit: 0, description: '' };
        }
        vatSummary[row.Account].debit += row.Debit || 0;
        vatSummary[row.Account].credit += row.Credit || 0;
      }
    }
  }

  for (const account of vatAccounts) {
    if (vatSummary[account.Number]) {
      vatSummary[account.Number].description = account.Description;
    }
  }

  return {
    period: { from: params.fromDate, to: params.toDate },
    vatAccounts: vatSummary,
    accountBalances: vatAccounts.map((a) => ({
      account: a.Number,
      description: a.Description,
      balance: a.BalanceCarriedForward,
    })),
    summary: {
      note:
        'Informativ sammanstallning. Kontrollera beloppen mot Fortnox momsrapport och bokforingen innan deklaration.',
    },
  };
}
