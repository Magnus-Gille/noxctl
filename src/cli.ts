#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  isJsonMode,
  outputList,
  outputDetail,
  outputConfirmation,
  formatTaxReport,
} from './formatter.js';
import {
  invoiceListColumns,
  invoiceDetailColumns,
  invoiceConfirmColumns,
  customerListColumns,
  customerDetailColumns,
  voucherListColumns,
  voucherDetailColumns,
  accountListColumns,
  companyDetailColumns,
} from './views.js';

const program = new Command();

program
  .name('noxctl')
  .description('CLI and MCP server for Fortnox accounting')
  .version('0.1.0')
  .addOption(
    new Option('-o, --output <format>', 'Output format')
      .choices(['json', 'table'])
      .default(undefined),
  );

function json(): boolean {
  return isJsonMode(program.opts());
}

async function confirmMutation(
  action: string,
  opts: { yes?: boolean; dryRun?: boolean },
  payload?: unknown,
): Promise<boolean> {
  if (opts.dryRun) {
    console.log(`Dry run: ${action}. No request was sent to Fortnox.`);
    if (payload !== undefined) {
      console.log('\nRequest payload:');
      console.log(JSON.stringify(payload, null, 2));
    }
    return false;
  }

  if (opts.yes) return true;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Confirmation required to ${action}. Re-run with --yes, or --dry-run first.`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${action}. Continue? [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

// --- init (interactive setup wizard) ---
program
  .command('init')
  .description('Interactive setup wizard — recommended onboarding path')
  .action(async () => {
    const { loadCredentials, runOAuthSetup } = await import('./auth.js');

    // Step 1: Check if already configured
    const existing = await loadCredentials();
    if (existing) {
      console.log('You are already set up. Run `noxctl company info` to verify your connection.');
      return;
    }

    // Step 2: Welcome message
    console.log('Welcome to noxctl setup!');
    console.log('');
    console.log("You'll need a Fortnox app from developer.fortnox.se with:");
    console.log('  - Redirect URI: http://localhost:9876/callback');
    console.log(
      '  - Scopes (Behörigheter): Bokföring, Faktura, Företagsinformation, Inställningar, Kund',
    );
    console.log('  - Service account enabled (recommended)');
    console.log('');
    console.log('See the README for detailed portal instructions.');
    console.log('');

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;

    let clientId: string;
    let clientSecret: string;
    let serviceAccount: boolean;

    if (!isTTY) {
      // CI / non-interactive mode: fall back to env vars
      clientId = process.env.FORTNOX_CLIENT_ID ?? '';
      clientSecret = process.env.FORTNOX_CLIENT_SECRET ?? '';
      serviceAccount = process.env.FORTNOX_SERVICE_ACCOUNT === '1';

      if (!clientId || !clientSecret) {
        console.error(
          'Error: stdin is not a TTY. Set FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET env vars to run non-interactively.',
        );
        process.exit(1);
      }
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Step 3: Prompt for Client ID
        const envClientId = process.env.FORTNOX_CLIENT_ID;
        const clientIdPrompt = envClientId ? `Client ID [${envClientId}]: ` : 'Client ID: ';
        const clientIdAnswer = (await rl.question(clientIdPrompt)).trim();
        clientId = clientIdAnswer || envClientId || '';

        if (!clientId) {
          console.error('Error: Client ID is required.');
          process.exit(1);
        }

        // Step 4: Prompt for Client Secret
        const envClientSecret = process.env.FORTNOX_CLIENT_SECRET;
        const clientSecretPrompt = envClientSecret
          ? 'Client Secret [env var set — press Enter to use it]: '
          : 'Client Secret: ';
        const clientSecretAnswer = (await rl.question(clientSecretPrompt)).trim();
        clientSecret = clientSecretAnswer || envClientSecret || '';

        if (!clientSecret) {
          console.error('Error: Client Secret is required.');
          process.exit(1);
        }

        // Step 5: Service account question — default yes
        const saAnswer = (
          await rl.question('Did you enable service account authorization? [Y/n] ')
        )
          .trim()
          .toLowerCase();
        serviceAccount = saAnswer === '' || saAnswer === 'y' || saAnswer === 'yes';
      } finally {
        rl.close();
      }
    }

    // Step 6: Run OAuth flow
    await runOAuthSetup({ clientId, clientSecret, serviceAccount });

    // Step 7: Verify by fetching company info
    try {
      const { getCompanyInfo } = await import('./operations/company.js');
      const data = await getCompanyInfo();
      const company = data as Record<string, unknown>;
      console.log('');
      console.log('Connected successfully!');
      if (company['CompanyName']) {
        console.log(`  Company: ${company['CompanyName']}`);
      }
      if (company['OrganizationNumber']) {
        console.log(`  Org number: ${company['OrganizationNumber']}`);
      }
    } catch {
      console.log('');
      console.log(
        'OAuth completed. Could not verify company info — you can run `noxctl company info` manually.',
      );
    }

    // Step 8: Offer to register MCP server with Claude Code
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl2 = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        console.log('');
        const mcpAnswer = (await rl2.question('Register the MCP server with Claude Code? [Y/n] '))
          .trim()
          .toLowerCase();
        const doRegister = mcpAnswer === '' || mcpAnswer === 'y' || mcpAnswer === 'yes';

        if (doRegister) {
          const { execFile } = await import('node:child_process');
          // Detect whether we're running via npx or from a local build.
          // All arguments below are static constants — no user input is interpolated.
          const argv0 = process.argv[1] ?? '';
          const useNpx = argv0.includes('npx') || argv0.includes('.bin/noxctl');
          const mcpArgs = useNpx
            ? ['mcp', 'add', 'fortnox', '--', 'npx', 'noxctl', 'serve']
            : ['mcp', 'add', 'fortnox', '--', 'node', argv0, 'serve'];

          await new Promise<void>((resolve) => {
            execFile('claude', mcpArgs, (err) => {
              if (err) {
                console.log('Could not register automatically. Run this manually:');
                console.log('  claude mcp add fortnox -- npx noxctl serve');
              } else {
                console.log('MCP server registered. Restart Claude Code to pick it up.');
              }
              resolve();
            });
          });
        }
      } finally {
        rl2.close();
      }
    }
  });

// --- setup ---
program
  .command('setup')
  .description('Connect to your Fortnox account via OAuth')
  .action(async () => {
    const clientId = process.env.FORTNOX_CLIENT_ID;
    const clientSecret = process.env.FORTNOX_CLIENT_SECRET;
    const serviceAccount = process.env.FORTNOX_SERVICE_ACCOUNT === '1';

    if (!clientId || !clientSecret) {
      console.error('Error: FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must be set.');
      console.error('');
      console.error('1. Go to https://developer.fortnox.se/');
      console.error('2. Create an app with redirect URI: http://localhost:9876/callback');
      console.error('3. Run:');
      console.error(
        '   FORTNOX_CLIENT_ID=<your-id> FORTNOX_CLIENT_SECRET=<your-secret> noxctl setup',
      );
      console.error('');
      console.error(
        'Optional: Add FORTNOX_SERVICE_ACCOUNT=1 to enable client credentials flow (requires service account enabled in Developer Portal)',
      );
      process.exit(1);
    }

    const { runOAuthSetup } = await import('./auth.js');
    await runOAuthSetup({ clientId, clientSecret, serviceAccount });
  });

// --- serve (default command) ---
program
  .command('serve', { isDefault: true })
  .description('Start the MCP server (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('./index.js');
    await startMcpServer();
  });

// --- invoices ---
const invoices = program.command('invoices').description('Invoice operations');

invoices
  .command('list')
  .description('List/filter invoices')
  .option('--filter <filter>', 'Filter: cancelled, fullypaid, unpaid, unpaidoverdue, unbooked')
  .option('--customer <number>', 'Filter by customer number')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .action(async (opts) => {
    const { listInvoices } = await import('./operations/invoices.js');
    const data = await listInvoices({
      filter: opts.filter,
      customerNumber: opts.customer,
      fromDate: opts.from,
      toDate: opts.to,
      page: opts.page,
      limit: opts.limit,
    });
    const envelope = data as unknown as {
      Invoices: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Invoices ?? [], invoiceListColumns, json(), data, envelope.MetaInformation);
  });

invoices
  .command('get <documentNumber>')
  .description('Get a single invoice')
  .action(async (documentNumber: string) => {
    const { getInvoice } = await import('./operations/invoices.js');
    const data = await getInvoice(documentNumber);
    outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json());
  });

invoices
  .command('create')
  .description('Create an invoice')
  .requiredOption('--customer <number>', 'Customer number')
  .requiredOption('--input <file>', 'Invoice data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createInvoice } = await import('./operations/invoices.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
    if (
      !(await confirmMutation(`Create invoice for customer ${opts.customer}`, opts, {
        Invoice: params,
      }))
    ) {
      return;
    }
    const data = await createInvoice(params);
    outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json());
  });

invoices
  .command('send <documentNumber>')
  .description('Send an invoice')
  .addOption(
    new Option('--method <method>', 'Send method: email, print, einvoice')
      .choices(['email', 'print', 'einvoice'])
      .default('email'),
  )
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(
    async (documentNumber: string, opts: { method: string; yes?: boolean; dryRun?: boolean }) => {
      const { sendInvoice } = await import('./operations/invoices.js');
      if (!(await confirmMutation(`Send invoice ${documentNumber} via ${opts.method}`, opts))) {
        return;
      }
      const data = await sendInvoice(documentNumber, opts.method as 'email' | 'print' | 'einvoice');
      outputConfirmation(
        `Invoice ${documentNumber} sent via ${opts.method}.`,
        json(),
        data,
        invoiceConfirmColumns,
      );
    },
  );

invoices
  .command('bookkeep <documentNumber>')
  .description('Bookkeep an invoice')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { bookkeepInvoice } = await import('./operations/invoices.js');
    if (!(await confirmMutation(`Bookkeep invoice ${documentNumber}`, opts))) {
      return;
    }
    const data = await bookkeepInvoice(documentNumber);
    outputConfirmation(`Invoice ${documentNumber} bookkeept.`, json(), data, invoiceConfirmColumns);
  });

invoices
  .command('credit <documentNumber>')
  .description('Credit an invoice')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { creditInvoice } = await import('./operations/invoices.js');
    if (!(await confirmMutation(`Credit invoice ${documentNumber}`, opts))) {
      return;
    }
    const data = await creditInvoice(documentNumber);
    outputConfirmation(`Invoice ${documentNumber} credited.`, json(), data, invoiceConfirmColumns);
  });

// --- tax ---
const tax = program.command('tax').description('Tax operations');

tax
  .command('report')
  .description('Generate VAT tax report for a period')
  .requiredOption('--from <date>', 'From date (YYYY-MM-DD)')
  .requiredOption('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--year <number>', 'Financial year', parseInt)
  .action(async (opts) => {
    const { generateTaxReport } = await import('./operations/tax.js');
    const data = await generateTaxReport({
      fromDate: opts.from,
      toDate: opts.to,
      financialYear: opts.year,
    });
    if (json()) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatTaxReport(data as unknown as Record<string, unknown>));
    }
  });

// --- accounts ---
const accounts = program.command('accounts').description('Chart of accounts operations');

accounts
  .command('list')
  .description('List accounts')
  .option('--search <term>', 'Search by account name or number')
  .option('--year <number>', 'Financial year', parseInt)
  .action(async (opts) => {
    const { listAccounts } = await import('./operations/accounts.js');
    const data = await listAccounts({
      search: opts.search,
      financialYear: opts.year,
    });
    const items = Array.isArray(data) ? data : [];
    outputList(items as Record<string, unknown>[], accountListColumns, json(), data);
  });

// --- customers ---
const customers = program.command('customers').description('Customer operations');

customers
  .command('list')
  .description('List/search customers')
  .option('--search <term>', 'Search by name')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .action(async (opts) => {
    const { listCustomers } = await import('./operations/customers.js');
    const data = await listCustomers({
      search: opts.search,
      page: opts.page,
      limit: opts.limit,
    });
    const envelope = data as unknown as {
      Customers: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.Customers ?? [],
      customerListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

customers
  .command('get <customerNumber>')
  .description('Get a single customer')
  .action(async (customerNumber: string) => {
    const { getCustomer } = await import('./operations/customers.js');
    const data = await getCustomer(customerNumber);
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json());
  });

customers
  .command('create')
  .description('Create a customer')
  .requiredOption('--name <name>', 'Customer name')
  .option('--input <file>', 'Customer data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createCustomer } = await import('./operations/customers.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params = { ...input, Name: opts.name };
    if (!(await confirmMutation(`Create customer "${opts.name}"`, opts, { Customer: params }))) {
      return;
    }
    const data = await createCustomer(params);
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json());
  });

customers
  .command('update <customerNumber>')
  .description('Update a customer')
  .requiredOption('--input <file>', 'Customer data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (customerNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateCustomer } = await import('./operations/customers.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (
        !(await confirmMutation(`Update customer ${customerNumber}`, opts, { Customer: fields }))
      ) {
        return;
      }
      const data = await updateCustomer(customerNumber, fields);
      outputDetail(data as Record<string, unknown>, customerDetailColumns, json());
    },
  );

// --- company ---
const company = program.command('company').description('Company operations');

company
  .command('info')
  .description('Get company information')
  .action(async () => {
    const { getCompanyInfo } = await import('./operations/company.js');
    const data = await getCompanyInfo();
    outputDetail(data as Record<string, unknown>, companyDetailColumns, json());
  });

// --- vouchers ---
const vouchers = program.command('vouchers').description('Voucher operations');

vouchers
  .command('list')
  .description('List vouchers')
  .option('--series <series>', 'Voucher series (e.g. "A")')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--year <number>', 'Financial year', parseInt)
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .action(async (opts) => {
    const { listVouchers } = await import('./operations/vouchers.js');
    const data = await listVouchers({
      series: opts.series,
      fromDate: opts.from,
      toDate: opts.to,
      financialYear: opts.year,
      page: opts.page,
      limit: opts.limit,
    });
    const envelope = data as unknown as {
      Vouchers: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Vouchers ?? [], voucherListColumns, json(), data, envelope.MetaInformation);
  });

vouchers
  .command('create')
  .description('Create a voucher')
  .requiredOption('--input <file>', 'Voucher data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
    const { createVoucher } = await import('./operations/vouchers.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const params = JSON.parse(raw) as Record<string, unknown>;
    if (
      !(await confirmMutation(`Create voucher "${String(params.Description || '')}"`, opts, {
        Voucher: params,
      }))
    ) {
      return;
    }
    const data = await createVoucher(params);
    outputDetail(data as Record<string, unknown>, voucherDetailColumns, json());
  });

// Error handling
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof Error && 'code' in err) {
    const code = (err as { code: string }).code;
    // Commander throws for --help and --version with exitCode 0
    if (code === 'commander.helpDisplayed' || code === 'commander.version') {
      process.exit(0);
    }
    if (code === 'commander.unknownCommand' || code === 'commander.missingMandatoryOptionValue') {
      process.exit(1);
    }
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
