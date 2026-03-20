import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listCostCenters,
  getCostCenter,
  createCostCenter,
  updateCostCenter,
  deleteCostCenter,
} from '../operations/costcenters.js';
import { costCenterListColumns, costCenterDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerCostCenterTools(server: McpServer): void {
  server.tool(
    'fortnox_list_costcenters',
    'Lista kostnadsställen i Fortnox. Returnerar: Code, Description, Active.',
    {
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ page, limit, all, includeRaw }) => {
      const data = await listCostCenters({ page, limit, all });
      return listResponse(
        data.CostCenters ?? [],
        costCenterListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_costcenter',
    'Hämta ett enskilt kostnadsställe från Fortnox. Returnerar: Code, Description, Active, Note.',
    {
      code: z.string().describe('Kod för kostnadsstället'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ code, includeRaw }) => {
      const data = await getCostCenter(code);
      return detailResponse(data, costCenterDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_costcenter',
    'Skapa ett nytt kostnadsställe i Fortnox',
    {
      Code: z.string().describe('Kod för kostnadsstället'),
      Description: z.string().describe('Beskrivning'),
      Active: z.boolean().optional().describe('Om kostnadsstället är aktivt'),
      Note: z.string().optional().describe('Anteckning'),
      confirm: z.boolean().optional().describe('Bekräfta att kostnadsstället ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa kostnadsstället'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create cost center "${params.Code}"`, { CostCenter: params });
      }
      if (!confirm) requireConfirmation(`create cost center "${params.Code}"`);

      const data = await createCostCenter(params);
      return detailResponse(data, costCenterDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_costcenter',
    'Uppdatera ett befintligt kostnadsställe i Fortnox',
    {
      code: z.string().describe('Kod för kostnadsstället att uppdatera'),
      Description: z.string().optional().describe('Beskrivning'),
      Active: z.boolean().optional().describe('Om kostnadsstället är aktivt'),
      Note: z.string().optional().describe('Anteckning'),
      confirm: z.boolean().optional().describe('Bekräfta att kostnadsstället ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera kostnadsstället'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ code, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update cost center ${code}`, { CostCenter: fields });
      }
      if (!confirm) requireConfirmation(`update cost center ${code}`);

      const data = await updateCostCenter(code, fields);
      return detailResponse(data, costCenterDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_costcenter',
    'Ta bort ett kostnadsställe från Fortnox',
    {
      code: z.string().describe('Kod för kostnadsstället att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att kostnadsstället ska tas bort'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle göras utan att ta bort kostnadsstället'),
    },
    async ({ code, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete cost center ${code}`);
      }
      if (!confirm) requireConfirmation(`delete cost center ${code}`);

      await deleteCostCenter(code);
      return textResponse(`Cost center ${code} deleted.`);
    },
  );
}
