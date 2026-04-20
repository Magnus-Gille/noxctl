import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setResolvedProfile } from './auth.js';
import { DEFAULT_PROFILE, InvalidProfileNameError } from './profile-name.js';
import { readActivePointer, resolveProfile } from './profiles.js';
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

export interface StartMcpServerOptions {
  /**
   * When provided, binds the MCP session to this profile directly (skipping
   * env/pointer resolution). The CLI `serve` action passes the profile it
   * already resolved via its preAction hook so a `--profile` flag isn't lost.
   */
  profile?: string;
}

// Resolves the startup profile from env + active pointer when no explicit
// profile is supplied. Mirrors the CLI preAction precedence minus the flag
// (there's no Commander context at direct-run entry). An invalid name is
// logged and falls back to the default rather than crashing the server.
export async function resolveStartupProfile(): Promise<string> {
  const env = process.env['NOXCTL_PROFILE'] ?? undefined;
  let pointer: string | null = null;
  try {
    pointer = await readActivePointer();
  } catch {
    pointer = null;
  }
  try {
    return resolveProfile({ env, pointer }).name;
  } catch (err) {
    if (err instanceof InvalidProfileNameError) {
      process.stderr.write(`${err.message}\n`);
      return DEFAULT_PROFILE;
    }
    throw err;
  }
}

// Extracted from startMcpServer so tests can exercise profile binding without
// spinning up the stdio transport (which blocks on stdin).
export async function bindStartupProfile(options: StartMcpServerOptions = {}): Promise<string> {
  const profile = options.profile ?? (await resolveStartupProfile());
  setResolvedProfile(profile);
  if (profile.toLowerCase() !== DEFAULT_PROFILE) {
    process.stderr.write(`[profile: ${profile}]\n`);
  }
  return profile;
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  await bindStartupProfile(options);
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
