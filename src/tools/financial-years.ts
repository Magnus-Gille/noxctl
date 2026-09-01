import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  financialYearListColumns,
  financialYearDetailColumns,
  lockedPeriodDetailColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerFinancialYearTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { listFinancialYears, getFinancialYear, createFinancialYear, getLockedPeriod } = operations;
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
    'fortnox_create_financialyear',
    'Skapa ett räkenskapsår i Fortnox',
    {
      FromDate: z.string().describe('Startdatum (YYYY-MM-DD)'),
      ToDate: z.string().describe('Slutdatum (YYYY-MM-DD)'),
      AccountingMethod: z.enum(['ACCRUAL', 'CASH']).optional().describe('Bokföringsmetod'),
      AccountChartType: z.string().optional().describe('Kontoplanstyp'),
      confirm: z.boolean().optional().describe('Bekräfta att räkenskapsåret ska skapas'),
      dryRun: z.boolean().optional().describe('Visa payload utan att skapa'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) return dryRunResponse('create financial year', { FinancialYear: fields });
      if (!confirm) requireConfirmation('create financial year');
      const year = await createFinancialYear(fields);
      return detailResponse(year, financialYearDetailColumns, year, includeRaw);
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
