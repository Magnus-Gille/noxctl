import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setResolvedProfile } from './auth.js';
import { DEFAULT_PROFILE, InvalidProfileNameError } from './profile-name.js';
import { readActivePointerOutcome, resolveProfile } from './profiles.js';
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

// Thrown by resolveStartupProfile when the profile cannot be resolved
// unambiguously (corrupt/unreadable pointer with no env override, or an
// invalid env var). startMcpServer translates this into a stderr-logged
// non-zero exit so tests can observe it without terminating the test runner.
export class StartupProfileError extends Error {
  constructor(
    public readonly code:
      | 'invalid-pointer-content'
      | 'pointer-read-error'
      | 'pointer-timeout'
      | 'invalid-env',
    message: string,
  ) {
    super(message);
    this.name = 'StartupProfileError';
  }
}

// Resolves the startup profile from env + active pointer. Mirrors the CLI
// preAction precedence minus the flag (no Commander context at direct-run
// entry). Pointer faults fail closed when no env override is present —
// silently binding to `default` could route requests to the wrong tenant.
export async function resolveStartupProfile(): Promise<string> {
  const env = process.env['NOXCTL_PROFILE'] ?? undefined;
  const outcome = await readActivePointerOutcome({ timeoutMs: 2000 });

  if (outcome.kind !== 'valid' && outcome.kind !== 'missing') {
    const desc =
      outcome.kind === 'invalid-content'
        ? `contains an invalid profile name: "${outcome.raw}"`
        : outcome.kind === 'read-error'
          ? `could not be read (${outcome.error.message})`
          : 'read timed out';
    if (!env) {
      throw new StartupProfileError(
        outcome.kind === 'invalid-content'
          ? 'invalid-pointer-content'
          : outcome.kind === 'read-error'
            ? 'pointer-read-error'
            : 'pointer-timeout',
        `Active profile pointer ${desc}. Refusing to start MCP server with ambiguous profile. Run \`noxctl doctor\` or set NOXCTL_PROFILE explicitly.`,
      );
    }
    process.stderr.write(
      `[warning: active-profile pointer ${desc}; using NOXCTL_PROFILE instead]\n`,
    );
  }

  const pointer = outcome.kind === 'valid' ? outcome.name : null;
  try {
    return resolveProfile({ env, pointer }).name;
  } catch (err) {
    if (err instanceof InvalidProfileNameError) {
      throw new StartupProfileError('invalid-env', err.message);
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
  try {
    await bindStartupProfile(options);
  } catch (err) {
    if (err instanceof StartupProfileError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
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
