#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';

const program = new Command();

program
  .name('noxctl')
  .description('CLI and MCP server for Fortnox accounting')
  .version('0.1.0');

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
const invoices = program
  .command('invoices')
  .description('Invoice operations');

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
    console.log(JSON.stringify(data, null, 2));
  });

invoices
  .command('get <documentNumber>')
  .description('Get a single invoice')
  .action(async (documentNumber: string) => {
    const { getInvoice } = await import('./operations/invoices.js');
    const data = await getInvoice(documentNumber);
    console.log(JSON.stringify(data, null, 2));
  });

invoices
  .command('create')
  .description('Create an invoice')
  .requiredOption('--customer <number>', 'Customer number')
  .requiredOption('--input <file>', 'Invoice data as JSON file (or - for stdin)')
  .action(async (opts) => {
    const { createInvoice } = await import('./operations/invoices.js');
    const raw = opts.input === '-'
      ? readFileSync(0, 'utf-8')
      : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
    const data = await createInvoice(params);
    console.log(JSON.stringify(data, null, 2));
  });

invoices
  .command('send <documentNumber>')
  .description('Send an invoice')
  .addOption(
    new Option('--method <method>', 'Send method: email, print, einvoice')
      .choices(['email', 'print', 'einvoice'])
      .default('email'),
  )
  .action(async (documentNumber: string, opts: { method: string }) => {
    const { sendInvoice } = await import('./operations/invoices.js');
    const data = await sendInvoice(documentNumber, opts.method as 'email' | 'print' | 'einvoice');
    console.log(JSON.stringify(data, null, 2));
  });

invoices
  .command('bookkeep <documentNumber>')
  .description('Bookkeep an invoice')
  .action(async (documentNumber: string) => {
    const { bookkeepInvoice } = await import('./operations/invoices.js');
    const data = await bookkeepInvoice(documentNumber);
    console.log(JSON.stringify(data, null, 2));
  });

invoices
  .command('credit <documentNumber>')
  .description('Credit an invoice')
  .action(async (documentNumber: string) => {
    const { creditInvoice } = await import('./operations/invoices.js');
    const data = await creditInvoice(documentNumber);
    console.log(JSON.stringify(data, null, 2));
  });

// --- tax ---
const tax = program
  .command('tax')
  .description('Tax operations');

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
    console.log(JSON.stringify(data, null, 2));
  });

// --- accounts ---
const accounts = program
  .command('accounts')
  .description('Chart of accounts operations');

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
    console.log(JSON.stringify(data, null, 2));
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
