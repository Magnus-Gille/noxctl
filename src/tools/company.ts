import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCompanyInfo } from '../operations/company.js';
import { companyDetailColumns } from '../views.js';
import { detailResponse } from '../tool-output.js';

export function registerCompanyTools(server: McpServer): void {
  server.tool(
    'fortnox_company_info',
    'Hämta företagsinformation och inställningar från Fortnox',
    {
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw }) => {
      const data = await getCompanyInfo();
      return detailResponse(data, companyDetailColumns, data, includeRaw);
    },
  );
}
