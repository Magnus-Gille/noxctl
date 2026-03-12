#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
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
  .action(async (opts) => {
    const { createInvoice } = await import('./operations/invoices.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
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
  .action(async (documentNumber: string, opts: { method: string }) => {
    const { sendInvoice } = await import('./operations/invoices.js');
    const data = await sendInvoice(documentNumber, opts.method as 'email' | 'print' | 'einvoice');
    outputConfirmation(`Invoice ${documentNumber} sent via ${opts.method}.`, json(), data);
  });

invoices
  .command('bookkeep <documentNumber>')
  .description('Bookkeep an invoice')
  .action(async (documentNumber: string) => {
    const { bookkeepInvoice } = await import('./operations/invoices.js');
    const data = await bookkeepInvoice(documentNumber);
    outputConfirmation(`Invoice ${documentNumber} bookkeept.`, json(), data);
  });

invoices
  .command('credit <documentNumber>')
  .description('Credit an invoice')
  .action(async (documentNumber: string) => {
    const { creditInvoice } = await import('./operations/invoices.js');
    const data = await creditInvoice(documentNumber);
    outputConfirmation(`Invoice ${documentNumber} credited.`, json(), data);
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
  .action(async (opts) => {
    const { createCustomer } = await import('./operations/customers.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params = { ...input, Name: opts.name };
    const data = await createCustomer(params);
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json());
  });

customers
  .command('update <customerNumber>')
  .description('Update a customer')
  .requiredOption('--input <file>', 'Customer data as JSON file (or - for stdin)')
  .action(async (customerNumber: string, opts: { input: string }) => {
    const { updateCustomer } = await import('./operations/customers.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    const data = await updateCustomer(customerNumber, fields);
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json());
  });

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
  .action(async (opts) => {
    const { createVoucher } = await import('./operations/vouchers.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const params = JSON.parse(raw) as Record<string, unknown>;
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
