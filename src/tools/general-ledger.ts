import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { generalLedgerColumns } from '../views.js';
import { listResponse } from '../tool-output.js';

export function registerGeneralLedgerTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { getGeneralLedger } = operations;

  server.tool(
    'fortnox_general_ledger',
    'Hämta bokförda transaktioner (huvudbok) för en period — en rad per kontorad, med datum, konto, text, debet och kredit. Bygger på Fortnox SIE-export och hämtar hela perioden i ett anrop, till skillnad från fortnox_list_vouchers som inte inkluderar belopp. Användbart för avstämning, periodjämförelser och att slå upp enskilda bokföringar/fakturor över tid.',
    {
      fromDate: z.string().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().describe('Till datum (YYYY-MM-DD)'),
      financialYear: z
        .number()
        .optional()
        .describe(
          'Räkenskapsår-ID (från fortnox_list_financialyears), härleds annars av Fortnox från datumintervallet',
        ),
      account: z.string().optional().describe('Filtrera på ett specifikt kontonummer'),
      series: z
        .string()
        .optional()
        .describe('Filtrera på en specifik verifikationsserie (t.ex. "A")'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ fromDate, toDate, financialYear, account, series, includeRaw }) => {
      let rows = await getGeneralLedger({ fromDate, toDate, financialYear });
      if (account) rows = rows.filter((r) => r.account === account);
      if (series) rows = rows.filter((r) => r.series === series);
      return listResponse(
        rows as unknown as Record<string, unknown>[],
        generalLedgerColumns,
        rows,
        undefined,
        includeRaw,
      );
    },
  );
}
