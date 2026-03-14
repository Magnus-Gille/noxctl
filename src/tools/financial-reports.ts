import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getIncomeStatement, getBalanceSheet } from '../operations/financial-reports.js';
import { formatFinancialReport } from '../formatter.js';
import { textResponse } from '../tool-output.js';

export function registerFinancialReportTools(server: McpServer): void {
  server.tool(
    'fortnox_income_statement',
    'Resultaträkning — visar intäkter, kostnader och resultat för räkenskapsåret',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, includeRaw }) => {
      const report = await getIncomeStatement({ financialYear });
      const text = formatFinancialReport(report);
      if (includeRaw) {
        return textResponse(`${text}\n\nRaw JSON:\n${JSON.stringify(report, null, 2)}`);
      }
      return textResponse(text);
    },
  );

  server.tool(
    'fortnox_balance_sheet',
    'Balansräkning — visar tillgångar, skulder och eget kapital för räkenskapsåret',
    {
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ financialYear, includeRaw }) => {
      const report = await getBalanceSheet({ financialYear });
      const text = formatFinancialReport(report);
      if (includeRaw) {
        return textResponse(`${text}\n\nRaw JSON:\n${JSON.stringify(report, null, 2)}`);
      }
      return textResponse(text);
    },
  );
}
