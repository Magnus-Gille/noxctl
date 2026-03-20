import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerBookkeepingTools } from './tools/bookkeeping.js';
import { registerTaxTools } from './tools/tax.js';
import { registerCompanyTools } from './tools/company.js';
import { registerArticleTools } from './tools/articles.js';
import { registerSupplierTools } from './tools/suppliers.js';
import { registerSupplierInvoiceTools } from './tools/supplier-invoices.js';
import { registerFinancialReportTools } from './tools/financial-reports.js';
import { registerStatusTools } from './tools/status.js';
import { registerInvoicePaymentTools } from './tools/invoice-payments.js';
import { registerSupplierInvoicePaymentTools } from './tools/supplier-invoice-payments.js';
import { registerOfferTools } from './tools/offers.js';
import { registerOrderTools } from './tools/orders.js';
import { registerProjectTools } from './tools/projects.js';
import { registerCostCenterTools } from './tools/costcenters.js';
import { registerTaxReductionTools } from './tools/taxreductions.js';
import { registerPriceListTools } from './tools/pricelists.js';

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
  registerArticleTools(server);
  registerSupplierTools(server);
  registerSupplierInvoiceTools(server);
  registerFinancialReportTools(server);
  registerStatusTools(server);
  registerInvoicePaymentTools(server);
  registerSupplierInvoicePaymentTools(server);
  registerOfferTools(server);
  registerOrderTools(server);
  registerProjectTools(server);
  registerCostCenterTools(server);
  registerTaxReductionTools(server);
  registerPriceListTools(server);

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run directly (backward compat: `node dist/index.js`)
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/index.js');

if (isDirectRun) {
  startMcpServer().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
