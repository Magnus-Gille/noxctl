import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCompanyInfo } from '../operations/company.js';

export function registerCompanyTools(server: McpServer): void {
  server.tool(
    'fortnox_company_info',
    'Hämta företagsinformation och inställningar från Fortnox',
    {},
    async () => {
      const data = await getCompanyInfo();

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
