import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { absenceTransactionListColumns, absenceTransactionDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerAbsenceTransactionTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listAbsenceTransactions,
    getAbsenceTransaction,
    createAbsenceTransaction,
    deleteAbsenceTransaction,
  } = operations;
  server.tool(
    'fortnox_list_absencetransactions',
    'Lista frånvarotransaktioner i Fortnox (kräver Lön-behörigheten). Returnerar: id, EmployeeId, CauseCode, Date, Hours.',
    {
      employeeId: z.string().optional().describe('Filtrera på EmployeeId'),
      date: z.string().optional().describe('Filtrera på datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, page, limit, all, includeRaw }) => {
      const data = await listAbsenceTransactions({ employeeId, date, page, limit, all });
      return listResponse(
        data.AbsenceTransactions ?? [],
        absenceTransactionListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_absencetransaction',
    'Hämta en enskild frånvarotransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      id: z.string().describe('id (UUID) för frånvarotransaktionen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ id, includeRaw }) => {
      const data = await getAbsenceTransaction(id);
      return detailResponse(data, absenceTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_absencetransaction',
    'Skapa en ny frånvarotransaktion i Fortnox (kräver Lön-behörigheten). EmployeeId, CauseCode och Date krävs.',
    {
      EmployeeId: z.string().describe('EmployeeId för den anställde'),
      CauseCode: z
        .string()
        .describe(
          'Frånvarokod. Giltiga koder: ASK, FPE, FRA, HAV, KOM, MIL, NAR, OS1, OS2, OS3, OS4, OS5, PAP, PEM, PER, SEM, SJK, SMB, SVE, TJL, UTB, VAB',
        ),
      Date: z.string().describe('Datum (YYYY-MM-DD)'),
      Hours: z.number().optional().describe('Antal timmar (tal, t.ex. 8)'),
      Extent: z.number().optional().describe('Omfattning i procent (tal, t.ex. 50)'),
      HolidayEntitling: z.boolean().optional().describe('Semestergrundande'),
      CostCenter: z.string().optional().describe('Kostnadsställe'),
      Project: z.string().optional().describe('Projekt'),
      confirm: z.boolean().optional().describe('Bekräfta att frånvarotransaktionen ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create absence transaction for employee ${params.EmployeeId}`, {
          AbsenceTransaction: params,
        });
      }
      if (!confirm)
        requireConfirmation(`create absence transaction for employee ${params.EmployeeId}`);

      const data = await createAbsenceTransaction(params);
      return detailResponse(data, absenceTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_absencetransaction',
    'Ta bort en frånvarotransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      id: z.string().describe('id (UUID) för frånvarotransaktionen att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att frånvarotransaktionen ska tas bort'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle göras utan att ta bort frånvarotransaktionen'),
    },
    async ({ id, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete absence transaction ${id}`);
      }
      if (!confirm) requireConfirmation(`delete absence transaction ${id}`);

      await deleteAbsenceTransaction(id);
      return textResponse(`Absence transaction ${id} deleted.`);
    },
  );
}
