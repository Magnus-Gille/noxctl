import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { salaryTransactionListColumns, salaryTransactionDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerSalaryTransactionTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listSalaryTransactions,
    getSalaryTransaction,
    createSalaryTransaction,
    deleteSalaryTransaction,
  } = operations;
  server.tool(
    'fortnox_list_salarytransactions',
    'Lista lönetransaktioner i Fortnox (kräver Lön-behörigheten). Returnerar: SalaryRow, EmployeeId, SalaryCode, Date, Amount.',
    {
      employeeId: z.string().optional().describe('Filtrera på EmployeeId'),
      date: z.string().optional().describe('Filtrera på datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, page, limit, all, includeRaw }) => {
      const data = await listSalaryTransactions({ employeeId, date, page, limit, all });
      return listResponse(
        data.SalaryTransactions ?? [],
        salaryTransactionListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_salarytransaction',
    'Hämta en enskild lönetransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      salaryRow: z.string().describe('SalaryRow (radens ID)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ salaryRow, includeRaw }) => {
      const data = await getSalaryTransaction(salaryRow);
      return detailResponse(data, salaryTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_salarytransaction',
    'Skapa en ny lönetransaktion i Fortnox (kräver Lön-behörigheten). EmployeeId, SalaryCode och Date krävs.',
    {
      EmployeeId: z.string().describe('EmployeeId för den anställde'),
      SalaryCode: z.string().describe('Lönekod'),
      Date: z.string().describe('Datum (YYYY-MM-DD)'),
      Amount: z.string().optional().describe('Antal/belopp'),
      CostCenter: z.string().optional().describe('Kostnadsställe'),
      Project: z.string().optional().describe('Projekt'),
      Expense: z.string().optional().describe('Utlägg'),
      Number: z.string().optional().describe('Nummer'),
      TextRow: z.string().optional().describe('Textrad'),
      Total: z.string().optional().describe('Summa'),
      VAT: z.string().optional().describe('Moms'),
      confirm: z.boolean().optional().describe('Bekräfta att lönetransaktionen ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa lönetransaktionen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create salary transaction for employee ${params.EmployeeId}`, {
          SalaryTransaction: params,
        });
      }
      if (!confirm)
        requireConfirmation(`create salary transaction for employee ${params.EmployeeId}`);

      const data = await createSalaryTransaction(params);
      return detailResponse(data, salaryTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_salarytransaction',
    'Ta bort en lönetransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      salaryRow: z.string().describe('SalaryRow (radens ID) att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att lönetransaktionen ska tas bort'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle göras utan att ta bort lönetransaktionen'),
    },
    async ({ salaryRow, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete salary transaction ${salaryRow}`);
      }
      if (!confirm) requireConfirmation(`delete salary transaction ${salaryRow}`);

      await deleteSalaryTransaction(salaryRow);
      return textResponse(`Salary transaction ${salaryRow} deleted.`);
    },
  );
}
