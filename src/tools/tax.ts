import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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

export function registerTaxTools(server: McpServer): void {
  server.tool(
    'fortnox_tax_report',
    'Momsunderlag för period — stöd för skattedeklaration. Hämtar utgående och ingående moms från bokföringen.',
    {
      fromDate: z.string().describe('Från datum (YYYY-MM-DD), t.ex. första dagen i kvartalet'),
      toDate: z.string().describe('Till datum (YYYY-MM-DD), t.ex. sista dagen i kvartalet'),
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
    },
    async ({ fromDate, toDate, financialYear }) => {
      // Fetch account balances for the period
      // VAT accounts in BAS-kontoplanen:
      // 2610: Utgående moms 25%
      // 2620: Utgående moms 12%
      // 2630: Utgående moms 6%
      // 2640: Ingående moms
      // 2650: Moms redovisningskonto
      const data = await fortnoxRequest<AccountsResponse>('accounts', {
        params: {
          financialyear: financialYear,
        },
      });

      const vatAccountNumbers = [2610, 2620, 2630, 2640, 2641, 2645, 2650];
      const vatAccounts = data.Accounts.filter((a) => vatAccountNumbers.includes(a.Number));

      // Also get vouchers in the period to sum up transactions
      const voucherData = await fortnoxRequest<VouchersResponse>('vouchers', {
        params: {
          fromdate: fromDate,
          todate: toDate,
          financialyear: financialYear,
        },
      });

      // Sum up VAT-related transactions
      const vatSummary: Record<number, { debit: number; credit: number; description: string }> = {};
      for (const voucher of voucherData.Vouchers || []) {
        for (const row of voucher.VoucherRows || []) {
          if (vatAccountNumbers.includes(row.Account)) {
            if (!vatSummary[row.Account]) {
              vatSummary[row.Account] = { debit: 0, credit: 0, description: '' };
            }
            vatSummary[row.Account].debit += row.Debit || 0;
            vatSummary[row.Account].credit += row.Credit || 0;
          }
        }
      }

      // Add descriptions from account plan
      for (const account of vatAccounts) {
        if (vatSummary[account.Number]) {
          vatSummary[account.Number].description = account.Description;
        }
      }

      const report = {
        period: { from: fromDate, to: toDate },
        vatAccounts: vatSummary,
        accountBalances: vatAccounts.map((a) => ({
          account: a.Number,
          description: a.Description,
          balance: a.BalanceCarriedForward,
        })),
        summary: {
          note: 'Kontrollera beloppen mot Fortnox momsrapport innan deklaration.',
        },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
