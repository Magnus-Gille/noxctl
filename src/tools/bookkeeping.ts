import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fortnoxRequest } from '../fortnox-client.js';

interface VoucherResponse {
  Voucher: Record<string, unknown>;
}

interface VouchersResponse {
  Vouchers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

interface AccountsResponse {
  Accounts: Record<string, unknown>[];
}

const VoucherRowSchema = z.object({
  Account: z.number().describe('Kontonummer'),
  Debit: z.number().optional().describe('Debetbelopp'),
  Credit: z.number().optional().describe('Kreditbelopp'),
  Description: z.string().optional().describe('Beskrivning'),
});

export function registerBookkeepingTools(server: McpServer): void {
  server.tool(
    'fortnox_list_vouchers',
    'Lista verifikationer i Fortnox',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      series: z.string().optional().describe('Verifikationsserie (t.ex. "A")'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
    },
    async ({ financialYear, series, fromDate, toDate, page, limit }) => {
      const subpath = series ? `sublist/${series}` : '';
      const data = await fortnoxRequest<VouchersResponse>(`vouchers/${subpath}`, {
        params: {
          financialyear: financialYear,
          fromdate: fromDate,
          todate: toDate,
          page: page || 1,
          limit: limit || 100,
        },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'fortnox_create_voucher',
    'Skapa en verifikation i Fortnox',
    {
      Description: z.string().describe('Beskrivning av verifikationen'),
      VoucherSeries: z.string().optional().describe('Verifikationsserie (default: "A")'),
      TransactionDate: z.string().describe('Transaktionsdatum (YYYY-MM-DD)'),
      VoucherRows: z.array(VoucherRowSchema).describe('Verifikationsrader (debet och kredit)'),
    },
    async (params) => {
      const data = await fortnoxRequest<VoucherResponse>('vouchers', {
        method: 'POST',
        body: {
          Voucher: {
            ...params,
            VoucherSeries: params.VoucherSeries || 'A',
          },
        },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data.Voucher, null, 2) }],
      };
    },
  );

  server.tool(
    'fortnox_list_accounts',
    'Visa kontoplan i Fortnox',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      search: z.string().optional().describe('Sök på kontonamn'),
    },
    async ({ financialYear, search }) => {
      const data = await fortnoxRequest<AccountsResponse>('accounts', {
        params: {
          financialyear: financialYear,
          ...(search ? { lastmodified: undefined } : {}),
        },
      });

      let accounts = data.Accounts;
      if (search) {
        const term = search.toLowerCase();
        accounts = accounts.filter(
          (a) =>
            String(a.Number || '').includes(term) ||
            String(a.Description || '')
              .toLowerCase()
              .includes(term),
        );
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(accounts, null, 2) }],
      };
    },
  );
}
