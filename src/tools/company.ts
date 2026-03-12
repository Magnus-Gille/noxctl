import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fortnoxRequest } from '../fortnox-client.js';

interface CompanyInfoResponse {
  CompanyInformation: Record<string, unknown>;
}

export function registerCompanyTools(server: McpServer): void {
  server.tool(
    'fortnox_company_info',
    'Hämta företagsinformation och inställningar från Fortnox',
    {},
    async () => {
      const data = await fortnoxRequest<CompanyInfoResponse>('companyinformation');

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data.CompanyInformation, null, 2) },
        ],
      };
    },
  );
}
