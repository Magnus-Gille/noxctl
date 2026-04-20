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
  formatFinancialReport,
} from './formatter.js';
import {
  readActivePointer,
  writeActivePointer,
  deleteActivePointer,
  readProfileIndex,
  resolveProfile,
  type ResolvedProfile,
} from './profiles.js';
import { setResolvedProfile } from './auth.js';
import { DEFAULT_PROFILE, InvalidProfileNameError } from './profile-name.js';
import {
  invoiceListColumns,
  invoiceDetailColumns,
  invoiceConfirmColumns,
  customerListColumns,
  customerDetailColumns,
  voucherListColumns,
  voucherDetailColumns,
  voucherRowColumns,
  accountListColumns,
  companyDetailColumns,
  articleListColumns,
  articleDetailColumns,
  supplierListColumns,
  supplierDetailColumns,
  supplierInvoiceListColumns,
  supplierInvoiceDetailColumns,
  supplierInvoiceConfirmColumns,
  invoicePaymentListColumns,
  invoicePaymentDetailColumns,
  supplierInvoicePaymentListColumns,
  supplierInvoicePaymentDetailColumns,
  offerListColumns,
  offerDetailColumns,
  orderListColumns,
  orderDetailColumns,
  projectListColumns,
  projectDetailColumns,
  costCenterListColumns,
  costCenterDetailColumns,
  taxReductionListColumns,
  taxReductionDetailColumns,
  priceListListColumns,
  priceListDetailColumns,
  priceListColumns,
  priceDetailColumns,
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
  )
  .option(
    '--profile <name>',
    'Profile to operate on (overrides NOXCTL_PROFILE and active pointer)',
  );

function json(): boolean {
  return isJsonMode(program.opts());
}

let resolvedProfileInfo: ResolvedProfile = { name: DEFAULT_PROFILE, source: 'default' };

export function getResolvedProfileInfo(): ResolvedProfile {
  return resolvedProfileInfo;
}

// Commands that don't need (and shouldn't require) a resolved profile.
const PROFILE_RESOLUTION_SKIP = new Set(['help']);

program.hook('preAction', async (thisCommand, actionCommand) => {
  const name = actionCommand.name();
  if (PROFILE_RESOLUTION_SKIP.has(name)) return;

  const flag = (program.opts().profile as string | undefined) ?? undefined;
  const env = process.env['NOXCTL_PROFILE'] ?? undefined;
  let pointer: string | null = null;
  try {
    pointer = await readActivePointer();
  } catch {
    pointer = null;
  }

  try {
    resolvedProfileInfo = resolveProfile({ flag, env, pointer });
  } catch (err) {
    if (err instanceof InvalidProfileNameError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  setResolvedProfile(resolvedProfileInfo.name);

  if (
    resolvedProfileInfo.name.toLowerCase() !== DEFAULT_PROFILE &&
    process.stderr.isTTY &&
    name !== 'current'
  ) {
    process.stderr.write(`[profile: ${resolvedProfileInfo.name}]\n`);
  }
});

async function fetchCompanyHint(): Promise<string | undefined> {
  try {
    const { loadCredentials } = await import('./auth.js');
    const creds = await loadCredentials();
    return creds?.company_name;
  } catch {
    return undefined;
  }
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

  const company = await fetchCompanyHint();
  const suffix = company ? ` (${company})` : '';

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${action}. Continue?${suffix} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

// --- init (interactive setup wizard) ---
program
  .command('init')
  .description('Interactive setup wizard — recommended onboarding path')
  .option(
    '--profile <name>',
    'Profile to create/re-auth (defaults to resolved profile or "default")',
  )
  .action(async (initOpts: { profile?: string }) => {
    const { loadCredentials, runOAuthSetup } = await import('./auth.js');
    const { validateProfileName } = await import('./profile-name.js');

    let targetProfile: string;
    try {
      targetProfile = validateProfileName(initOpts.profile ?? resolvedProfileInfo.name);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }

    // If `init --profile <name>` names a different profile than the preAction
    // hook resolved, rebind the in-process resolved profile so downstream work
    // (verification via getCompanyInfo, runOAuthSetup's internal saveCredentials
    // call chain) targets the profile being initialized — not a stale pointer.
    if (targetProfile.toLowerCase() !== resolvedProfileInfo.name.toLowerCase()) {
      setResolvedProfile(targetProfile);
      resolvedProfileInfo = { name: targetProfile, source: 'flag' };
    }

    // Step 1: Check if already configured
    const existing = await loadCredentials(targetProfile);
    if (existing) {
      console.log('Existing credentials found.');

      if (process.stdin.isTTY && process.stdout.isTTY) {
        const rlExisting = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = (
            await rlExisting.question(
              'Re-run setup? This will replace your current credentials. [y/N] ',
            )
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            console.log('Run `noxctl company info` to verify your current connection.');
            return;
          }
        } finally {
          rlExisting.close();
        }
      } else {
        console.log('Run `noxctl company info` to verify, or re-run interactively to reconfigure.');
        return;
      }
    }

    // Step 2: Welcome message
    console.log('Welcome to noxctl init!');
    console.log('');
    console.log("You'll need a Fortnox app from developer.fortnox.se with:");
    console.log('  - Redirect URI: http://localhost:9876/callback');
    console.log(
      '  - Scopes (Behörigheter): Artikel, Bokföring, Faktura, Företagsinformation, Inställningar, Kund, Leverantör, Leverantörsfaktura',
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
      let rl = createInterface({
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

        // Step 4: Prompt for Client Secret (masked input)
        const envClientSecret = process.env.FORTNOX_CLIENT_SECRET;
        if (envClientSecret) {
          process.stdout.write('Client Secret [env var set — press Enter to use it]: ');
        } else {
          process.stdout.write('Client Secret: ');
        }
        // Temporarily close rl so we can use raw mode for masked input
        rl.close();
        const clientSecretAnswer = await new Promise<string>((resolve) => {
          let buf = '';
          const stdin = process.stdin;
          stdin.setRawMode(true);
          stdin.resume();
          stdin.setEncoding('utf-8');
          const onData = (chunk: string) => {
            for (const ch of chunk) {
              if (ch === '\r' || ch === '\n') {
                stdin.setRawMode(false);
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                resolve(buf.trim());
                return;
              } else if (ch === '\u007f' || ch === '\b') {
                if (buf.length > 0) {
                  buf = buf.slice(0, -1);
                  process.stdout.write('\b \b');
                }
              } else if (ch === '\u0003') {
                // Ctrl-C
                process.exit(1);
              } else {
                buf += ch;
              }
            }
          };
          stdin.on('data', onData);
        });
        // Re-create rl for subsequent questions
        rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        clientSecret = clientSecretAnswer || envClientSecret || '';

        if (!clientSecret) {
          console.error('Error: Client Secret is required.');
          process.exit(1);
        }

        // Step 5: Service account question — default yes
        console.log('');
        console.log('Service account mode lets noxctl refresh tokens automatically without');
        console.log('opening a browser each time. Enable it in the Fortnox developer portal');
        console.log(
          'under your app\'s OAuth settings ("Möjliggör auktorisering som servicekonto").',
        );
        console.log('');
        const saAnswer = (await rl.question('Is service account mode enabled for your app? [Y/n] '))
          .trim()
          .toLowerCase();
        serviceAccount = saAnswer === '' || saAnswer === 'y' || saAnswer === 'yes';
      } finally {
        rl.close();
      }
    }

    // Step 6: Run OAuth flow
    await runOAuthSetup({ clientId, clientSecret, serviceAccount }, targetProfile);

    // Step 6b: Set the active pointer if this is the first profile or no pointer exists.
    try {
      const idx = await readProfileIndex();
      const existingPointer = await readActivePointer();
      const firstProfile = idx.profiles.length <= 1;
      if (firstProfile || !existingPointer) {
        await writeActivePointer(targetProfile);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: could not update active profile pointer: ${msg}`);
    }

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
        // Detect whether we're running via npx or from a local build.
        const argv0 = process.argv[1] ?? '';
        const useNpx = argv0.includes('npx') || argv0.includes('.bin/noxctl');

        console.log('');
        const mcpAnswer = (await rl2.question('Register the MCP server with Claude Code? [Y/n] '))
          .trim()
          .toLowerCase();
        const doRegister = mcpAnswer === '' || mcpAnswer === 'y' || mcpAnswer === 'yes';

        if (doRegister) {
          const { execFile } = await import('node:child_process');
          // All arguments below are static constants — no user input is interpolated.
          const mcpArgs = useNpx
            ? ['mcp', 'add', 'fortnox', '--', 'npx', 'noxctl', 'serve']
            : ['mcp', 'add', 'fortnox', '--', 'node', argv0, 'serve'];

          await new Promise<void>((resolve) => {
            execFile('claude', mcpArgs, (err) => {
              if (err) {
                const fallbackCmd = ['claude', ...mcpArgs].join(' ');
                console.log('Could not register automatically. Run this manually:');
                console.log(`  ${fallbackCmd}`);
              } else {
                console.log('MCP server registered. Restart Claude Code to pick it up.');
              }
              resolve();
            });
          });
        }

        // Offer npm link for local clone users so `noxctl` is in PATH
        if (!useNpx) {
          console.log('');
          const linkAnswer = (await rl2.question('Add `noxctl` to your PATH via npm link? [Y/n] '))
            .trim()
            .toLowerCase();
          const doLink = linkAnswer === '' || linkAnswer === 'y' || linkAnswer === 'yes';

          if (doLink) {
            const { execFile: execFileLink } = await import('node:child_process');
            await new Promise<void>((resolve) => {
              execFileLink('npm', ['link'], { cwd: process.cwd() }, (err) => {
                if (err) {
                  console.log('Could not link automatically. Run this manually:');
                  console.log('  npm link');
                } else {
                  console.log('Done! `noxctl` is now available globally.');
                }
                resolve();
              });
            });
          }
        }
      } finally {
        rl2.close();
      }
    }
  });

// --- logout ---
program
  .command('logout')
  .description('Remove stored Fortnox credentials for the resolved profile')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--all', 'Remove credentials for every profile (and the legacy slot)')
  .action(async (opts: { yes?: boolean; all?: boolean; dryRun?: boolean }) => {
    const { deleteCredentialBlob } = await import('./credentials-store.js');
    const { removeProfile } = await import('./profiles.js');

    if (opts.all) {
      if (!(await confirmMutation('Remove stored Fortnox credentials for ALL profiles', opts))) {
        return;
      }

      const idx = await readProfileIndex();
      const names = new Set<string>(idx.profiles.map((p) => p.name));
      names.add(DEFAULT_PROFILE);

      let removedAny = false;
      for (const name of names) {
        const deleted = await deleteCredentialBlob(name);
        if (deleted) removedAny = true;
        try {
          await removeProfile(name);
        } catch {
          // best-effort — index cleanup must not abort logout
        }
      }
      try {
        await deleteActivePointer();
      } catch {
        // ignore
      }

      if (removedAny) {
        console.log('Removed credentials for all profiles.');
      } else {
        console.log('No credentials found to remove.');
      }
      return;
    }

    const target = resolvedProfileInfo.name;
    const { loadCredentials } = await import('./auth.js');

    const existing = await loadCredentials(target);
    if (!existing) {
      console.log(`No credentials found for profile "${target}". Nothing to remove.`);
      return;
    }

    if (!(await confirmMutation(`Remove stored credentials for profile "${target}"`, opts))) {
      return;
    }

    const deleted = await deleteCredentialBlob(target);

    try {
      await removeProfile(target);
    } catch {
      // best-effort
    }

    try {
      const pointer = await readActivePointer();
      if (pointer && pointer.toLowerCase() === target.toLowerCase()) {
        await deleteActivePointer();
      }
    } catch {
      // ignore
    }

    if (deleted) {
      console.log(`Credentials for profile "${target}" removed.`);
    } else {
      console.log('Could not remove credentials from the system keychain.');
      console.log('They may have already been removed, or you may need to remove them manually.');
    }
  });

// --- profile ---
const profile = program.command('profile').description('Manage noxctl profiles');

profile
  .command('use <name>')
  .description('Set the active profile (writes ~/.fortnox-mcp/active-profile)')
  .action(async (name: string) => {
    const { validateProfileName } = await import('./profile-name.js');
    let validated: string;
    try {
      validated = validateProfileName(name);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }

    const { loadCredentials } = await import('./auth.js');
    const creds = await loadCredentials(validated);
    if (!creds) {
      console.error(
        `No credentials found for profile "${validated}". Run \`noxctl init --profile ${validated}\` first.`,
      );
      process.exit(1);
    }

    await writeActivePointer(validated);
    if (json()) {
      console.log(JSON.stringify({ name: validated, source: 'pointer' }));
    } else {
      console.log(`Active profile set to "${validated}".`);
    }
  });

profile
  .command('current')
  .description('Show the currently resolved profile and where it came from')
  .action(() => {
    if (json()) {
      console.log(JSON.stringify(resolvedProfileInfo));
    } else {
      console.log(`${resolvedProfileInfo.name} (source: ${resolvedProfileInfo.source})`);
    }
  });

profile
  .command('list')
  .description('List known profiles from the index')
  .action(async () => {
    const idx = await readProfileIndex();
    if (json()) {
      console.log(JSON.stringify(idx.profiles, null, 2));
      return;
    }
    if (idx.profiles.length === 0) {
      console.log('No profiles registered. Run `noxctl init` to create one.');
      return;
    }
    for (const p of idx.profiles) {
      const marker = p.name.toLowerCase() === resolvedProfileInfo.name.toLowerCase() ? '*' : ' ';
      const company = p.company_name ? ` — ${p.company_name}` : '';
      const tenant = p.tenant_id ? ` [tenant ${p.tenant_id}]` : '';
      console.log(`${marker} ${p.name}${company}${tenant}`);
    }
  });

// --- doctor ---
program
  .command('doctor')
  .description('Check setup: credentials, token, API connectivity, and scopes')
  .action(async () => {
    const { loadCredentials } = await import('./auth.js');
    let ok = true;

    function pass(label: string, detail?: string) {
      console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    }
    function fail(label: string, detail?: string) {
      ok = false;
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    }

    console.log('Checking noxctl configuration...\n');

    // 1. Node version
    const nodeVersion = process.versions.node;
    const major = parseInt(nodeVersion.split('.')[0]!, 10);
    if (major >= 20) {
      pass('Node.js', `v${nodeVersion}`);
    } else {
      fail('Node.js', `v${nodeVersion} (need 20+)`);
    }

    // 2. Credential store backend
    const storeBackend =
      process.platform === 'darwin'
        ? 'macOS Keychain'
        : process.platform === 'win32'
          ? 'Windows DPAPI'
          : 'Linux Secret Service';
    pass('Credential store', storeBackend);

    // 2b. Profile resolution
    pass('Profile', `${resolvedProfileInfo.name} (source: ${resolvedProfileInfo.source})`);

    // 2c. Active pointer health — surface a corrupt pointer file even though
    // readActivePointer() degrades silently.
    try {
      const { paths } = await import('./profiles.js');
      const fsp = await import('node:fs/promises');
      const raw = await fsp.readFile(paths.activePointerFile, 'utf-8').catch(() => null);
      if (raw !== null) {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          const { validateProfileName } = await import('./profile-name.js');
          try {
            validateProfileName(trimmed);
            const idx = await readProfileIndex();
            const known = idx.profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase());
            if (known) {
              pass('Active pointer', trimmed);
            } else {
              fail(
                'Active pointer',
                `points to unknown profile "${trimmed}" — run \`noxctl profile use <name>\` to fix`,
              );
            }
          } catch {
            fail('Active pointer', 'contains an invalid name — delete to reset');
          }
        }
      }
    } catch {
      // best-effort diagnostic — don't block doctor on filesystem issues
    }

    // 3. Credentials exist
    const creds = await loadCredentials();
    if (!creds) {
      fail(
        'Credentials',
        `not found for profile "${resolvedProfileInfo.name}" — run \`noxctl init${
          resolvedProfileInfo.name === DEFAULT_PROFILE
            ? ''
            : ` --profile ${resolvedProfileInfo.name}`
        }\` to set up`,
      );
      console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
      return;
    }
    pass('Credentials', 'found');
    if (creds.company_name) {
      pass('Company (cached)', creds.company_name);
    }

    // 4. Client ID present
    if (creds.client_id) {
      pass('Client ID', `${creds.client_id.slice(0, 8)}...`);
    } else {
      fail('Client ID', 'missing');
    }

    // 5. Tenant ID (service account)
    if (creds.tenant_id) {
      pass('Service account', `tenant ${creds.tenant_id}`);
    } else {
      pass('Service account', 'not configured (using refresh token flow)');
    }

    // 6. Token expiry
    const now = Date.now();
    if (creds.expires_at > now) {
      const minutesLeft = Math.round((creds.expires_at - now) / 60000);
      pass('Access token', `valid for ~${minutesLeft} min`);
    } else {
      pass('Access token', 'expired (will auto-refresh on next request)');
    }

    // 7. API connectivity — try fetching company info
    try {
      const { getCompanyInfo } = await import('./operations/company.js');
      const data = await getCompanyInfo();
      const company = data as Record<string, unknown>;
      const name = company['CompanyName'] || 'unknown';
      pass('API connection', `${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail('API connection', msg);
      console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
      return;
    }

    // 8. Scope validation — probe each scope with a lightweight GET
    const { SCOPES } = await import('./auth.js');
    const { fortnoxRequest, FortnoxApiError } = await import('./fortnox-client.js');

    const scopeEndpoints: Record<string, string> = {
      article: 'articles?limit=1',
      customer: 'customers?limit=1',
      invoice: 'invoices?limit=1',
      payment: 'invoicepayments?limit=1',
      supplier: 'suppliers?limit=1',
      supplierinvoice: 'supplierinvoices?limit=1',
      bookkeeping: 'vouchers?limit=1',
      companyinformation: 'companyinformation',
      settings: 'settings/company',
    };

    const required = SCOPES.split(' ');
    const missing: string[] = [];

    for (const scope of required) {
      const endpoint = scopeEndpoints[scope];
      if (!endpoint) continue;
      try {
        await fortnoxRequest(endpoint);
      } catch (err) {
        if (err instanceof FortnoxApiError && err.statusCode === 403) {
          missing.push(scope);
        }
        // Non-403 errors (e.g. 500) are not scope problems — ignore here
      }
    }

    if (missing.length === 0) {
      pass('Scopes', `all ${required.length} scopes authorized`);
    } else {
      fail(
        'Scopes',
        `missing: ${missing.join(', ')}. Enable them in your Fortnox app at developer.fortnox.se`,
      );
    }

    console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
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
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listInvoices } = await import('./operations/invoices.js');
    const data = await listInvoices({
      filter: opts.filter,
      customerNumber: opts.customer,
      fromDate: opts.from,
      toDate: opts.to,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
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
  .addHelpText(
    'after',
    `
Examples:
  echo '{"InvoiceRows":[{"ArticleNumber":"1","DeliveredQuantity":10,"Price":1500}]}' | noxctl invoices create --customer 25 --input - --dry-run

  # Minimal JSON (Description instead of ArticleNumber):
  echo '{"InvoiceRows":[{"Description":"Consulting","DeliveredQuantity":8,"Price":1200,"AccountNumber":3001,"VAT":25}]}' | noxctl invoices create --customer 25 --input - --yes`,
  )
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
  .command('update <documentNumber>')
  .description('Update an invoice (not yet bookkeept)')
  .requiredOption('--input <file>', 'Invoice data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"DueDate":"2026-04-30","OurReference":"Casey Example"}' | noxctl invoices update 28 --input - --dry-run
  echo '{"InvoiceRows":[{"ArticleNumber":"1","DeliveredQuantity":5,"Price":2000}]}' | noxctl invoices update 28 --input - --yes`,
  )
  .action(
    async (documentNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateInvoice } = await import('./operations/invoices.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!(await confirmMutation(`Update invoice ${documentNumber}`, opts, { Invoice: fields }))) {
        return;
      }
      const data = await updateInvoice(documentNumber, fields);
      outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json());
    },
  );

invoices
  .command('send <documentNumber>')
  .description('Send an invoice')
  .addOption(
    new Option('--method <method>', 'Send method: email, print, einvoice')
      .choices(['email', 'print', 'einvoice'])
      .default('email'),
  )
  .option('--subject <subject>', 'Email subject (default: keeps existing)')
  .option('--body <body>', 'Email body text')
  .option('--bcc <email>', 'BCC email address')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(
    async (
      documentNumber: string,
      opts: {
        method: string;
        subject?: string;
        body?: string;
        bcc?: string;
        yes?: boolean;
        dryRun?: boolean;
      },
    ) => {
      const { sendInvoice } = await import('./operations/invoices.js');
      if (!(await confirmMutation(`Send invoice ${documentNumber} via ${opts.method}`, opts))) {
        return;
      }
      const emailOptions =
        opts.subject || opts.body || opts.bcc
          ? { subject: opts.subject, body: opts.body, bcc: opts.bcc }
          : undefined;
      const data = await sendInvoice(
        documentNumber,
        opts.method as 'email' | 'print' | 'einvoice',
        emailOptions,
      );
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

// --- reports ---
const reports = program
  .command('reports')
  .description('Financial reports (resultat/balansräkning)');

reports
  .command('income')
  .alias('resultat')
  .description('Income statement (resultaträkning)')
  .option('--year <number>', 'Financial year', parseInt)
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .action(async (opts) => {
    const { getIncomeStatement } = await import('./operations/financial-reports.js');
    const data = await getIncomeStatement({
      financialYear: opts.year,
      fromDate: opts.from,
      toDate: opts.to,
    });
    if (json()) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatFinancialReport(data));
    }
  });

reports
  .command('balance')
  .alias('balans')
  .description('Balance sheet (balansräkning)')
  .option('--year <number>', 'Financial year', parseInt)
  .option('--to <date>', 'As-of date (YYYY-MM-DD)')
  .action(async (opts) => {
    const { getBalanceSheet } = await import('./operations/financial-reports.js');
    const data = await getBalanceSheet({ financialYear: opts.year, toDate: opts.to });
    if (json()) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatFinancialReport(data));
    }
  });

// --- accounts ---
const accounts = program.command('accounts').description('Chart of accounts operations');

accounts
  .command('list')
  .description('List accounts')
  .option('--search <term>', 'Search by account name or number')
  .option('--year <number>', 'Financial year', parseInt)
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listAccounts } = await import('./operations/accounts.js');
    const data = await listAccounts({
      search: opts.search,
      financialYear: opts.year,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    outputList(data.Accounts ?? [], accountListColumns, json(), data, data.MetaInformation);
  });

// --- customers ---
const customers = program.command('customers').description('Customer operations');

customers
  .command('list')
  .description('List/search customers')
  .option('--search <term>', 'Search by name')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listCustomers } = await import('./operations/customers.js');
    const data = await listCustomers({
      search: opts.search,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
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
  .addHelpText(
    'after',
    `
Examples:
  noxctl customers create --name "Acme AB" --yes
  echo '{"OrganisationNumber":"556677-8899","Email":"info@acme.se","City":"Stockholm"}' | noxctl customers create --name "Acme AB" --input - --yes`,
  )
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
  .addHelpText(
    'after',
    `
Examples:
  echo '{"Email":"new@acme.se","Phone":"08-123456"}' | noxctl customers update 25 --input - --yes`,
  )
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

// --- articles ---
const articles = program.command('articles').description('Article operations');

articles
  .command('list')
  .description('List/search articles')
  .option('--search <term>', 'Search by description')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listArticles } = await import('./operations/articles.js');
    const data = await listArticles({
      search: opts.search,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Articles: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Articles ?? [], articleListColumns, json(), data, envelope.MetaInformation);
  });

articles
  .command('get <articleNumber>')
  .description('Get a single article')
  .action(async (articleNumber: string) => {
    const { getArticle } = await import('./operations/articles.js');
    const data = await getArticle(articleNumber);
    outputDetail(data as Record<string, unknown>, articleDetailColumns, json());
  });

articles
  .command('create')
  .description('Create an article')
  .requiredOption('--description <text>', 'Article description')
  .option('--article-number <number>', 'Article number (auto-generated if omitted)')
  .option('--input <file>', 'Article data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  noxctl articles create --description "Konsulttimme" --yes
  echo '{"SalesPrice":1500,"Unit":"tim","SalesAccount":3001,"VAT":25}' | noxctl articles create --description "Konsulttimme" --input - --yes`,
  )
  .action(async (opts) => {
    const { createArticle } = await import('./operations/articles.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = { ...input, Description: opts.description };
    if (opts.articleNumber) params.ArticleNumber = opts.articleNumber;
    if (
      !(await confirmMutation(`Create article "${opts.description}"`, opts, { Article: params }))
    ) {
      return;
    }
    const data = await createArticle(params);
    outputDetail(data as Record<string, unknown>, articleDetailColumns, json());
  });

articles
  .command('update <articleNumber>')
  .description('Update an article')
  .requiredOption('--input <file>', 'Article data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"SalesPrice":1800}' | noxctl articles update 1 --input - --yes`,
  )
  .action(
    async (articleNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateArticle } = await import('./operations/articles.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!(await confirmMutation(`Update article ${articleNumber}`, opts, { Article: fields }))) {
        return;
      }
      const data = await updateArticle(articleNumber, fields);
      outputDetail(data as Record<string, unknown>, articleDetailColumns, json());
    },
  );

// --- suppliers ---
const suppliers = program.command('suppliers').description('Supplier operations');

suppliers
  .command('list')
  .description('List/search suppliers')
  .option('--search <term>', 'Search by name')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listSuppliers } = await import('./operations/suppliers.js');
    const data = await listSuppliers({
      search: opts.search,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Suppliers: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.Suppliers ?? [],
      supplierListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

suppliers
  .command('get <supplierNumber>')
  .description('Get a single supplier')
  .action(async (supplierNumber: string) => {
    const { getSupplier } = await import('./operations/suppliers.js');
    const data = await getSupplier(supplierNumber);
    outputDetail(data as Record<string, unknown>, supplierDetailColumns, json());
  });

suppliers
  .command('create')
  .description('Create a supplier')
  .requiredOption('--name <name>', 'Supplier name')
  .option('--input <file>', 'Supplier data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  noxctl suppliers create --name "Dustin AB" --yes
  echo '{"OrganisationNumber":"556123-4567","BG":"123-4567","Email":"faktura@dustin.se"}' | noxctl suppliers create --name "Dustin AB" --input - --yes`,
  )
  .action(async (opts) => {
    const { createSupplier } = await import('./operations/suppliers.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params = { ...input, Name: opts.name };
    if (!(await confirmMutation(`Create supplier "${opts.name}"`, opts, { Supplier: params }))) {
      return;
    }
    const data = await createSupplier(params);
    outputDetail(data as Record<string, unknown>, supplierDetailColumns, json());
  });

suppliers
  .command('update <supplierNumber>')
  .description('Update a supplier')
  .requiredOption('--input <file>', 'Supplier data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"Email":"new@dustin.se","BG":"765-4321"}' | noxctl suppliers update 1 --input - --yes`,
  )
  .action(
    async (supplierNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateSupplier } = await import('./operations/suppliers.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (
        !(await confirmMutation(`Update supplier ${supplierNumber}`, opts, { Supplier: fields }))
      ) {
        return;
      }
      const data = await updateSupplier(supplierNumber, fields);
      outputDetail(data as Record<string, unknown>, supplierDetailColumns, json());
    },
  );

// --- supplier-invoices ---
const supplierInvoices = program
  .command('supplier-invoices')
  .alias('si')
  .description('Supplier invoice operations (leverantörsfakturor)');

supplierInvoices
  .command('list')
  .description('List/filter supplier invoices')
  .option(
    '--filter <filter>',
    'Filter: cancelled, fullypaid, unpaid, unpaidoverdue, unbooked, pendingpayment',
  )
  .option('--supplier <number>', 'Filter by supplier number')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listSupplierInvoices } = await import('./operations/supplier-invoices.js');
    const data = await listSupplierInvoices({
      filter: opts.filter,
      supplierNumber: opts.supplier,
      fromDate: opts.from,
      toDate: opts.to,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      SupplierInvoices: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.SupplierInvoices ?? [],
      supplierInvoiceListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

supplierInvoices
  .command('get <givenNumber>')
  .description('Get a single supplier invoice')
  .action(async (givenNumber: string) => {
    const { getSupplierInvoice } = await import('./operations/supplier-invoices.js');
    const data = await getSupplierInvoice(givenNumber);
    outputDetail(data as Record<string, unknown>, supplierInvoiceDetailColumns, json());
  });

supplierInvoices
  .command('create')
  .description('Create a supplier invoice')
  .requiredOption('--supplier <number>', 'Supplier number')
  .requiredOption('--input <file>', 'Invoice data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"InvoiceDate":"2026-03-01","DueDate":"2026-03-30","Total":1250,"OCR":"12345","SupplierInvoiceRows":[{"Account":6570,"Debit":1000,"Credit":0},{"Account":2641,"Debit":250,"Credit":0},{"Account":2440,"Debit":0,"Credit":1250}]}' | noxctl supplier-invoices create --supplier 1 --input - --dry-run`,
  )
  .action(async (opts) => {
    const { createSupplierInvoice } = await import('./operations/supplier-invoices.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { SupplierNumber: opts.supplier, ...input };
    if (
      !(await confirmMutation(`Create supplier invoice for supplier ${opts.supplier}`, opts, {
        SupplierInvoice: params,
      }))
    ) {
      return;
    }
    const data = await createSupplierInvoice(params);
    outputDetail(data as Record<string, unknown>, supplierInvoiceDetailColumns, json());
  });

supplierInvoices
  .command('bookkeep <givenNumber>')
  .description('Bookkeep a supplier invoice')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (givenNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { bookkeepSupplierInvoice } = await import('./operations/supplier-invoices.js');
    if (!(await confirmMutation(`Bookkeep supplier invoice ${givenNumber}`, opts))) {
      return;
    }
    const data = await bookkeepSupplierInvoice(givenNumber);
    outputConfirmation(
      `Supplier invoice ${givenNumber} bookkeept.`,
      json(),
      data,
      supplierInvoiceConfirmColumns,
    );
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
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listVouchers } = await import('./operations/vouchers.js');
    const data = await listVouchers({
      series: opts.series,
      fromDate: opts.from,
      toDate: opts.to,
      financialYear: opts.year,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Vouchers: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Vouchers ?? [], voucherListColumns, json(), data, envelope.MetaInformation);
  });

vouchers
  .command('get <series> <voucherNumber>')
  .description('Get a single voucher with rows (account, debit, credit)')
  .option('--year <number>', 'Financial year', parseInt)
  .action(async (series: string, voucherNumber: string, opts: { year?: number }) => {
    const { getVoucher } = await import('./operations/vouchers.js');
    const data = await getVoucher(series, voucherNumber, opts.year);
    if (json()) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      outputDetail(data as Record<string, unknown>, voucherDetailColumns, false);
      const rows = (data as Record<string, unknown>).VoucherRows as Record<string, unknown>[];
      if (rows?.length) {
        console.log('\nRows:');
        outputList(rows, voucherRowColumns, false, rows);
      }
    }
  });

vouchers
  .command('create')
  .description('Create a voucher')
  .requiredOption('--input <file>', 'Voucher data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"Description":"Bankkostnad","TransactionDate":"2026-03-01","VoucherRows":[{"Account":6570,"Debit":500},{"Account":1930,"Credit":500}]}' | noxctl vouchers create --input - --dry-run`,
  )
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

// --- invoice-payments ---
const invoicePayments = program
  .command('invoice-payments')
  .alias('ip')
  .description('Invoice payment operations (inbetalningar)');

invoicePayments
  .command('list')
  .description('List invoice payments')
  .option('--invoice <number>', 'Filter by invoice number')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listInvoicePayments } = await import('./operations/invoice-payments.js');
    const data = await listInvoicePayments({
      invoiceNumber: opts.invoice,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      InvoicePayments: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.InvoicePayments ?? [],
      invoicePaymentListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

invoicePayments
  .command('get <paymentNumber>')
  .description('Get a single invoice payment')
  .action(async (paymentNumber: string) => {
    const { getInvoicePayment } = await import('./operations/invoice-payments.js');
    const data = await getInvoicePayment(paymentNumber);
    outputDetail(data as Record<string, unknown>, invoicePaymentDetailColumns, json());
  });

invoicePayments
  .command('create')
  .description('Register a payment against an invoice')
  .requiredOption('--invoice <number>', 'Invoice number')
  .requiredOption('--amount <amount>', 'Payment amount', parseFloat)
  .requiredOption('--date <date>', 'Payment date (YYYY-MM-DD)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  noxctl invoice-payments create --invoice 1001 --amount 5000 --date 2026-03-20 --dry-run
  noxctl ip create --invoice 1001 --amount 5000 --date 2026-03-20 --yes`,
  )
  .action(async (opts) => {
    const { createInvoicePayment } = await import('./operations/invoice-payments.js');
    const params = {
      InvoiceNumber: parseInt(opts.invoice, 10),
      Amount: opts.amount,
      PaymentDate: opts.date,
    };
    if (
      !(await confirmMutation(
        `Register payment of ${opts.amount} for invoice ${opts.invoice}`,
        opts,
        {
          InvoicePayment: params,
        },
      ))
    ) {
      return;
    }
    const data = await createInvoicePayment(params);
    outputDetail(data as Record<string, unknown>, invoicePaymentDetailColumns, json());
  });

invoicePayments
  .command('delete <paymentNumber>')
  .description('Delete an invoice payment')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (paymentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteInvoicePayment } = await import('./operations/invoice-payments.js');
    if (!(await confirmMutation(`Delete invoice payment ${paymentNumber}`, opts))) {
      return;
    }
    await deleteInvoicePayment(paymentNumber);
    outputConfirmation(`Invoice payment ${paymentNumber} deleted.`, json(), {});
  });

invoicePayments
  .command('bookkeep <paymentNumber>')
  .description('Bookkeep an invoice payment')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (paymentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { bookkeepInvoicePayment } = await import('./operations/invoice-payments.js');
    if (!(await confirmMutation(`Bookkeep invoice payment ${paymentNumber}`, opts))) {
      return;
    }
    const result = await bookkeepInvoicePayment(paymentNumber);
    outputConfirmation(`Invoice payment ${paymentNumber} bookkeept.`, json(), result);
  });

// --- supplier-invoice-payments ---
const supplierInvoicePayments = program
  .command('supplier-invoice-payments')
  .alias('sip')
  .description('Supplier invoice payment operations (utbetalningar)');

supplierInvoicePayments
  .command('list')
  .description('List supplier invoice payments')
  .option('--invoice <number>', 'Filter by invoice number')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listSupplierInvoicePayments } =
      await import('./operations/supplier-invoice-payments.js');
    const data = await listSupplierInvoicePayments({
      invoiceNumber: opts.invoice,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      SupplierInvoicePayments: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.SupplierInvoicePayments ?? [],
      supplierInvoicePaymentListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

supplierInvoicePayments
  .command('get <paymentNumber>')
  .description('Get a single supplier invoice payment')
  .action(async (paymentNumber: string) => {
    const { getSupplierInvoicePayment } = await import('./operations/supplier-invoice-payments.js');
    const data = await getSupplierInvoicePayment(paymentNumber);
    outputDetail(data as Record<string, unknown>, supplierInvoicePaymentDetailColumns, json());
  });

supplierInvoicePayments
  .command('create')
  .description('Register a payment against a supplier invoice')
  .requiredOption('--invoice <number>', 'Supplier invoice number')
  .requiredOption('--amount <amount>', 'Payment amount', parseFloat)
  .requiredOption('--date <date>', 'Payment date (YYYY-MM-DD)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  noxctl supplier-invoice-payments create --invoice 501 --amount 3000 --date 2026-03-20 --dry-run
  noxctl sip create --invoice 501 --amount 3000 --date 2026-03-20 --yes`,
  )
  .action(async (opts) => {
    const { createSupplierInvoicePayment } =
      await import('./operations/supplier-invoice-payments.js');
    const params = {
      InvoiceNumber: opts.invoice,
      Amount: opts.amount,
      PaymentDate: opts.date,
    };
    if (
      !(await confirmMutation(
        `Register payment of ${opts.amount} for supplier invoice ${opts.invoice}`,
        opts,
        { SupplierInvoicePayment: params },
      ))
    ) {
      return;
    }
    const data = await createSupplierInvoicePayment(params);
    outputDetail(data as Record<string, unknown>, supplierInvoicePaymentDetailColumns, json());
  });

supplierInvoicePayments
  .command('delete <paymentNumber>')
  .description('Delete a supplier invoice payment')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (paymentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteSupplierInvoicePayment } =
      await import('./operations/supplier-invoice-payments.js');
    if (!(await confirmMutation(`Delete supplier invoice payment ${paymentNumber}`, opts))) {
      return;
    }
    await deleteSupplierInvoicePayment(paymentNumber);
    outputConfirmation(`Supplier invoice payment ${paymentNumber} deleted.`, json(), {});
  });

// --- offers ---
const offers = program.command('offers').description('Offer/quote operations (offerter)');

offers
  .command('list')
  .description('List/filter offers')
  .option('--filter <filter>', 'Filter: cancelled, expired, ordercreated, invoicecreated')
  .option('--customer <number>', 'Filter by customer number')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listOffers } = await import('./operations/offers.js');
    const data = await listOffers({
      filter: opts.filter,
      customerNumber: opts.customer,
      fromDate: opts.from,
      toDate: opts.to,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Offers: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Offers ?? [], offerListColumns, json(), data, envelope.MetaInformation);
  });

offers
  .command('get <documentNumber>')
  .description('Get a single offer')
  .action(async (documentNumber: string) => {
    const { getOffer } = await import('./operations/offers.js');
    const data = await getOffer(documentNumber);
    outputDetail(data as Record<string, unknown>, offerDetailColumns, json());
  });

offers
  .command('create')
  .description('Create an offer')
  .requiredOption('--customer <number>', 'Customer number')
  .requiredOption('--input <file>', 'Offer data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"OfferRows":[{"Description":"Consulting","DeliveredQuantity":10,"Price":1200}]}' | noxctl offers create --customer 25 --input - --dry-run`,
  )
  .action(async (opts) => {
    const { createOffer } = await import('./operations/offers.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
    if (
      !(await confirmMutation(`Create offer for customer ${opts.customer}`, opts, {
        Offer: params,
      }))
    ) {
      return;
    }
    const data = await createOffer(params);
    outputDetail(data as Record<string, unknown>, offerDetailColumns, json());
  });

offers
  .command('update <documentNumber>')
  .description('Update an offer')
  .requiredOption('--input <file>', 'Offer data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (documentNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateOffer } = await import('./operations/offers.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!(await confirmMutation(`Update offer ${documentNumber}`, opts, { Offer: fields }))) {
        return;
      }
      const data = await updateOffer(documentNumber, fields);
      outputDetail(data as Record<string, unknown>, offerDetailColumns, json());
    },
  );

offers
  .command('create-invoice <documentNumber>')
  .description('Create an invoice from an offer')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { createInvoiceFromOffer } = await import('./operations/offers.js');
    if (!(await confirmMutation(`Create invoice from offer ${documentNumber}`, opts))) {
      return;
    }
    const data = await createInvoiceFromOffer(documentNumber);
    outputConfirmation(
      `Invoice created from offer ${documentNumber}.`,
      json(),
      data,
      invoiceConfirmColumns,
    );
  });

offers
  .command('create-order <documentNumber>')
  .description('Create an order from an offer')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { createOrderFromOffer } = await import('./operations/offers.js');
    if (!(await confirmMutation(`Create order from offer ${documentNumber}`, opts))) {
      return;
    }
    const data = await createOrderFromOffer(documentNumber);
    outputConfirmation(`Order created from offer ${documentNumber}.`, json(), data);
  });

// --- orders ---
const orders = program.command('orders').description('Order operations (ordrar)');

orders
  .command('list')
  .description('List/filter orders')
  .option('--filter <filter>', 'Filter: cancelled, invoicecreated, invoicenotcreated')
  .option('--customer <number>', 'Filter by customer number')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listOrders } = await import('./operations/orders.js');
    const data = await listOrders({
      filter: opts.filter,
      customerNumber: opts.customer,
      fromDate: opts.from,
      toDate: opts.to,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Orders: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Orders ?? [], orderListColumns, json(), data, envelope.MetaInformation);
  });

orders
  .command('get <documentNumber>')
  .description('Get a single order')
  .action(async (documentNumber: string) => {
    const { getOrder } = await import('./operations/orders.js');
    const data = await getOrder(documentNumber);
    outputDetail(data as Record<string, unknown>, orderDetailColumns, json());
  });

orders
  .command('create')
  .description('Create an order')
  .requiredOption('--customer <number>', 'Customer number')
  .requiredOption('--input <file>', 'Order data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"OrderRows":[{"Description":"Consulting","DeliveredQuantity":10,"Price":1200}]}' | noxctl orders create --customer 25 --input - --dry-run`,
  )
  .action(async (opts) => {
    const { createOrder } = await import('./operations/orders.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
    if (
      !(await confirmMutation(`Create order for customer ${opts.customer}`, opts, {
        Order: params,
      }))
    ) {
      return;
    }
    const data = await createOrder(params);
    outputDetail(data as Record<string, unknown>, orderDetailColumns, json());
  });

orders
  .command('update <documentNumber>')
  .description('Update an order')
  .requiredOption('--input <file>', 'Order data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (documentNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateOrder } = await import('./operations/orders.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!(await confirmMutation(`Update order ${documentNumber}`, opts, { Order: fields }))) {
        return;
      }
      const data = await updateOrder(documentNumber, fields);
      outputDetail(data as Record<string, unknown>, orderDetailColumns, json());
    },
  );

orders
  .command('create-invoice <documentNumber>')
  .description('Create an invoice from an order')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { createInvoiceFromOrder } = await import('./operations/orders.js');
    if (!(await confirmMutation(`Create invoice from order ${documentNumber}`, opts))) {
      return;
    }
    const data = await createInvoiceFromOrder(documentNumber);
    outputConfirmation(
      `Invoice created from order ${documentNumber}.`,
      json(),
      data,
      invoiceConfirmColumns,
    );
  });

// --- projects ---
const projects = program.command('projects').description('Project operations');

projects
  .command('list')
  .description('List projects')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listProjects } = await import('./operations/projects.js');
    const data = await listProjects({
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Projects: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Projects ?? [], projectListColumns, json(), data, envelope.MetaInformation);
  });

projects
  .command('get <projectNumber>')
  .description('Get a single project')
  .action(async (projectNumber: string) => {
    const { getProject } = await import('./operations/projects.js');
    const data = await getProject(projectNumber);
    outputDetail(data as Record<string, unknown>, projectDetailColumns, json());
  });

projects
  .command('create')
  .description('Create a project')
  .requiredOption('--description <text>', 'Project description')
  .option('--project-number <number>', 'Project number (auto-generated if omitted)')
  .option('--status <status>', 'Status (ONGOING or COMPLETED)')
  .option('--input <file>', 'Project data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createProject } = await import('./operations/projects.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = { ...input, Description: opts.description };
    if (opts.projectNumber) params.ProjectNumber = opts.projectNumber;
    if (opts.status) params.Status = opts.status;
    if (
      !(await confirmMutation(`Create project "${opts.description}"`, opts, { Project: params }))
    ) {
      return;
    }
    const data = await createProject(params);
    outputDetail(data as Record<string, unknown>, projectDetailColumns, json());
  });

projects
  .command('update <projectNumber>')
  .description('Update a project')
  .requiredOption('--input <file>', 'Project data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (projectNumber: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
      const { updateProject } = await import('./operations/projects.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (!(await confirmMutation(`Update project ${projectNumber}`, opts, { Project: fields }))) {
        return;
      }
      const data = await updateProject(projectNumber, fields);
      outputDetail(data as Record<string, unknown>, projectDetailColumns, json());
    },
  );

// --- cost centers ---
const costcenters = program.command('costcenters').description('Cost center operations');

costcenters
  .command('list')
  .description('List cost centers')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listCostCenters } = await import('./operations/costcenters.js');
    const data = await listCostCenters({
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      CostCenters: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.CostCenters ?? [],
      costCenterListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

costcenters
  .command('get <code>')
  .description('Get a single cost center')
  .action(async (code: string) => {
    const { getCostCenter } = await import('./operations/costcenters.js');
    const data = await getCostCenter(code);
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json());
  });

costcenters
  .command('create')
  .description('Create a cost center')
  .requiredOption('--code <code>', 'Cost center code')
  .requiredOption('--description <text>', 'Description')
  .option('--input <file>', 'Cost center data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createCostCenter } = await import('./operations/costcenters.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      Code: opts.code,
      Description: opts.description,
    };
    if (
      !(await confirmMutation(`Create cost center "${opts.code}"`, opts, { CostCenter: params }))
    ) {
      return;
    }
    const data = await createCostCenter(params);
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json());
  });

costcenters
  .command('update <code>')
  .description('Update a cost center')
  .requiredOption('--input <file>', 'Cost center data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (code: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
    const { updateCostCenter } = await import('./operations/costcenters.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation(`Update cost center ${code}`, opts, { CostCenter: fields }))) {
      return;
    }
    const data = await updateCostCenter(code, fields);
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json());
  });

costcenters
  .command('delete <code>')
  .description('Delete a cost center')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (code: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteCostCenter } = await import('./operations/costcenters.js');
    if (!(await confirmMutation(`Delete cost center ${code}`, opts))) {
      return;
    }
    await deleteCostCenter(code);
    console.log(`Cost center ${code} deleted.`);
  });

// --- tax reductions (ROT/RUT) ---
const taxreductions = program
  .command('tax-reductions')
  .description('Tax reduction (ROT/RUT) operations');

taxreductions
  .command('list')
  .description('List tax reductions')
  .option('--filter <type>', 'Filter by document type (invoices, offers, orders)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listTaxReductions } = await import('./operations/taxreductions.js');
    const data = await listTaxReductions({
      filter: opts.filter,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      TaxReductions: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.TaxReductions ?? [],
      taxReductionListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

taxreductions
  .command('get <id>')
  .description('Get a single tax reduction')
  .action(async (id: string) => {
    const { getTaxReduction } = await import('./operations/taxreductions.js');
    const data = await getTaxReduction(parseInt(id, 10));
    outputDetail(data as Record<string, unknown>, taxReductionDetailColumns, json());
  });

taxreductions
  .command('create')
  .description('Create a tax reduction (ROT/RUT)')
  .requiredOption('--reference <number>', 'Reference number (e.g. invoice number)')
  .requiredOption('--type <type>', 'Type of reduction (rot or rut)')
  .requiredOption('--document-type <type>', 'Document type (INVOICE, OFFER, ORDER)')
  .requiredOption('--customer-name <name>', 'Customer name')
  .requiredOption('--amount <amount>', 'Asked amount in öre', parseInt)
  .option('--property <designation>', 'Property designation (required for ROT)')
  .option('--input <file>', 'Tax reduction data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createTaxReduction } = await import('./operations/taxreductions.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      ReferenceNumber: opts.reference,
      ReferenceDocumentType: opts.documentType,
      TypeOfReduction: opts.type,
      CustomerName: opts.customerName,
      AskedAmount: opts.amount,
    };
    if (opts.property) params.PropertyDesignation = opts.property;
    if (
      !(await confirmMutation(
        `Create ${opts.type.toUpperCase()} tax reduction for ref ${opts.reference}`,
        opts,
        { TaxReduction: params },
      ))
    ) {
      return;
    }
    const data = await createTaxReduction(params);
    outputDetail(data as Record<string, unknown>, taxReductionDetailColumns, json());
  });

// --- price lists ---
const pricelists = program.command('pricelists').description('Price list operations');

pricelists
  .command('list')
  .description('List price lists')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listPriceLists } = await import('./operations/pricelists.js');
    const data = await listPriceLists({
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      PriceLists: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.PriceLists ?? [],
      priceListListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

pricelists
  .command('get <code>')
  .description('Get a single price list')
  .action(async (code: string) => {
    const { getPriceList } = await import('./operations/pricelists.js');
    const data = await getPriceList(code);
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json());
  });

pricelists
  .command('create')
  .description('Create a price list')
  .requiredOption('--code <code>', 'Price list code')
  .requiredOption('--description <text>', 'Description')
  .option('--input <file>', 'Price list data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createPriceList } = await import('./operations/pricelists.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      Code: opts.code,
      Description: opts.description,
    };
    if (!(await confirmMutation(`Create price list "${opts.code}"`, opts, { PriceList: params }))) {
      return;
    }
    const data = await createPriceList(params);
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json());
  });

pricelists
  .command('update <code>')
  .description('Update a price list')
  .requiredOption('--input <file>', 'Price list data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (code: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
    const { updatePriceList } = await import('./operations/pricelists.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation(`Update price list ${code}`, opts, { PriceList: fields }))) {
      return;
    }
    const data = await updatePriceList(code, fields);
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json());
  });

// --- prices ---
const prices = program.command('prices').description('Price operations within price lists');

prices
  .command('list')
  .description('List prices in a price list')
  .requiredOption('--pricelist <code>', 'Price list code')
  .option('--article <number>', 'Filter by article number')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .action(async (opts) => {
    const { listPrices } = await import('./operations/pricelists.js');
    const data = await listPrices({
      priceListCode: opts.pricelist,
      articleNumber: opts.article,
      page: opts.page,
      limit: opts.limit,
    });
    const envelope = data as unknown as {
      Prices: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(envelope.Prices ?? [], priceListColumns, json(), data, envelope.MetaInformation);
  });

prices
  .command('get')
  .description('Get a specific price')
  .requiredOption('--pricelist <code>', 'Price list code')
  .requiredOption('--article <number>', 'Article number')
  .option('--from-quantity <number>', 'From quantity (default 0)', parseInt)
  .action(async (opts) => {
    const { getPrice } = await import('./operations/pricelists.js');
    const data = await getPrice(opts.pricelist, opts.article, opts.fromQuantity);
    outputDetail(data as Record<string, unknown>, priceDetailColumns, json());
  });

prices
  .command('update')
  .description('Update a price')
  .requiredOption('--pricelist <code>', 'Price list code')
  .requiredOption('--article <number>', 'Article number')
  .option('--from-quantity <number>', 'From quantity (default 0)', parseInt)
  .requiredOption('--input <file>', 'Price data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { updatePrice } = await import('./operations/pricelists.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    if (
      !(await confirmMutation(`Update price ${opts.pricelist}/${opts.article}`, opts, {
        Price: fields,
      }))
    ) {
      return;
    }
    const data = await updatePrice(opts.pricelist, opts.article, fields, opts.fromQuantity);
    outputDetail(data as Record<string, unknown>, priceDetailColumns, json());
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
