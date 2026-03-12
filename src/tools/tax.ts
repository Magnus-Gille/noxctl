import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateTaxReport } from '../operations/tax.js';

export function registerTaxTools(server: McpServer): void {
  server.tool(
    'fortnox_tax_report',
    'Momsunderlag för period — stöd för skattedeklaration. Hämtar utgående och ingående moms från bokföringen.',
    {
      fromDate: z.string().describe('Från datum (YYYY-MM-DD), t.ex. första dagen i kvartalet'),
      toDate: z.string().describe('Till datum (YYYY-MM-DD), t.ex. sista dagen i kvartalet'),
      financialYear: z.number().optional().describe('Räkenskapsår (default: nuvarande)'),
    },
    async (params) => {
      const report = await generateTaxReport(params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
