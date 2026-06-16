import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listAttendanceTransactions,
  getAttendanceTransaction,
  createAttendanceTransaction,
  deleteAttendanceTransaction,
} from '../operations/attendancetransactions.js';
import { attendanceTransactionListColumns, attendanceTransactionDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerAttendanceTransactionTools(server: McpServer): void {
  server.tool(
    'fortnox_list_attendancetransactions',
    'Lista närvarotransaktioner i Fortnox (kräver Lön-behörigheten). Returnerar: id, EmployeeId, CauseCode, Date, Hours.',
    {
      employeeId: z.string().optional().describe('Filtrera på EmployeeId'),
      date: z.string().optional().describe('Filtrera på datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, page, limit, all, includeRaw }) => {
      const data = await listAttendanceTransactions({ employeeId, date, page, limit, all });
      return listResponse(
        data.AttendanceTransactions ?? [],
        attendanceTransactionListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_attendancetransaction',
    'Hämta en enskild närvarotransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      id: z.string().describe('id (UUID) för närvarotransaktionen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ id, includeRaw }) => {
      const data = await getAttendanceTransaction(id);
      return detailResponse(data, attendanceTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_attendancetransaction',
    'Skapa en ny närvarotransaktion i Fortnox (kräver Lön-behörigheten). EmployeeId, CauseCode och Date krävs.',
    {
      EmployeeId: z.string().describe('EmployeeId för den anställde'),
      CauseCode: z
        .string()
        .describe(
          'Orsakskod. Giltiga koder: ARB, BE2, BER, FLX, HLG, JO2, JOR, MER, OB1, OB2, OB3, OB4, OB5, OK0, OK1, OK2, OK3, OK4, OK5, OT1, OT2, OT3, OT4, OT5, RES, TID',
        ),
      Date: z.string().describe('Datum (YYYY-MM-DD)'),
      Hours: z.string().optional().describe('Antal timmar'),
      CostCenter: z.string().optional().describe('Kostnadsställe'),
      Project: z.string().optional().describe('Projekt'),
      confirm: z.boolean().optional().describe('Bekräfta att närvarotransaktionen ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(
          `create attendance transaction for employee ${params.EmployeeId} (${params.CauseCode} ${params.Date})`,
          { AttendanceTransaction: params },
        );
      }
      if (!confirm) {
        requireConfirmation(
          `create attendance transaction for employee ${params.EmployeeId} (${params.CauseCode} ${params.Date})`,
        );
      }

      const data = await createAttendanceTransaction(params);
      return detailResponse(data, attendanceTransactionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_attendancetransaction',
    'Ta bort en närvarotransaktion från Fortnox (kräver Lön-behörigheten).',
    {
      id: z.string().describe('id (UUID) för närvarotransaktionen att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att närvarotransaktionen ska tas bort'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle göras utan att ta bort närvarotransaktionen'),
    },
    async ({ id, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete attendance transaction ${id}`);
      }
      if (!confirm) requireConfirmation(`delete attendance transaction ${id}`);

      await deleteAttendanceTransaction(id);
      return textResponse(`Attendance transaction ${id} deleted.`);
    },
  );
}
