import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateTaxReport } from '../operations/tax.js';
import { taxReportResponse } from '../tool-output.js';

export function registerTaxTools(server: McpServer): void {
  server.tool(
    'fortnox_tax_report',
    'Informativ momssammanstallning for en period. Kontrollera alltid mot Fortnox momsrapport innan deklaration.',
    {
      fromDate: z.string().describe('Från datum (YYYY-MM-DD), t.ex. första dagen i kvartalet'),
      toDate: z.string().describe('Till datum (YYYY-MM-DD), t.ex. sista dagen i kvartalet'),
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
      includeRaw: z
        .boolean()
        .optional()
        .describe('Inkludera rå JSON från Fortnox (kan exponera mer bokförings- och persondata)'),
    },
    async ({ includeRaw, ...params }) => {
      const report = await generateTaxReport(params);
      return taxReportResponse(report as unknown as Record<string, unknown>, includeRaw);
    },
  );
}
