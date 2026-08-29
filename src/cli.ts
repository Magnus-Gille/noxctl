#!/usr/bin/env node

import { Command, Option } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  isJsonMode,
  outputList,
  outputDetail,
  outputConfirmation,
  formatTaxReport,
  formatFinancialReport,
  errorEnvelope,
} from './formatter.js';
import {
  readActivePointer,
  readActivePointerOutcome,
  writeActivePointer,
  deleteActivePointer,
  readProfileIndex,
  resolveProfile,
  type ResolvedProfile,
} from './profiles.js';
import { setResolvedProfile } from './auth.js';
import { applyPeriod } from './date-periods.js';
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
  financialYearListColumns,
  financialYearDetailColumns,
  lockedPeriodDetailColumns,
  contractListColumns,
  contractDetailColumns,
  recurringListColumns,
  recurringDetailColumns,
  invoiceRequestListColumns,
  invoiceRequestDetailColumns,
  topCustomerColumns,
  monthlyRevenueColumns,
  voucherAttachmentColumns,
  employeeListColumns,
  employeeDetailColumns,
  salaryTransactionListColumns,
  salaryTransactionDetailColumns,
  attendanceTransactionListColumns,
  attendanceTransactionDetailColumns,
  absenceTransactionListColumns,
  absenceTransactionDetailColumns,
  scheduleTimeDetailColumns,
} from './views.js';

const program = new Command();

// A closed downstream pipe (`noxctl ... | head`, or a reader that exits early)
// makes stdout emit EPIPE. That is normal for a CLI, and without this listener
// Node reports it as an uncaught exception with a stack trace, bypassing the
// command's own error handling.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

program
  .name('noxctl')
  .description('CLI and MCP server for Fortnox accounting')
  .version('0.7.4')
  .addOption(
    new Option('-o, --output <format>', 'Output format (default: table on TTY, json when piped)')
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

// Suppress Commander's own plain-text usage errors (unknown command, missing
// required option, ...) when in JSON mode, so the top-level catch can emit a
// structured error envelope instead of leaving non-JSON on stderr. In table
// mode, keep Commander's friendly usage message.
//
// Both configureOutput and exitOverride must be set HERE, before the command
// tree is built: Commander only copies these settings into subcommands created
// *after* they're configured on the parent. Set at the bottom, a subcommand's
// parse error would call process.exit() directly and bypass the catch below
// (leaving JSON-mode failures with no envelope).
program.configureOutput({
  outputError: (str, write) => {
    if (!json()) write(str);
  },
});
program.exitOverride();

// Emit a fatal error honoring -o json mode (structured envelope to stderr) vs
// plain text, then exit. Validation failures inside command actions must go
// through this so they don't bypass the JSON error contract the way a bare
// console.error would. The top-level catch handles thrown errors the same way;
// this is for the cases where we want a specific non-1 exit code.
function fail(message: string, exitCode = 1): never {
  if (json()) {
    console.error(JSON.stringify(errorEnvelope(new Error(message)), null, 2));
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

function fromToParams(opts: { period?: string; from?: string; to?: string }): {
  fromDate?: string;
  toDate?: string;
} {
  const { from, to } = applyPeriod(opts);
  return { fromDate: from, toDate: to };
}

let resolvedProfileInfo: ResolvedProfile = { name: DEFAULT_PROFILE, source: 'default' };

export function getResolvedProfileInfo(): ResolvedProfile {
  return resolvedProfileInfo;
}

// Commands that don't need (and shouldn't require) a resolved profile.
const PROFILE_RESOLUTION_SKIP = new Set(['help', 'completion']);

program.hook('preAction', async (thisCommand, actionCommand) => {
  const name = actionCommand.name();
  if (PROFILE_RESOLUTION_SKIP.has(name)) return;

  const flag = (program.opts().profile as string | undefined) ?? undefined;
  const env = process.env['NOXCTL_PROFILE'] ?? undefined;

  // Typed pointer resolution so we can distinguish "no pointer" (silent
  // default) from "pointer unreadable/corrupt" (must surface). 2s bound
  // catches wedged filesystems; the AbortSignal cancels the underlying read.
  const outcome = await readActivePointerOutcome({ timeoutMs: 2000 });
  let pointer: string | null = null;

  if (outcome.kind === 'valid') {
    pointer = outcome.name;
  } else if (outcome.kind !== 'missing') {
    const desc = describePointerFault(outcome);
    // Only fail closed when the pointer is the winning source (no flag/env)
    // AND we're about to start the MCP server. For any other command, warn
    // loudly but continue so `doctor` / `profile use` can repair the state.
    const wouldRelyOnPointer = !flag && !env;
    if (wouldRelyOnPointer && name === 'serve') {
      fail(
        `Active profile pointer ${desc}. Refusing to start MCP server with ambiguous profile. Run \`noxctl doctor\` or set NOXCTL_PROFILE explicitly.`,
        2,
      );
    }
    process.stderr.write(`[warning: active-profile pointer ${desc}; ignoring]\n`);
  }

  try {
    resolvedProfileInfo = resolveProfile({ flag, env, pointer });
  } catch (err) {
    if (err instanceof InvalidProfileNameError) {
      fail(err.message, 2);
    }
    throw err;
  }

  setResolvedProfile(resolvedProfileInfo.name, resolvedProfileInfo.source);

  // Banner ownership: MCP `serve` prints its own banner in bindStartupProfile
  // so host logs (Claude Desktop) always see it. Suppress here to avoid a
  // duplicate on TTY invocations like `noxctl --profile X serve`.
  if (
    resolvedProfileInfo.name.toLowerCase() !== DEFAULT_PROFILE &&
    process.stderr.isTTY &&
    name !== 'current' &&
    name !== 'serve'
  ) {
    process.stderr.write(`[profile: ${resolvedProfileInfo.name}]\n`);
  }
});

function describePointerFault(
  outcome:
    | { kind: 'invalid-content'; raw: string }
    | { kind: 'read-error'; error: Error }
    | { kind: 'timeout' },
): string {
  switch (outcome.kind) {
    case 'invalid-content':
      return `contains an invalid profile name: "${outcome.raw}"`;
    case 'read-error':
      return `could not be read (${outcome.error.message})`;
    case 'timeout':
      return 'read timed out';
  }
}

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

  // Show what will actually be sent so the user can verify before confirming.
  if (payload !== undefined) {
    console.log('Request payload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log();
  }

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

function requireDarwin(): void {
  if (process.platform !== 'darwin') {
    fail('The dedicated YubiKey-locked keychain is a macOS-only feature.', 2);
  }
}

// Confirmation for local, irreversible operations (not Fortnox mutations).
async function localConfirm(question: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Confirmation required. Re-run with --yes.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
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
  .option(
    '--with-salary',
    'Also request the Lön (salary/payroll) scope — requires the Lön permission enabled on your Fortnox app',
  )
  .option(
    '--with-orders',
    'Also request the offer/order scopes — requires the Order licence on the Fortnox company',
  )
  .action(async (initOpts: { profile?: string; withSalary?: boolean; withOrders?: boolean }) => {
    const { inspectCredentials, runOAuthSetup, SCOPES, SALARY_SCOPE, ORDER_SCOPES } =
      await import('./auth.js');
    const { validateProfileName } = await import('./profile-name.js');

    // Opt-in scopes: flag for TTY, env var for non-interactive/CI runs. Both are
    // licence-gated in Fortnox (Lön / Order), and asking for a scope the company
    // is not licensed for fails the whole authorization — hence not defaults.
    const withSalary = Boolean(initOpts.withSalary) || process.env.FORTNOX_WITH_SALARY === '1';
    const withOrders = Boolean(initOpts.withOrders) || process.env.FORTNOX_WITH_ORDERS === '1';
    const scopes = [SCOPES, withOrders ? ORDER_SCOPES : '', withSalary ? SALARY_SCOPE : '']
      .filter(Boolean)
      .join(' ');

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
      setResolvedProfile(targetProfile, 'flag');
      resolvedProfileInfo = { name: targetProfile, source: 'flag' };
    }

    // Step 1: Check if already configured
    const inspection = await inspectCredentials(targetProfile);
    if (inspection.state === 'locked' || inspection.state === 'inaccessible') {
      fail(inspection.detail);
    }
    const existing = inspection.credentials;
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
    // Printed from the SCOPES constant itself. A hand-maintained list drifted
    // from what noxctl actually requests, so following the docs produced an
    // under-scoped Fortnox app and a confusing rejection at authorize time (#95).
    console.log('  - Permissions (Behörigheter) for every one of these scopes:');
    console.log(`      ${scopes.split(' ').join(', ')}`);
    if (withOrders) {
      console.log('    (offer/order are included because you passed --with-orders)');
    }
    if (withSalary) {
      console.log('    (salary is included because you passed --with-salary)');
    }
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
    await runOAuthSetup({ clientId, clientSecret, serviceAccount }, targetProfile, scopes);

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

    const { inspectCredentials } = await import('./auth.js');
    const inspection = await inspectCredentials(validated);
    if (inspection.state === 'locked' || inspection.state === 'inaccessible') {
      fail(inspection.detail);
    }
    if (inspection.state === 'missing') {
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
    const { inspectCredentials } = await import('./auth.js');
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

    // 2a. Dedicated YubiKey-locked keychain (macOS only)
    if (process.platform === 'darwin') {
      const kt = await import('./keychain-target.js');
      const activePath = kt.activeKeychainPath();
      if (activePath) {
        const state = kt.keychainLockState(activePath);
        if (state === 'locked') {
          fail('Dedicated keychain', 'locked — run `noxctl keychain unlock` (tap your YubiKey)');
        } else if (state === 'missing') {
          fail(
            'Dedicated keychain',
            `configured but inaccessible at ${activePath} — inspect it from an unsandboxed terminal`,
          );
        } else {
          pass('Dedicated keychain', `active, ${state} (${activePath})`);
        }
        pass('ykman', kt.ykmanAvailable() ? 'installed' : 'not installed (brew install ykman)');
      } else {
        pass('Dedicated keychain', 'not enabled (using login keychain)');
      }
    }

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

    // 3. Credential state
    const inspection = await inspectCredentials();
    if (inspection.state === 'locked' || inspection.state === 'inaccessible') {
      fail('Credentials', `${inspection.state} — ${inspection.detail}`);
      console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
      return;
    }
    if (inspection.state === 'missing') {
      fail(
        'Credentials',
        `missing — not found for profile "${resolvedProfileInfo.name}" — run \`noxctl init${
          resolvedProfileInfo.name === DEFAULT_PROFILE
            ? ''
            : ` --profile ${resolvedProfileInfo.name}`
        }\` to set up`,
      );
      console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
      return;
    }
    const creds = inspection.credentials!;
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
    const { effectiveScopes } = await import('./auth.js');
    const { fortnoxRequest, FortnoxApiError } = await import('./fortnox-client.js');

    const { scopeProbeEndpoints } = await import('./scope-probes.js');

    const required = effectiveScopes(creds).split(' ');
    const missing: string[] = [];
    const unchecked: string[] = [];

    for (const scope of required) {
      const endpoint = scopeProbeEndpoints[scope];
      // Report rather than skip: counting an unprobed scope as authorized is
      // how doctor used to claim a clean bill of health it had not verified.
      if (!endpoint) {
        unchecked.push(scope);
        continue;
      }
      try {
        await fortnoxRequest(endpoint);
      } catch (err) {
        // A missing scope shows up as a 403, OR (for some endpoints, e.g. the
        // archive/inbox family) a 400 whose message names the scope. Treat both
        // as "not authorized"; other errors (500, etc.) aren't scope problems.
        if (
          err instanceof FortnoxApiError &&
          (err.statusCode === 403 || /scope/i.test(err.fortnoxMessage ?? ''))
        ) {
          missing.push(scope);
        }
      }
    }

    if (missing.length === 0) {
      const checked = required.length - unchecked.length;
      pass(
        'Scopes',
        unchecked.length === 0
          ? `all ${checked} scopes authorized`
          : `${checked} scopes authorized; not checked: ${unchecked.join(', ')}`,
      );
    } else {
      fail(
        'Scopes',
        `missing: ${missing.join(', ')}. Enable them in your Fortnox app at developer.fortnox.se`,
      );
    }

    console.log(`\n${ok ? 'All checks passed.' : 'Some checks failed.'}`);
  });

// --- keychain (dedicated YubiKey-locked credential store, macOS only) ---
const keychain = program
  .command('keychain')
  .description('Manage the dedicated YubiKey-locked credential keychain (macOS)');

keychain
  .command('status')
  .description('Show dedicated-keychain mode, lock state, and YubiKey availability')
  .action(async () => {
    const kt = await import('./keychain-target.js');
    const onDarwin = process.platform === 'darwin';

    console.log('Keychain status\n');
    console.log(
      `  Platform          ${process.platform}${onDarwin ? '' : ' (dedicated keychain is macOS-only)'}`,
    );

    const { inspectCredentials } = await import('./auth.js');
    const inspection = await inspectCredentials();
    console.log(
      `  Credential state  ${inspection.state} — profile "${inspection.profile}" (source: ${inspection.source})`,
    );
    if (inspection.state === 'locked' || inspection.state === 'inaccessible') {
      console.log(`\n  ${inspection.detail}`);
    }

    if (!onDarwin) return;

    const activePath = kt.activeKeychainPath();
    const kcPath = activePath ?? kt.dedicatedKeychainPath();
    const lockState = kt.keychainLockState(kcPath);

    console.log(`  Dedicated mode    ${activePath ? 'active' : 'inactive (using login keychain)'}`);
    console.log(`  Keychain file     ${kcPath} (${lockState})`);
    console.log(
      `  Challenge file    ${kt.readChallenge() ? kt.challengeFilePath() : 'not present'}`,
    );
    console.log(`  ykman installed   ${kt.ykmanAvailable() ? 'yes' : 'no (brew install ykman)'}`);
    console.log(`  YubiKey present   ${kt.yubikeyPresent() ? 'yes' : 'no'}`);
    const enrolledSerial = kt.readEnrolledSerial();
    console.log(`  Enrolled serial   ${enrolledSerial ?? 'not recorded'}`);
    if (enrolledSerial) {
      const mismatch = kt.diagnoseSerialMismatch(enrolledSerial, kt.listYubikeySerials());
      if (mismatch) console.log(`\n  ${mismatch}`);
    }

    if (activePath && lockState === 'locked') {
      console.log('\n  Locked — run `noxctl keychain unlock` (tap your YubiKey).');
    }
  });

keychain
  .command('unlock')
  .description('Unlock the dedicated keychain for this session (tap your YubiKey)')
  .action(async () => {
    requireDarwin();
    const kt = await import('./keychain-target.js');
    const activePath = kt.activeKeychainPath();
    const kcPath = activePath ?? kt.dedicatedKeychainPath();

    const state = kt.keychainLockState(kcPath);
    if (state === 'missing') {
      console.error(
        activePath
          ? `The configured keychain at ${kcPath} is inaccessible. Retry from an unsandboxed terminal; do not re-run noxctl keychain init.`
          : 'No dedicated keychain found. Run `noxctl keychain init` first.',
      );
      process.exit(1);
    }
    if (state === 'unlocked') {
      console.log('Keychain is already unlocked.');
      return;
    }
    const challenge = kt.readChallenge();
    if (!challenge) {
      console.error(
        'Challenge file missing — cannot derive the unlock password. Re-run `noxctl keychain init`.',
      );
      process.exit(1);
    }
    // Preflight: a wrong/absent key is diagnosable from serials alone, before
    // burning a tap on a challenge that can only fail.
    const mismatch = kt.diagnoseSerialMismatch(kt.readEnrolledSerial(), kt.listYubikeySerials());
    if (mismatch) {
      console.error(mismatch);
      process.exit(1);
    }
    console.log('Tap your YubiKey when it blinks...');
    let password: string;
    try {
      password = kt.computeChallengeResponse(challenge);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    try {
      kt.unlockDedicatedKeychain(kcPath, password);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    console.log('Keychain unlocked — open until your Mac sleeps.');
  });

keychain
  .command('lock')
  .description('Lock the dedicated keychain now')
  .action(async () => {
    requireDarwin();
    const kt = await import('./keychain-target.js');
    const activePath = kt.activeKeychainPath();
    const kcPath = activePath ?? kt.dedicatedKeychainPath();
    if (kt.keychainLockState(kcPath) === 'missing') {
      console.error(
        activePath
          ? `The configured keychain at ${kcPath} is inaccessible. Retry from an unsandboxed terminal.`
          : 'No dedicated keychain found.',
      );
      process.exit(1);
    }
    kt.lockKeychain(kcPath);
    console.log('Keychain locked.');
  });

keychain
  .command('init')
  .description('Create the YubiKey-locked keychain and copy in existing credentials')
  .action(async () => {
    requireDarwin();
    const kt = await import('./keychain-target.js');

    if (!kt.ykmanAvailable()) {
      console.error('ykman not found — install it with `brew install ykman`, then re-run.');
      process.exit(1);
    }
    if (!kt.yubikeyPresent()) {
      console.error('No YubiKey detected — insert it and re-run.');
      process.exit(1);
    }

    const kcPath = kt.dedicatedKeychainPath();
    if (kt.readChallenge()) {
      console.error(
        'Already initialized. Use `noxctl keychain unlock` or `noxctl keychain status`.',
      );
      process.exit(1);
    }
    if (kt.keychainLockState(kcPath) !== 'missing') {
      console.error(
        `A keychain already exists at ${kcPath} but no challenge file is present.\n` +
          `Remove the stale keychain (\`security delete-keychain "${kcPath}"\`) and re-run.`,
      );
      process.exit(1);
    }

    console.log('This creates a dedicated, lock-on-sleep keychain whose password is derived');
    console.log('from your YubiKey (OTP slot 2 challenge-response). You unlock it once per');
    console.log('session with a tap. Existing credentials are copied in; the login-keychain');
    console.log('originals are left in place (run `noxctl keychain seal` to remove them later).');
    console.log('');
    console.log('Slot 2 must already be programmed: `ykman otp chalresp --generate --touch 2`.');
    console.log('');

    // Collect existing credentials from the LOGIN keychain BEFORE activating
    // dedicated mode (challenge file absent -> activeKeychainPath() is null).
    const { readProfileIndex } = await import('./profiles.js');
    const { loadCredentialBlob, saveCredentialBlob } = await import('./credentials-store.js');

    const idx = await readProfileIndex();
    const names = new Set<string>([DEFAULT_PROFILE, ...idx.profiles.map((p) => p.name)]);
    const blobs: { profile: string; blob: string }[] = [];
    for (const name of names) {
      const { blob } = await loadCredentialBlob(name);
      if (blob) blobs.push({ profile: name, blob });
    }
    console.log(
      `Found ${blobs.length} credential set(s) to copy: ${
        blobs.map((b) => b.profile).join(', ') || '(none)'
      }`,
    );
    console.log('');

    // Derive the keychain password from the YubiKey (requires a tap). Done
    // before creating the keychain so a missed tap leaves nothing behind.
    const challenge = kt.generateChallenge();
    console.log('Tap your YubiKey when it blinks...');
    let password: string;
    try {
      password = kt.computeChallengeResponse(challenge);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const created = kt.createDedicatedKeychain(kcPath, password);
    if (created === 'exists') {
      console.error(`Unexpected: keychain already exists at ${kcPath}. Aborting.`);
      process.exit(1);
    }
    kt.setLockOnSleep(kcPath);

    // Activate dedicated mode: now activeKeychainPath() resolves to kcPath and
    // saveCredentialBlob targets the new (still-unlocked) keychain.
    kt.writeChallenge(challenge);

    // Remember which physical key answered the enrollment challenge so unlock
    // can distinguish "wrong key inserted" from "missed tap" later.
    const serials = kt.listYubikeySerials();
    if (serials.length === 1) {
      kt.writeEnrolledSerial(serials[0]);
      console.log(`Enrolled against YubiKey serial ${serials[0]}.`);
    } else if (serials.length > 1) {
      console.log(
        `Multiple YubiKeys present (${serials.join(', ')}) — not recording an enrolled serial.`,
      );
    }

    let copied = 0;
    for (const { profile, blob } of blobs) {
      try {
        await saveCredentialBlob(blob, profile);
        copied++;
      } catch (err) {
        console.error(
          `  ! failed to copy "${profile}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log('');
    console.log(`Done. Created ${kcPath}, copied ${copied}/${blobs.length} credential set(s).`);
    console.log('The keychain is unlocked now and will lock when your Mac sleeps.');
    console.log('Next session: `noxctl keychain unlock` (one tap).');
    console.log('When you trust it: `noxctl keychain seal` to delete the login-keychain copies.');
  });

keychain
  .command('seal')
  .description('Delete the login-keychain credential copies left by `init` (irreversible)')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (opts: { yes?: boolean }) => {
    requireDarwin();
    const kt = await import('./keychain-target.js');

    const activePath = kt.activeKeychainPath();
    if (!activePath) {
      console.error(
        'Dedicated keychain mode is not active — nothing to seal. Run `noxctl keychain init` first.',
      );
      process.exit(1);
    }
    if (kt.keychainLockState(activePath) === 'locked') {
      console.error(
        'Dedicated keychain is locked — run `noxctl keychain unlock` first so the copies can be verified before the originals are deleted.',
      );
      process.exit(1);
    }

    const { readProfileIndex } = await import('./profiles.js');
    const { LEGACY_KEYCHAIN_ACCOUNT, keychainAccount } = await import('./profile-name.js');
    const { loadCredentialBlob } = await import('./credentials-store.js');

    const idx = await readProfileIndex();
    const uniqueNames = [
      ...new Set([DEFAULT_PROFILE, ...idx.profiles.map((p) => p.name)].map((n) => n.toLowerCase())),
    ];

    // Verify the dedicated keychain actually holds each profile's creds before
    // deleting the login originals — never strand the user with no copy.
    const verified: string[] = [];
    for (const name of uniqueNames) {
      const { blob } = await loadCredentialBlob(name);
      if (blob) verified.push(name);
    }
    if (verified.length === 0) {
      console.error(
        'The dedicated keychain holds no credentials — refusing to delete the login copies.',
      );
      process.exit(1);
    }

    console.log(
      `Verified ${verified.length} credential set(s) in the dedicated keychain: ${verified.join(', ')}`,
    );
    const confirmed = await localConfirm(
      'Delete the login-keychain copies now? This cannot be undone.',
      opts.yes,
    );
    if (!confirmed) {
      console.log('Aborted. Login-keychain copies left in place.');
      return;
    }

    // Accounts init may have written to the login keychain: the legacy
    // "default" account plus profile:<name> for every known profile.
    const accounts = new Set<string>([LEGACY_KEYCHAIN_ACCOUNT]);
    for (const name of uniqueNames) accounts.add(keychainAccount(name));

    let deleted = 0;
    for (const account of accounts) {
      if (kt.deleteLoginSecret(account)) deleted++;
    }
    console.log(`Deleted ${deleted} login-keychain entr${deleted === 1 ? 'y' : 'ies'}.`);
    console.log('Credentials now live only in the YubiKey-locked keychain.');
  });

// --- serve (default command) ---
program
  .command('serve', { isDefault: true })
  .description('Start the MCP server (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('./index.js');
    await startMcpServer({ profile: resolvedProfileInfo.name });
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
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listInvoices } = await import('./operations/invoices.js');
    const data = await listInvoices({
      filter: opts.filter,
      customerNumber: opts.customer,
      ...fromToParams(opts),
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
    outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json(), 'Invoice');
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
    outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json(), 'Invoice');
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
      outputDetail(data as Record<string, unknown>, invoiceDetailColumns, json(), 'Invoice');
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
        'Invoice',
      );
    },
  );

invoices
  .command('pdf <documentNumber>')
  .description('Download an invoice as a PDF')
  // Note: -o/--output is already taken globally for the output *format*
  // (json|table), so the destination path is --file.
  .option('-f, --file <path>', 'Write the PDF here (- for stdout)')
  .option('--mark-sent', 'Also flag the invoice as sent in Fortnox (uses /print)')
  .option('-y, --yes', 'Skip confirmation prompt (only needed with --mark-sent)')
  .option('--dry-run', 'Preview the action without sending it')
  .addHelpText(
    'after',
    `
The PDF always comes from Fortnox's /preview endpoint, which does not change the
invoice. --mark-sent additionally calls /print afterwards to set Sent=true — the
file is written first, so a failed write never leaves an invoice flagged as sent
with no PDF to show for it.

Without --file the PDF is written to invoice-<documentNumber>.pdf in the current
directory.

When writing to a file, --mark-sent replaces it with the document /print itself
returned, so the saved copy matches the version that was marked. Streaming to
stdout cannot do that — bytes already written cannot be recalled — so with
--file - the streamed document is the /preview render.

Examples:
  noxctl invoices pdf 28
  noxctl invoices pdf 28 --file ~/Desktop/faktura-28.pdf
  noxctl invoices pdf 28 --file - > faktura.pdf
  noxctl invoices pdf 28 --mark-sent --yes`,
  )
  .action(
    async (
      documentNumber: string,
      opts: { file?: string; markSent?: boolean; yes?: boolean; dryRun?: boolean },
    ) => {
      const { getInvoicePdf, markInvoicePrinted } = await import('./operations/invoices.js');
      const toStdout = opts.file === '-';

      // Only an *explicit* --output json conflicts here. json() alone is not the
      // test: it defaults to true whenever stdout is piped, which is exactly how
      // `--file -` is meant to be used.
      if (toStdout && program.opts().output === 'json') {
        throw new Error(
          '--file - writes raw PDF bytes to stdout and cannot be combined with --output json.',
        );
      }

      // Only --mark-sent mutates the invoice; a plain download needs no confirmation.
      if (opts.markSent || opts.dryRun) {
        const action = opts.markSent
          ? `Download invoice ${documentNumber} as PDF and flag it as sent`
          : `Download invoice ${documentNumber} as PDF`;
        if (!(await confirmMutation(action, opts))) {
          return;
        }
      }

      const pdf = await getInvoicePdf(documentNumber);

      if (toStdout) {
        // Wait for the bytes to be flushed before mutating anything: a closed or
        // broken pipe must not leave the invoice marked as sent.
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(pdf, (err) => (err ? reject(err) : resolve()));
        });
        if (opts.markSent) await markInvoicePrinted(documentNumber);
        return;
      }

      const path = opts.file ?? `invoice-${documentNumber}.pdf`;
      writeFileSync(path, pdf);

      // Only now that the PDF is safely on disk do we change Fortnox. If that
      // fails, the download still succeeded — say so, or the user is left
      // thinking the whole command achieved nothing.
      let printed;
      if (opts.markSent) {
        try {
          printed = await markInvoicePrinted(documentNumber);
        } catch (err) {
          throw new Error(
            `Invoice ${documentNumber} saved to ${path} (${pdf.length} bytes), but marking it as sent failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Prefer the document /print actually produced, so the saved copy matches
      // the version that was marked as sent. Best-effort: the /preview copy is
      // already written and the invoice is already flagged, so a failure here is
      // reported as a note rather than raised as a failed operation.
      let bytes = pdf.length;
      let note = '';
      if (printed?.pdf) {
        try {
          writeFileSync(path, printed.pdf);
          bytes = printed.pdf.length;
        } catch (err) {
          note += ` Saved file is the /preview copy; rewriting it with the printed version failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      // Only claim the invoice is sent if Fortnox actually said so.
      if (printed && !printed.confirmed) {
        note += ` ${String(printed.invoice.Note)}`;
      } else if (printed && printed.invoice.Sent === true) {
        note += ' Marked as sent.';
      } else if (printed) {
        note += ' Warning: Fortnox still reports this invoice as not sent.';
      }

      outputConfirmation(
        `Invoice ${documentNumber} saved to ${path} (${bytes} bytes).${note}`,
        json(),
        {
          DocumentNumber: documentNumber,
          Path: path,
          Bytes: bytes,
          // Report what Fortnox says the invoice's state is, not what we asked
          // for; undefined means "not checked" or "could not be confirmed".
          Sent: printed?.confirmed ? printed.invoice.Sent : undefined,
        },
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
    outputConfirmation(
      `Invoice ${documentNumber} bookkeept.`,
      json(),
      data,
      invoiceConfirmColumns,
      'Invoice',
    );
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
    outputConfirmation(
      `Invoice ${documentNumber} credited.`,
      json(),
      data,
      invoiceConfirmColumns,
      'Invoice',
    );
  });

// --- tax ---
const tax = program.command('tax').description('Tax operations');

tax
  .command('report')
  .description('Generate VAT tax report for a period')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--year <number>', 'Financial year', parseInt)
  .action(async (opts) => {
    const { generateTaxReport } = await import('./operations/tax.js');
    const range = fromToParams(opts);
    if (!range.fromDate || !range.toDate) {
      fail('tax report requires a period: --from/--to or --period.', 2);
    }
    const data = await generateTaxReport({
      fromDate: range.fromDate,
      toDate: range.toDate,
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
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .action(async (opts) => {
    const { getIncomeStatement } = await import('./operations/financial-reports.js');
    const data = await getIncomeStatement({
      financialYear: opts.year,
      ...fromToParams(opts),
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
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json(), 'Customer');
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
    outputDetail(data as Record<string, unknown>, customerDetailColumns, json(), 'Customer');
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
      outputDetail(data as Record<string, unknown>, customerDetailColumns, json(), 'Customer');
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
    outputDetail(data as Record<string, unknown>, articleDetailColumns, json(), 'Article');
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
    outputDetail(data as Record<string, unknown>, articleDetailColumns, json(), 'Article');
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
      outputDetail(data as Record<string, unknown>, articleDetailColumns, json(), 'Article');
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
    outputDetail(data as Record<string, unknown>, supplierDetailColumns, json(), 'Supplier');
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
    outputDetail(data as Record<string, unknown>, supplierDetailColumns, json(), 'Supplier');
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
      outputDetail(data as Record<string, unknown>, supplierDetailColumns, json(), 'Supplier');
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
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listSupplierInvoices } = await import('./operations/supplier-invoices.js');
    const data = await listSupplierInvoices({
      filter: opts.filter,
      supplierNumber: opts.supplier,
      ...fromToParams(opts),
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
    outputDetail(
      data as Record<string, unknown>,
      supplierInvoiceDetailColumns,
      json(),
      'SupplierInvoice',
    );
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
    outputDetail(
      data as Record<string, unknown>,
      supplierInvoiceDetailColumns,
      json(),
      'SupplierInvoice',
    );
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
      'SupplierInvoice',
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
    outputDetail(
      data as Record<string, unknown>,
      companyDetailColumns,
      json(),
      'CompanyInformation',
    );
  });

// --- vouchers ---
const vouchers = program.command('vouchers').description('Voucher operations');

vouchers
  .command('list')
  .description('List vouchers')
  .option('--series <series>', 'Voucher series (e.g. "A")')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--year <number>', 'Financial year', parseInt)
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listVouchers } = await import('./operations/vouchers.js');
    const data = await listVouchers({
      series: opts.series,
      ...fromToParams(opts),
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
      console.log(JSON.stringify({ Voucher: data }, null, 2));
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
    outputDetail(data as Record<string, unknown>, voucherDetailColumns, json(), 'Voucher');
  });

vouchers
  .command('attach <series> <number> <files...>')
  .description('Upload receipt/underlag files and link them to a voucher')
  .option('--year <number>', 'Financial year (resolved from the voucher date if omitted)', parseInt)
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview without uploading')
  .addHelpText(
    'after',
    `
Examples:
  noxctl vouchers attach A 60 receipt.pdf
  noxctl vouchers attach A 61 ica.pdf lunch.jpg --year 4`,
  )
  .action(
    async (
      series: string,
      voucherNumber: string,
      files: string[],
      opts: { year?: number; yes?: boolean; dryRun?: boolean },
    ) => {
      const { attachVoucherFiles } = await import('./operations/vouchers.js');
      if (
        !(await confirmMutation(
          `Attach ${files.length} file(s) to voucher ${series}/${voucherNumber}`,
          opts,
          { files, year: opts.year },
        ))
      ) {
        return;
      }
      const results = await attachVoucherFiles({
        series,
        voucherNumber,
        filePaths: files,
        financialYear: opts.year,
      });
      if (json()) {
        console.log(JSON.stringify({ Attachments: results }, null, 2));
      } else {
        outputList(
          results as unknown as Record<string, unknown>[],
          voucherAttachmentColumns,
          false,
          results,
        );
      }
    },
  );

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
    outputDetail(
      data as Record<string, unknown>,
      invoicePaymentDetailColumns,
      json(),
      'InvoicePayment',
    );
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
    outputDetail(
      data as Record<string, unknown>,
      invoicePaymentDetailColumns,
      json(),
      'InvoicePayment',
    );
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
    outputConfirmation(
      `Invoice payment ${paymentNumber} deleted.`,
      json(),
      { Number: paymentNumber, deleted: true },
      undefined,
      'InvoicePayment',
    );
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
    outputConfirmation(
      `Invoice payment ${paymentNumber} bookkeept.`,
      json(),
      result,
      undefined,
      'InvoicePayment',
    );
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
    outputDetail(
      data as Record<string, unknown>,
      supplierInvoicePaymentDetailColumns,
      json(),
      'SupplierInvoicePayment',
    );
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
    outputDetail(
      data as Record<string, unknown>,
      supplierInvoicePaymentDetailColumns,
      json(),
      'SupplierInvoicePayment',
    );
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
    outputConfirmation(
      `Supplier invoice payment ${paymentNumber} deleted.`,
      json(),
      { Number: paymentNumber, deleted: true },
      undefined,
      'SupplierInvoicePayment',
    );
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
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listOffers } = await import('./operations/offers.js');
    const data = await listOffers({
      filter: opts.filter,
      customerNumber: opts.customer,
      ...fromToParams(opts),
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
    outputDetail(data as Record<string, unknown>, offerDetailColumns, json(), 'Offer');
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
    outputDetail(data as Record<string, unknown>, offerDetailColumns, json(), 'Offer');
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
      outputDetail(data as Record<string, unknown>, offerDetailColumns, json(), 'Offer');
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
      'Invoice',
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
    outputConfirmation(
      `Order created from offer ${documentNumber}.`,
      json(),
      data,
      undefined,
      'Order',
    );
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
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, this-quarter, last-quarter, this-month, last-month, ytd, this-year, last-year, or a bare year. Mutually exclusive with --from/--to.',
  )
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listOrders } = await import('./operations/orders.js');
    const data = await listOrders({
      filter: opts.filter,
      customerNumber: opts.customer,
      ...fromToParams(opts),
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
    outputDetail(data as Record<string, unknown>, orderDetailColumns, json(), 'Order');
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
    outputDetail(data as Record<string, unknown>, orderDetailColumns, json(), 'Order');
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
      outputDetail(data as Record<string, unknown>, orderDetailColumns, json(), 'Order');
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
      'Invoice',
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
    outputDetail(data as Record<string, unknown>, projectDetailColumns, json(), 'Project');
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
    outputDetail(data as Record<string, unknown>, projectDetailColumns, json(), 'Project');
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
      outputDetail(data as Record<string, unknown>, projectDetailColumns, json(), 'Project');
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
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json(), 'CostCenter');
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
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json(), 'CostCenter');
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
    outputDetail(data as Record<string, unknown>, costCenterDetailColumns, json(), 'CostCenter');
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
    outputConfirmation(
      `Cost center ${code} deleted.`,
      json(),
      { Code: code, deleted: true },
      undefined,
      'CostCenter',
    );
  });

// --- employees (payroll / Lön) ---
const employees = program
  .command('employees')
  .description('Employee operations (requires the Lön scope — see `noxctl init --with-salary`)');

employees
  .command('list')
  .description('List employees')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listEmployees } = await import('./operations/employees.js');
    const data = await listEmployees({
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      Employees: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.Employees ?? [],
      employeeListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

employees
  .command('get <employeeId>')
  .description('Get a single employee')
  .action(async (employeeId: string) => {
    const { getEmployee } = await import('./operations/employees.js');
    const data = await getEmployee(employeeId);
    outputDetail(data as Record<string, unknown>, employeeDetailColumns, json(), 'Employee');
  });

employees
  .command('create')
  .description(
    'Create an employee. Tip: set --employment-form, --personel-type and --salary-form, otherwise Fortnox cannot assign an employment agreement (företagsavtal).',
  )
  .requiredOption('--first-name <name>', 'First name')
  .requiredOption('--last-name <name>', 'Last name')
  .requiredOption('--email <email>', 'Email address')
  .option(
    '--employment-form <form>',
    'Employment form: TV, PRO, TID, SVT, VIK, PRJ, PRA, FER, SES, NEJ',
  )
  .option('--personel-type <type>', 'Personnel type: TJM (tjänsteman) or ARB (arbetare)')
  .option('--salary-form <form>', 'Salary form: MAN (monthly) or TIM (hourly)')
  .option('--employment-date <date>', 'Employment start date (YYYY-MM-DD)')
  .option('--monthly-salary <amount>', 'Monthly salary')
  .option('--hourly-pay <amount>', 'Hourly pay')
  .option('--input <file>', 'Additional employee data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createEmployee } = await import('./operations/employees.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      FirstName: opts.firstName,
      LastName: opts.lastName,
      Email: opts.email,
    };
    if (opts.employmentForm !== undefined) params.EmploymentForm = opts.employmentForm;
    if (opts.personelType !== undefined) params.PersonelType = opts.personelType;
    if (opts.salaryForm !== undefined) params.SalaryForm = opts.salaryForm;
    if (opts.employmentDate !== undefined) params.EmploymentDate = opts.employmentDate;
    if (opts.monthlySalary !== undefined) params.MonthlySalary = opts.monthlySalary;
    if (opts.hourlyPay !== undefined) params.HourlyPay = opts.hourlyPay;
    if (
      !(await confirmMutation(`Create employee "${opts.firstName} ${opts.lastName}"`, opts, {
        Employee: params,
      }))
    ) {
      return;
    }
    const data = await createEmployee(params);
    outputDetail(data as Record<string, unknown>, employeeDetailColumns, json(), 'Employee');
  });

employees
  .command('update <employeeId>')
  .description('Update an employee')
  .requiredOption('--input <file>', 'Employee data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (employeeId: string, opts: { input: string; yes?: boolean; dryRun?: boolean }) => {
    const { updateEmployee } = await import('./operations/employees.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation(`Update employee ${employeeId}`, opts, { Employee: fields }))) {
      return;
    }
    const data = await updateEmployee(employeeId, fields);
    outputDetail(data as Record<string, unknown>, employeeDetailColumns, json(), 'Employee');
  });

// --- salary transactions (Lön) ---
const salarytransactions = program
  .command('salary-transactions')
  .description('Salary transaction operations (requires the Lön scope)');

salarytransactions
  .command('list')
  .description('List salary transactions')
  .option('--employee <id>', 'Filter by employee ID')
  .option('--date <date>', 'Filter by date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listSalaryTransactions } = await import('./operations/salarytransactions.js');
    const data = await listSalaryTransactions({
      employeeId: opts.employee,
      date: opts.date,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      SalaryTransactions: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.SalaryTransactions ?? [],
      salaryTransactionListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

salarytransactions
  .command('get <salaryRow>')
  .description('Get a single salary transaction')
  .action(async (salaryRow: string) => {
    const { getSalaryTransaction } = await import('./operations/salarytransactions.js');
    const data = await getSalaryTransaction(salaryRow);
    outputDetail(
      data as Record<string, unknown>,
      salaryTransactionDetailColumns,
      json(),
      'SalaryTransaction',
    );
  });

salarytransactions
  .command('create')
  .description('Create a salary transaction')
  .requiredOption('--employee <id>', 'Employee ID')
  .requiredOption('--salary-code <code>', 'Salary code')
  .requiredOption('--date <date>', 'Date (YYYY-MM-DD)')
  .option('--amount <amount>', 'Amount')
  .option('--input <file>', 'Additional data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createSalaryTransaction } = await import('./operations/salarytransactions.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      EmployeeId: opts.employee,
      SalaryCode: opts.salaryCode,
      Date: opts.date,
    };
    if (opts.amount !== undefined) params.Amount = opts.amount;
    if (
      !(await confirmMutation(`Create salary transaction for employee ${opts.employee}`, opts, {
        SalaryTransaction: params,
      }))
    ) {
      return;
    }
    const data = await createSalaryTransaction(params);
    outputDetail(
      data as Record<string, unknown>,
      salaryTransactionDetailColumns,
      json(),
      'SalaryTransaction',
    );
  });

salarytransactions
  .command('delete <salaryRow>')
  .description('Delete a salary transaction')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (salaryRow: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteSalaryTransaction } = await import('./operations/salarytransactions.js');
    if (!(await confirmMutation(`Delete salary transaction ${salaryRow}`, opts))) {
      return;
    }
    await deleteSalaryTransaction(salaryRow);
    outputConfirmation(
      `Salary transaction ${salaryRow} deleted.`,
      json(),
      { SalaryRow: salaryRow, deleted: true },
      undefined,
      'SalaryTransaction',
    );
  });

// --- attendance transactions (närvaro / Lön) ---
const attendancetransactions = program
  .command('attendance-transactions')
  .description('Attendance transaction operations (requires the Lön scope)');

attendancetransactions
  .command('list')
  .description('List attendance transactions')
  .option('--employee <id>', 'Filter by employee ID')
  .option('--date <date>', 'Filter by date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listAttendanceTransactions } = await import('./operations/attendancetransactions.js');
    const data = await listAttendanceTransactions({
      employeeId: opts.employee,
      date: opts.date,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      AttendanceTransactions: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.AttendanceTransactions ?? [],
      attendanceTransactionListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

attendancetransactions
  .command('get <id>')
  .description('Get a single attendance transaction')
  .action(async (id: string) => {
    const { getAttendanceTransaction } = await import('./operations/attendancetransactions.js');
    const data = await getAttendanceTransaction(id);
    outputDetail(
      data as Record<string, unknown>,
      attendanceTransactionDetailColumns,
      json(),
      'AttendanceTransaction',
    );
  });

attendancetransactions
  .command('create')
  .description('Create an attendance transaction')
  .requiredOption('--employee <id>', 'Employee ID')
  .requiredOption('--cause-code <code>', 'Cause code (e.g. ARB, FLX, OT1)')
  .requiredOption('--date <date>', 'Date (YYYY-MM-DD)')
  .option('--hours <hours>', 'Hours')
  .option('--input <file>', 'Additional data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createAttendanceTransaction } = await import('./operations/attendancetransactions.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      EmployeeId: opts.employee,
      CauseCode: opts.causeCode,
      Date: opts.date,
    };
    if (opts.hours !== undefined) params.Hours = opts.hours;
    if (
      !(await confirmMutation(`Create attendance transaction for employee ${opts.employee}`, opts, {
        AttendanceTransaction: params,
      }))
    ) {
      return;
    }
    const data = await createAttendanceTransaction(params);
    outputDetail(
      data as Record<string, unknown>,
      attendanceTransactionDetailColumns,
      json(),
      'AttendanceTransaction',
    );
  });

attendancetransactions
  .command('delete <id>')
  .description('Delete an attendance transaction')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (id: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteAttendanceTransaction } = await import('./operations/attendancetransactions.js');
    if (!(await confirmMutation(`Delete attendance transaction ${id}`, opts))) {
      return;
    }
    await deleteAttendanceTransaction(id);
    outputConfirmation(
      `Attendance transaction ${id} deleted.`,
      json(),
      { id, deleted: true },
      undefined,
      'AttendanceTransaction',
    );
  });

// --- absence transactions (frånvaro / Lön) ---
const absencetransactions = program
  .command('absence-transactions')
  .description('Absence transaction operations (requires the Lön scope)');

absencetransactions
  .command('list')
  .description('List absence transactions')
  .option('--employee <id>', 'Filter by employee ID')
  .option('--date <date>', 'Filter by date (YYYY-MM-DD)')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listAbsenceTransactions } = await import('./operations/absencetransactions.js');
    const data = await listAbsenceTransactions({
      employeeId: opts.employee,
      date: opts.date,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    const envelope = data as unknown as {
      AbsenceTransactions: Record<string, unknown>[];
      MetaInformation?: Record<string, unknown>;
    };
    outputList(
      envelope.AbsenceTransactions ?? [],
      absenceTransactionListColumns,
      json(),
      data,
      envelope.MetaInformation,
    );
  });

absencetransactions
  .command('get <id>')
  .description('Get a single absence transaction')
  .action(async (id: string) => {
    const { getAbsenceTransaction } = await import('./operations/absencetransactions.js');
    const data = await getAbsenceTransaction(id);
    outputDetail(
      data as Record<string, unknown>,
      absenceTransactionDetailColumns,
      json(),
      'AbsenceTransaction',
    );
  });

absencetransactions
  .command('create')
  .description('Create an absence transaction')
  .requiredOption('--employee <id>', 'Employee ID')
  .requiredOption('--cause-code <code>', 'Cause code (e.g. SEM, SJK, VAB)')
  .requiredOption('--date <date>', 'Date (YYYY-MM-DD)')
  .option('--hours <hours>', 'Hours (number, e.g. 8)', parseFloat)
  .option('--extent <extent>', 'Extent / percentage absent (number, e.g. 50)', parseFloat)
  .option('--input <file>', 'Additional data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createAbsenceTransaction } = await import('./operations/absencetransactions.js');
    let input: Record<string, unknown> = {};
    if (opts.input) {
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      input = JSON.parse(raw) as Record<string, unknown>;
    }
    const params: Record<string, unknown> = {
      ...input,
      EmployeeId: opts.employee,
      CauseCode: opts.causeCode,
      Date: opts.date,
    };
    if (opts.hours !== undefined) params.Hours = opts.hours;
    if (opts.extent !== undefined) params.Extent = opts.extent;
    if (
      !(await confirmMutation(`Create absence transaction for employee ${opts.employee}`, opts, {
        AbsenceTransaction: params,
      }))
    ) {
      return;
    }
    const data = await createAbsenceTransaction(params);
    outputDetail(
      data as Record<string, unknown>,
      absenceTransactionDetailColumns,
      json(),
      'AbsenceTransaction',
    );
  });

absencetransactions
  .command('delete <id>')
  .description('Delete an absence transaction')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (id: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { deleteAbsenceTransaction } = await import('./operations/absencetransactions.js');
    if (!(await confirmMutation(`Delete absence transaction ${id}`, opts))) {
      return;
    }
    await deleteAbsenceTransaction(id);
    outputConfirmation(
      `Absence transaction ${id} deleted.`,
      json(),
      { id, deleted: true },
      undefined,
      'AbsenceTransaction',
    );
  });

// --- schedule times (schematider / Lön) ---
const scheduletimes = program
  .command('schedule-times')
  .description('Schedule time operations (requires the Lön scope)');

scheduletimes
  .command('get <employeeId> <date>')
  .description('Get the schedule for an employee on a date (YYYY-MM-DD)')
  .action(async (employeeId: string, date: string) => {
    const { getScheduleTime } = await import('./operations/scheduletimes.js');
    const data = await getScheduleTime(employeeId, date);
    outputDetail(
      data as Record<string, unknown>,
      scheduleTimeDetailColumns,
      json(),
      'ScheduleTime',
    );
  });

scheduletimes
  .command('update <employeeId> <date>')
  .description('Update the schedule for an employee on a date')
  .requiredOption('--input <file>', 'Schedule data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (
      employeeId: string,
      date: string,
      opts: { input: string; yes?: boolean; dryRun?: boolean },
    ) => {
      const { updateScheduleTime } = await import('./operations/scheduletimes.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (
        !(await confirmMutation(`Update schedule for ${employeeId} on ${date}`, opts, {
          ScheduleTime: fields,
        }))
      ) {
        return;
      }
      const data = await updateScheduleTime(employeeId, date, fields);
      outputDetail(
        data as Record<string, unknown>,
        scheduleTimeDetailColumns,
        json(),
        'ScheduleTime',
      );
    },
  );

scheduletimes
  .command('reset-day <employeeId> <date>')
  .description('Update the schedule and reset the day for an employee on a date')
  .requiredOption('--input <file>', 'Schedule data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(
    async (
      employeeId: string,
      date: string,
      opts: { input: string; yes?: boolean; dryRun?: boolean },
    ) => {
      const { resetScheduleTimeDay } = await import('./operations/scheduletimes.js');
      const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
      const fields = JSON.parse(raw) as Record<string, unknown>;
      if (
        !(await confirmMutation(`Reset schedule day for ${employeeId} on ${date}`, opts, {
          ScheduleTime: fields,
        }))
      ) {
        return;
      }
      const data = await resetScheduleTimeDay(employeeId, date, fields);
      outputDetail(
        data as Record<string, unknown>,
        scheduleTimeDetailColumns,
        json(),
        'ScheduleTime',
      );
    },
  );

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
    outputDetail(
      data as Record<string, unknown>,
      taxReductionDetailColumns,
      json(),
      'TaxReduction',
    );
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
    outputDetail(
      data as Record<string, unknown>,
      taxReductionDetailColumns,
      json(),
      'TaxReduction',
    );
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
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json(), 'PriceList');
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
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json(), 'PriceList');
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
    outputDetail(data as Record<string, unknown>, priceListDetailColumns, json(), 'PriceList');
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
    outputDetail(data as Record<string, unknown>, priceDetailColumns, json(), 'Price');
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
    outputDetail(data as Record<string, unknown>, priceDetailColumns, json(), 'Price');
  });

// --- contracts ---
const contracts = program
  .command('contracts')
  .description('Contract operations (avtal — recurring invoicing)');

contracts
  .command('list')
  .description('List/filter contracts')
  .option('--filter <filter>', 'Filter: active, inactive, finished')
  .option('--page <number>', 'Page number', parseInt)
  .option('--limit <number>', 'Results per page', parseInt)
  .option('-a, --all', 'Fetch all pages')
  .action(async (opts) => {
    const { listContracts } = await import('./operations/contracts.js');
    const data = await listContracts({
      filter: opts.filter,
      page: opts.page,
      limit: opts.limit,
      all: opts.all,
    });
    outputList(data.Contracts ?? [], contractListColumns, json(), data, data.MetaInformation);
  });

contracts
  .command('get <documentNumber>')
  .description('Get a single contract')
  .action(async (documentNumber: string) => {
    const { getContract } = await import('./operations/contracts.js');
    const data = await getContract(documentNumber);
    outputDetail(data, contractDetailColumns, json(), 'Contract');
  });

contracts
  .command('create')
  .description('Create a contract (recurring invoicing)')
  .requiredOption('--customer <number>', 'Customer number')
  .requiredOption('--input <file>', 'Contract data as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .addHelpText(
    'after',
    `
Examples:
  echo '{"InvoiceRows":[{"Description":"Hosting","DeliveredQuantity":1,"Price":500,"AccountNumber":3001,"VAT":25}],"PeriodStart":"2026-07-01","PeriodEnd":"2027-06-30","InvoiceInterval":3,"ContractLength":12}' | noxctl contracts create --customer 25 --input - --dry-run`,
  )
  .action(async (opts) => {
    const { createContract } = await import('./operations/contracts.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    const params = { CustomerNumber: opts.customer, ...input };
    if (
      !(await confirmMutation(`Create contract for customer ${opts.customer}`, opts, {
        Contract: params,
      }))
    ) {
      return;
    }
    const data = await createContract(params);
    outputDetail(data, contractDetailColumns, json(), 'Contract');
  });

contracts
  .command('update <documentNumber>')
  .description('Update a contract')
  .requiredOption('--input <file>', 'Fields to update as JSON file (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (documentNumber: string, opts) => {
    const { updateContract } = await import('./operations/contracts.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const fields = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation(`Update contract ${documentNumber}`, opts, { Contract: fields }))) {
      return;
    }
    const data = await updateContract(documentNumber, fields);
    outputDetail(data, contractDetailColumns, json(), 'Contract');
  });

contracts
  .command('finish <documentNumber>')
  .description('Finish a contract — no further invoices will be created')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { finishContract } = await import('./operations/contracts.js');
    if (!(await confirmMutation(`Finish contract ${documentNumber}`, opts))) {
      return;
    }
    const data = await finishContract(documentNumber);
    outputConfirmation(
      `Contract ${documentNumber} finished.`,
      json(),
      data,
      contractDetailColumns,
      'Contract',
    );
  });

contracts
  .command('create-invoice <documentNumber>')
  .description('Create the next invoice from a contract immediately')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { createInvoiceFromContract } = await import('./operations/contracts.js');
    if (!(await confirmMutation(`Create invoice from contract ${documentNumber}`, opts))) {
      return;
    }
    const data = await createInvoiceFromContract(documentNumber);
    outputConfirmation(
      `Invoice created from contract ${documentNumber}.`,
      json(),
      data,
      invoiceConfirmColumns,
      'Invoice',
    );
  });

contracts
  .command('increase-invoice-count <documentNumber>')
  .description('Extend a non-continuous contract by one invoice')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the action without sending it')
  .action(async (documentNumber: string, opts: { yes?: boolean; dryRun?: boolean }) => {
    const { increaseInvoiceCount } = await import('./operations/contracts.js');
    if (!(await confirmMutation(`Increase invoice count for contract ${documentNumber}`, opts))) {
      return;
    }
    const data = await increaseInvoiceCount(documentNumber);
    outputConfirmation(
      `Invoice count increased for contract ${documentNumber}.`,
      json(),
      data,
      contractDetailColumns,
      'Contract',
    );
  });

// --- recurrings (new Recurring Billing API) ---
const recurrings = program
  .command('recurrings')
  .description('Recurring Billing operations (nya API:t för återkommande fakturering)');

const csvOption = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
const recurringResult = (result: {
  recurring: Record<string, unknown>;
  etag?: string;
  lastModified?: string;
}) => ({
  ...result.recurring,
  ...(result.etag ? { etag: result.etag } : {}),
  ...(result.lastModified ? { last_modified: result.lastModified } : {}),
});

recurrings
  .command('list')
  .description('List recurring billing contracts')
  .option('--customer-numbers <numbers>', 'Comma-separated customer numbers', csvOption)
  .option('--statuses <statuses>', 'Comma-separated statuses', csvOption)
  .option('--invoice-handlings <handlings>', 'Comma-separated invoice handling types', csvOption)
  .option('--error-status <status>', 'Filter by error status')
  .option('--offset <number>', 'Number of results to skip', parseInt)
  .option('--limit <number>', 'Results per page (1–100)', parseInt)
  .option('--sort-by <field>', 'Field to sort by')
  .option('--order <direction>', 'Sort direction: ASC or DESC')
  .action(async (opts) => {
    const { listRecurrings } = await import('./operations/recurrings.js');
    const data = await listRecurrings({
      customerNumbers: opts.customerNumbers,
      statuses: opts.statuses,
      invoiceHandlings: opts.invoiceHandlings,
      errorStatus: opts.errorStatus,
      offset: opts.offset,
      limit: opts.limit,
      sortBy: opts.sortBy,
      order: opts.order,
    });
    outputList(data, recurringListColumns, json(), data);
  });

recurrings
  .command('get <recurringId>')
  .description('Get a recurring billing contract and its ETag')
  .action(async (recurringId: string) => {
    const { getRecurring } = await import('./operations/recurrings.js');
    const data = recurringResult(await getRecurring(recurringId));
    outputDetail(data, recurringDetailColumns, json(), 'Recurring');
  });

recurrings
  .command('create')
  .description('Create a recurring billing contract')
  .requiredOption('--input <file>', 'Recurring JSON data (or - for stdin)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createRecurring } = await import('./operations/recurrings.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation('Create recurring billing contract', opts, input))) return;
    const data = recurringResult(await createRecurring(input));
    outputDetail(data, recurringDetailColumns, json(), 'Recurring');
  });

recurrings
  .command('replace <recurringId>')
  .description('Replace a recurring billing contract (requires ETag)')
  .requiredOption('--etag <etag>', 'ETag returned by recurrings get')
  .requiredOption('--input <file>', 'Complete recurring JSON data (or - for stdin)')
  .option('--if-unmodified-since <value>', 'Optional Last-Modified value from recurrings get')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (recurringId: string, opts) => {
    const { replaceRecurring } = await import('./operations/recurrings.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!(await confirmMutation(`Replace recurring ${recurringId}`, opts, input))) return;
    const data = recurringResult(
      await replaceRecurring(recurringId, opts.etag, input, opts.ifUnmodifiedSince),
    );
    outputDetail(data, recurringDetailColumns, json(), 'Recurring');
  });

recurrings
  .command('patch <recurringId>')
  .description('Update selected recurring fields with JSON Patch (requires ETag)')
  .requiredOption('--etag <etag>', 'ETag returned by recurrings get')
  .requiredOption('--input <file>', 'JSON Patch operations (or - for stdin)')
  .option('--if-unmodified-since <value>', 'Optional Last-Modified value from recurrings get')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (recurringId: string, opts) => {
    const { patchRecurring } = await import('./operations/recurrings.js');
    const raw = opts.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(opts.input, 'utf-8');
    const operations = JSON.parse(raw) as Record<string, unknown>[];
    if (!Array.isArray(operations)) throw new Error('Recurring patch input must be a JSON array.');
    if (!(await confirmMutation(`Patch recurring ${recurringId}`, opts, operations))) return;
    const data = recurringResult(
      await patchRecurring(recurringId, opts.etag, operations, opts.ifUnmodifiedSince),
    );
    outputDetail(data, recurringDetailColumns, json(), 'Recurring');
  });

recurrings
  .command('list-deviations <recurringId>')
  .description('List deviations for a recurring billing contract')
  .action(async (recurringId: string) => {
    const { listRecurringDeviations } = await import('./operations/recurrings.js');
    const data = await listRecurringDeviations(recurringId);
    outputList(data, recurringListColumns, json(), data);
  });

recurrings
  .command('get-deviation <recurringId> <deviationId>')
  .description('Get one recurring billing deviation')
  .action(async (recurringId: string, deviationId: string) => {
    const { getRecurringDeviation } = await import('./operations/recurrings.js');
    const data = await getRecurringDeviation(recurringId, deviationId);
    outputDetail(data, recurringDetailColumns, json(), 'Recurring deviation');
  });

recurrings
  .command('list-invoice-requests')
  .description('List invoice-generation requests for recurring billing contracts')
  .requiredOption('--recurring-ids <ids>', 'Comma-separated recurring UUIDs', csvOption)
  .option('--statuses <statuses>', 'Comma-separated request statuses', csvOption)
  .action(async (opts) => {
    const { listInvoiceRequests } = await import('./operations/recurrings.js');
    const data = await listInvoiceRequests(opts.recurringIds, opts.statuses);
    outputList(data, invoiceRequestListColumns, json(), data);
  });

recurrings
  .command('get-invoice-request <invoiceRequestId>')
  .description('Get a recurring invoice-generation request')
  .action(async (invoiceRequestId: string) => {
    const { getInvoiceRequest } = await import('./operations/recurrings.js');
    const data = await getInvoiceRequest(invoiceRequestId);
    outputDetail(data, invoiceRequestDetailColumns, json(), 'Recurring invoice request');
  });

recurrings
  .command('create-invoice-request')
  .description('Create invoices for recurring billing contracts')
  .requiredOption('--recurring-ids <ids>', 'Comma-separated recurring UUIDs', csvOption)
  .option('--processing-mode <mode>', 'SYNC (default) or ASYNC', 'SYNC')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Preview the request without sending it')
  .action(async (opts) => {
    const { createInvoiceRequest } = await import('./operations/recurrings.js');
    const mode = String(opts.processingMode).toUpperCase();
    if (mode !== 'SYNC' && mode !== 'ASYNC')
      throw new Error('processing-mode must be SYNC or ASYNC.');
    const payload = { recurring_ids: opts.recurringIds, processing_mode: mode };
    if (!(await confirmMutation('Create recurring invoice request', opts, payload))) return;
    const data = await createInvoiceRequest(opts.recurringIds, mode);
    outputConfirmation(
      'Recurring invoice request created.',
      json(),
      data,
      invoiceRequestDetailColumns,
      'Recurring invoice request',
    );
  });

// --- financial years ---
const financialYears = program
  .command('financial-years')
  .description('Financial year and locked period operations');

financialYears
  .command('list')
  .description('List financial years (räkenskapsår)')
  .option('--date <date>', 'Find the financial year containing this date (YYYY-MM-DD)')
  .action(async (opts: { date?: string }) => {
    const { listFinancialYears } = await import('./operations/financial-years.js');
    const data = await listFinancialYears({ date: opts.date });
    outputList(
      data.FinancialYears ?? [],
      financialYearListColumns,
      json(),
      data,
      data.MetaInformation,
    );
  });

financialYears
  .command('get <id>')
  .description('Get a single financial year')
  .action(async (id: string) => {
    const { getFinancialYear } = await import('./operations/financial-years.js');
    const data = await getFinancialYear(parseInt(id, 10));
    outputDetail(data, financialYearDetailColumns, json(), 'FinancialYear');
  });

financialYears
  .command('locked-period')
  .description('Show the locked period (bokföring låst t.o.m.)')
  .action(async () => {
    const { getLockedPeriod } = await import('./operations/financial-years.js');
    const data = await getLockedPeriod();
    if (json()) {
      console.log(JSON.stringify({ LockedPeriod: data }, null, 2));
      return;
    }
    if (!data.EndDate) {
      console.log('No period is locked.');
      return;
    }
    outputDetail(data, lockedPeriodDetailColumns, false);
  });

// --- analytics ---
const analytics = program
  .command('analytics')
  .description('Precomputed analytics views (overdue, unpaid, top customers, VAT)');

analytics
  .command('overdue')
  .description('Overdue invoices summary')
  .action(async () => {
    const { getOverdueSummary } = await import('./operations/analytics.js');
    const summary = await getOverdueSummary();
    if (json()) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (summary.count === 0) {
      console.log('No overdue invoices.');
      return;
    }
    console.log(
      `Overdue: ${summary.count} invoice(s), ${summary.totalBalance.toFixed(2)} outstanding. Oldest due ${summary.oldestDueDate}.\n`,
    );
    outputList(summary.invoices, invoiceListColumns, false, summary.invoices);
  });

analytics
  .command('unpaid')
  .description('Unpaid totals (outstanding receivables)')
  .action(async () => {
    const { getUnpaidTotals } = await import('./operations/analytics.js');
    const s = await getUnpaidTotals();
    if (json()) {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(`Unpaid:  ${s.count} invoice(s), ${s.totalBalance.toFixed(2)} outstanding.`);
    console.log(`Overdue: ${s.overdueCount} invoice(s), ${s.overdueBalance.toFixed(2)}.`);
  });

analytics
  .command('top-customers')
  .description('Top customers by invoiced amount')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, last-quarter, ytd, ... Mutually exclusive with --from/--to.',
  )
  .option('--limit <number>', 'Number of customers (default 10)', parseInt)
  .action(async (opts) => {
    const { getTopCustomers } = await import('./operations/analytics.js');
    const range = fromToParams(opts);
    const result = await getTopCustomers({
      fromDate: range.fromDate,
      toDate: range.toDate,
      limit: opts.limit,
    });
    if (json()) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    outputList(
      result.customers.map((c) => ({ ...c })),
      topCustomerColumns,
      false,
      result.customers,
    );
  });

analytics
  .command('vat')
  .description('VAT summary for a period (net VAT position)')
  .option('--from <date>', 'From date (YYYY-MM-DD)')
  .option('--to <date>', 'To date (YYYY-MM-DD)')
  .option(
    '--period <period>',
    'Natural period (calendar-year): Q1, 2025-Q3, march/mars, last-quarter, ytd, ... Mutually exclusive with --from/--to.',
  )
  .option('--year <number>', 'Financial year', parseInt)
  .action(async (opts) => {
    const { getVatSummary } = await import('./operations/analytics.js');
    const range = fromToParams(opts);
    if (!range.fromDate || !range.toDate) {
      fail('analytics vat requires a period: --from/--to or --period.', 2);
    }
    const summary = await getVatSummary({
      fromDate: range.fromDate,
      toDate: range.toDate,
      financialYear: opts.year,
    });
    if (json()) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(formatTaxReport(summary));
    console.log(
      `\nNet VAT: ${(summary.netVat as number).toFixed(2)} (negative = owed to Skatteverket)`,
    );
  });

// --- dashboard ---
program
  .command('dashboard')
  .description('At-a-glance summary: recent invoices, outstanding, overdue, monthly revenue')
  .option('--months <number>', 'Months of revenue history (default 6)', parseInt)
  .action(async (opts: { months?: number }) => {
    const { getDashboard } = await import('./operations/analytics.js');
    const dash = await getDashboard({ months: opts.months });
    if (json()) {
      console.log(JSON.stringify(dash, null, 2));
      return;
    }

    console.log('OUTSTANDING');
    console.log(
      `  Unpaid:  ${dash.unpaid.count} invoice(s), ${dash.unpaid.totalBalance.toFixed(2)}`,
    );
    console.log(
      `  Overdue: ${dash.overdue.count} invoice(s), ${dash.overdue.totalBalance.toFixed(2)}` +
        (dash.overdue.oldestDueDate ? ` (oldest due ${dash.overdue.oldestDueDate})` : ''),
    );

    if (dash.overdue.count > 0) {
      console.log('\nOVERDUE INVOICES');
      outputList(dash.overdue.invoices, invoiceListColumns, false, dash.overdue.invoices);
    }

    console.log('\nRECENT INVOICES');
    outputList(dash.recentInvoices, invoiceListColumns, false, dash.recentInvoices);

    console.log('\nMONTHLY INVOICED');
    outputList(
      dash.monthlyRevenue.map((m) => ({ ...m })),
      monthlyRevenueColumns,
      false,
      dash.monthlyRevenue,
    );
  });

// --- completion ---
program
  .command('completion <shell>')
  .description('Generate shell completion script (bash, zsh, fish)')
  .addHelpText(
    'after',
    `
Examples:
  noxctl completion bash > /usr/local/etc/bash_completion.d/noxctl
  noxctl completion zsh > "\${fpath[1]}/_noxctl"
  noxctl completion fish > ~/.config/fish/completions/noxctl.fish`,
  )
  .action(async (shell: string) => {
    const { extractCommandTree, renderCompletion } = await import('./completions.js');
    console.log(renderCompletion(shell, extractCommandTree(program)));
  });

// Error handling (configureOutput + exitOverride set above, before the command
// tree, so subcommands inherit them).
try {
  await program.parseAsync(process.argv);
} catch (err) {
  const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : undefined;
  // Commander throws these for --help and --version after writing output; exit 0.
  if (code === 'commander.helpDisplayed' || code === 'commander.version') {
    process.exit(0);
  }
  // Commander parse errors (unknownCommand, missingMandatoryOptionValue,
  // excessArguments, ...) carry a `commander.*` code. configureOutput above
  // already wrote their plain-text usage message in table mode, so we must not
  // print it again here; in JSON mode that output was suppressed, so we emit
  // the structured envelope below instead.
  const isCommanderParseError = typeof code === 'string' && code.startsWith('commander.');
  if (json()) {
    // Structured mode fails structured: scripted callers branch on .error
    // instead of string-scraping stderr.
    console.error(JSON.stringify(errorEnvelope(err), null, 2));
  } else if (!isCommanderParseError) {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
}
