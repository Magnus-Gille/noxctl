import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerBookkeepingTools } from './tools/bookkeeping.js';
import { registerTaxTools } from './tools/tax.js';
import { registerCompanyTools } from './tools/company.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'fortnox-mcp',
    version: '0.1.0',
  });

  registerCustomerTools(server);
  registerInvoiceTools(server);
  registerBookkeepingTools(server);
  registerTaxTools(server);
  registerCompanyTools(server);

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
