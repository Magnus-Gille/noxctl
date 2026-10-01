import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { invoiceListColumns, topCustomerColumns } from '../views.js';
import { formatTable, formatTaxReport } from '../formatter.js';
import { textResponse } from '../tool-output.js';
import { formatBalances } from '../operations/analytics.js';

export function registerAnalyticsTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { getOverdueSummary, getUnpaidTotals, getTopCustomers, getVatSummary } = operations;
  server.tool(
    'fortnox_overdue_invoices',
    'Sammanfattning av förfallna obetalda fakturor: antal, utestående belopp per valuta, äldsta förfallodatum och listan (äldst först). Användbart för snabb ekonomisk överblick.',
    {},
    async () => {
      const summary = await getOverdueSummary();
      if (summary.count === 0) {
        return textResponse('Inga förfallna fakturor.');
      }
      const lines = [
        `Förfallna fakturor: ${summary.count} st, ${formatBalances(summary.byCurrency, summary.totalBalance)} utestående.`,
        `Äldsta förfallodatum: ${summary.oldestDueDate}.`,
        '',
        formatTable(summary.invoices, invoiceListColumns),
      ];
      return textResponse(lines.join('\n'));
    },
  );

  server.tool(
    'fortnox_unpaid_totals',
    'Totalt utestående kundfordringar: antal obetalda fakturor och summa per valuta, med förfallen andel separat.',
    {},
    async () => {
      const s = await getUnpaidTotals();
      return textResponse(
        [
          `Obetalda fakturor: ${s.count} st, ${formatBalances(s.byCurrency, s.totalBalance)} utestående.`,
          `Varav förfallna: ${s.overdueCount} st, ${formatBalances(s.overdueByCurrency, s.overdueBalance)}.`,
        ].join('\n'),
      );
    },
  );

  server.tool(
    'fortnox_top_customers',
    'Största kunder efter fakturerat belopp under en period. Returnerar kund, totalbelopp och antal fakturor.',
    {
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      limit: z.number().optional().describe('Antal kunder (default 10)'),
    },
    async ({ fromDate, toDate, limit }) => {
      const result = await getTopCustomers({ fromDate, toDate, limit });
      if (result.customers.length === 0) {
        return textResponse('Inga fakturor i perioden.');
      }
      const period =
        result.period.from || result.period.to
          ? `Period: ${result.period.from ?? '…'} — ${result.period.to ?? '…'}\n\n`
          : '';
      return textResponse(
        period +
          formatTable(
            result.customers.map((c) => ({ ...c })),
            topCustomerColumns,
          ),
      );
    },
  );

  server.tool(
    'fortnox_vat_summary',
    'Momssammanfattning för en period: momskonton med debet/kredit samt netto momsposition (negativt = att betala till Skatteverket).',
    {
      fromDate: z.string().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().describe('Till datum (YYYY-MM-DD)'),
      financialYear: z.number().optional().describe('Räkenskapsår (Id)'),
    },
    async ({ fromDate, toDate, financialYear }) => {
      const summary = await getVatSummary({ fromDate, toDate, financialYear });
      const netVat = summary.netVat as number;
      return textResponse(
        formatTaxReport(summary) + `\n\nNetto moms: ${netVat.toFixed(2)} (negativt = att betala)`,
      );
    },
  );
}
