import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { scheduleTimeDetailColumns } from '../views.js';
import { detailResponse, dryRunResponse, requireConfirmation } from '../tool-output.js';

// Writable ScheduleTime fields exposed to the MCP tool. EmployeeId and Date are
// the composite path key and are never sent in the body.
const scheduleTimeWritableFields = {
  Hours: z.string().optional().describe('Antal timmar'),
  ScheduleId: z.string().optional().describe('Schema-ID'),
  IWH1: z.string().optional().describe('OB-tid 1 (obekväm arbetstid)'),
  IWH2: z.string().optional().describe('OB-tid 2 (obekväm arbetstid)'),
  IWH3: z.string().optional().describe('OB-tid 3 (obekväm arbetstid)'),
  IWH4: z.string().optional().describe('OB-tid 4 (obekväm arbetstid)'),
  IWH5: z.string().optional().describe('OB-tid 5 (obekväm arbetstid)'),
};

export function registerScheduleTimeTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { getScheduleTime, updateScheduleTime, resetScheduleTimeDay } = operations;
  server.tool(
    'fortnox_get_scheduletime',
    'Hämta en schematid för en anställd och ett datum från Fortnox (kräver Lön-behörigheten).',
    {
      employeeId: z.string().describe('EmployeeId för den anställde'),
      date: z.string().describe('Datum (YYYY-MM-DD)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, includeRaw }) => {
      const data = await getScheduleTime(employeeId, date);
      return detailResponse(data, scheduleTimeDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_scheduletime',
    'Uppdatera en schematid för en anställd och ett datum i Fortnox (kräver Lön-behörigheten).',
    {
      employeeId: z.string().describe('EmployeeId för den anställde'),
      date: z.string().describe('Datum (YYYY-MM-DD)'),
      ...scheduleTimeWritableFields,
      confirm: z.boolean().optional().describe('Bekräfta att schematiden ska uppdateras'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att uppdatera'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update schedule time ${employeeId} ${date}`, {
          ScheduleTime: fields,
        });
      }
      if (!confirm) requireConfirmation(`update schedule time ${employeeId} ${date}`);

      const data = await updateScheduleTime(employeeId, date, fields);
      return detailResponse(data, scheduleTimeDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_reset_scheduletime_day',
    'Uppdatera schematid och återställ dagen för en anställd och ett datum i Fortnox (kräver Lön-behörigheten).',
    {
      employeeId: z.string().describe('EmployeeId för den anställde'),
      date: z.string().describe('Datum (YYYY-MM-DD)'),
      ...scheduleTimeWritableFields,
      confirm: z.boolean().optional().describe('Bekräfta att dagen ska återställas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att återställa'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ employeeId, date, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`reset schedule time day ${employeeId} ${date}`, {
          ScheduleTime: fields,
        });
      }
      if (!confirm) requireConfirmation(`reset schedule time day ${employeeId} ${date}`);

      const data = await resetScheduleTimeDay(employeeId, date, fields);
      return detailResponse(data, scheduleTimeDetailColumns, data, includeRaw);
    },
  );
}
