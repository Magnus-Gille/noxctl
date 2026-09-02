import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { generalLedgerColumns } from '../views.js';
import { listResponse } from '../tool-output.js';

// A 20,000-posting fixture (a real full year for a high-volume company —
// exactly the scenario this tool exists for) formats to ~1.78 MB of table
// text, which can exceed MCP/client/model limits and hands back more ledger
// data than a caller can realistically consume in one response. Cap it the
// same way every other list tool in this codebase already reports paging
// (`@TotalResources`/`@TotalPages`/`@CurrentPage`), so a caller who needs the
// rest can page through it explicitly instead of it arriving unbounded.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export function registerGeneralLedgerTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { getGeneralLedger } = operations;

  server.tool(
    'fortnox_general_ledger',
    'Hämta bokförda transaktioner (huvudbok) för en period — en rad per kontorad, med datum, konto, text, debet och kredit. Bygger på Fortnox SIE-export och hämtar hela perioden i ett anrop, till skillnad från fortnox_list_vouchers som inte inkluderar belopp. Användbart för avstämning, periodjämförelser och att slå upp enskilda bokföringar/fakturor över tid. Resultatet är sidindelat — se sidfoten för totalt antal rader.',
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
      page: z.number().int().min(1).optional().describe('Sidnummer (default 1)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Antal rader per sida (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    },
    async ({ fromDate, toDate, financialYear, account, series, page, limit }) => {
      let rows = await getGeneralLedger({ fromDate, toDate, financialYear });
      if (account) rows = rows.filter((r) => r.account === account);
      if (series) rows = rows.filter((r) => r.series === series);

      const totalResources = rows.length;
      const pageSize = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const currentPage = page ?? 1;
      const start = (currentPage - 1) * pageSize;
      const pageRows = rows.slice(start, start + pageSize);
      const totalPages = Math.max(1, Math.ceil(totalResources / pageSize));

      // No `includeRaw`: this data comes from a parsed SIE text export, not a
      // Fortnox JSON response, so there is no separate "raw" representation
      // to hand back — offering one would just relabel these same rows as
      // something they are not.
      return listResponse(
        pageRows as unknown as Record<string, unknown>[],
        generalLedgerColumns,
        undefined,
        {
          '@TotalResources': totalResources,
          '@TotalPages': totalPages,
          '@CurrentPage': currentPage,
        },
      );
    },
  );
}
