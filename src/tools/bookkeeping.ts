import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAccounts } from '../operations/accounts.js';
import { listVouchers, createVoucher } from '../operations/vouchers.js';

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
      const data = await listVouchers({ financialYear, series, fromDate, toDate, page, limit });

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
      const data = await createVoucher(params);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
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
    async (params) => {
      const accounts = await listAccounts(params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(accounts, null, 2) }],
      };
    },
  );
}
