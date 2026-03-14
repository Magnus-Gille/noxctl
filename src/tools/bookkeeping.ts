import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAccounts } from '../operations/accounts.js';
import { listVouchers, getVoucher, createVoucher } from '../operations/vouchers.js';
import {
  accountListColumns,
  voucherDetailColumns,
  voucherListColumns,
  voucherRowColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const VoucherRowSchema = z.object({
  Account: z.number().describe('Kontonummer'),
  Debit: z.number().optional().describe('Debetbelopp'),
  Credit: z.number().optional().describe('Kreditbelopp'),
  Description: z.string().optional().describe('Beskrivning'),
});

const VoucherSeriesSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,9}$/, 'Voucher series must be alphanumeric')
  .optional();

export function registerBookkeepingTools(server: McpServer): void {
  server.tool(
    'fortnox_list_vouchers',
    'Lista verifikationer i Fortnox. Returnerar: VoucherSeries, VoucherNumber, TransactionDate, Description.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      series: z.string().optional().describe('Verifikationsserie (t.ex. "A")'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, series, fromDate, toDate, page, limit, all, includeRaw }) => {
      const data = await listVouchers({
        financialYear,
        series,
        fromDate,
        toDate,
        page,
        limit,
        all,
      });
      return listResponse(
        data.Vouchers ?? [],
        voucherListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_voucher',
    'Hämta en enskild verifikation med rader från Fortnox. Returnerar: VoucherSeries, VoucherNumber, TransactionDate, Description, samt VoucherRows med Account, Debit, Credit.',
    {
      series: z.string().describe('Verifikationsserie (t.ex. "A")'),
      voucherNumber: z.string().describe('Verifikationsnummer'),
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ series, voucherNumber, financialYear, includeRaw }) => {
      const data = await getVoucher(series, voucherNumber, financialYear);
      const rows = (data.VoucherRows as Record<string, unknown>[]) ?? [];
      const header = detailResponse(data, voucherDetailColumns, data, false);
      const rowTable = listResponse(rows, voucherRowColumns, data, undefined, includeRaw);
      const headerText = (header.content as { type: string; text: string }[])[0].text;
      const rowText = (rowTable.content as { type: string; text: string }[])[0].text;
      return { content: [{ type: 'text' as const, text: `${headerText}\n\nRows:\n${rowText}` }] };
    },
  );

  server.tool(
    'fortnox_create_voucher',
    'Skapa en verifikation i Fortnox',
    {
      Description: z.string().describe('Beskrivning av verifikationen'),
      VoucherSeries: VoucherSeriesSchema.describe('Verifikationsserie (default: "A")'),
      TransactionDate: z.string().describe('Transaktionsdatum (YYYY-MM-DD)'),
      VoucherRows: z.array(VoucherRowSchema).describe('Verifikationsrader (debet och kredit)'),
      confirm: z.boolean().optional().describe('Bekräfta att verifikationen ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa verifikationen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create voucher "${params.Description}"`, { Voucher: params });
      }
      if (!confirm) requireConfirmation(`create voucher "${params.Description}"`);

      const data = await createVoucher(params);
      return detailResponse(data, voucherDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_list_accounts',
    'Visa kontoplan i Fortnox. Returnerar: Number, Description, SRU.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      search: z.string().optional().describe('Sök på kontonamn'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listAccounts(params);
      return listResponse(
        data.Accounts ?? [],
        accountListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );
}
