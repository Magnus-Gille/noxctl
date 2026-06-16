import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listFinancialYears,
  getFinancialYear,
  getLockedPeriod,
} from '../operations/financial-years.js';
import {
  financialYearListColumns,
  financialYearDetailColumns,
  lockedPeriodDetailColumns,
} from '../views.js';
import { detailResponse, listResponse, textResponse } from '../tool-output.js';

export function registerFinancialYearTools(server: McpServer): void {
  server.tool(
    'fortnox_list_financialyears',
    'Lista räkenskapsår i Fortnox. Returnerar: Id, FromDate, ToDate, AccountingMethod, AccountChartType. Kan filtreras till det räkenskapsår som innehåller ett visst datum.',
    {
      date: z
        .string()
        .optional()
        .describe('Hitta räkenskapsåret som innehåller detta datum (YYYY-MM-DD)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ date, includeRaw }) => {
      const data = await listFinancialYears({ date });
      return listResponse(
        data.FinancialYears ?? [],
        financialYearListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_financialyear',
    'Hämta ett enskilt räkenskapsår från Fortnox.',
    {
      id: z.number().describe('Räkenskapsårets Id'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ id, includeRaw }) => {
      const data = await getFinancialYear(id);
      return detailResponse(data, financialYearDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_get_lockedperiod',
    'Hämta låst period från Fortnox (bokföringen är låst t.o.m. detta datum). Tomt svar betyder att ingen period är låst. Användbart innan verifikat/fakturor bokförs för att undvika fel om låst period.',
    {
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw }) => {
      const data = await getLockedPeriod();
      if (!data.EndDate) {
        return textResponse('Ingen period är låst.');
      }
      return detailResponse(data, lockedPeriodDetailColumns, data, includeRaw);
    },
  );
}
