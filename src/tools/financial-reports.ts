import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIncomeStatement, getBalanceSheet } from '../operations/financial-reports.js';
import { formatFinancialReport } from '../formatter.js';
import { textResponse } from '../tool-output.js';

export function registerFinancialReportTools(server: McpServer): void {
  server.tool(
    'fortnox_income_statement',
    'Resultaträkning — visar intäkter, kostnader och resultat. Kan filtreras på period med fromDate/toDate.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      fromDate: z
        .string()
        .optional()
        .describe('Från datum (YYYY-MM-DD) — visar bara periodens rörelser'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, fromDate, toDate, includeRaw }) => {
      const report = await getIncomeStatement({ financialYear, fromDate, toDate });
      const text = formatFinancialReport(report);
      if (includeRaw) {
        return textResponse(`${text}\n\nRaw JSON:\n${JSON.stringify(report, null, 2)}`);
      }
      return textResponse(text);
    },
  );

  server.tool(
    'fortnox_balance_sheet',
    'Balansräkning — visar tillgångar, skulder och eget kapital. Kan filtreras med toDate för ställning per datum.',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      toDate: z.string().optional().describe('Per datum (YYYY-MM-DD) — ställning vid detta datum'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, toDate, includeRaw }) => {
      const report = await getBalanceSheet({ financialYear, toDate });
      const text = formatFinancialReport(report);
      if (includeRaw) {
        return textResponse(`${text}\n\nRaw JSON:\n${JSON.stringify(report, null, 2)}`);
      }
      return textResponse(text);
    },
  );
}
