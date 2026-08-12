import { describe, it, expect } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');
const execOpts: ExecFileSyncOptions = { encoding: 'utf-8', timeout: 10000 };

describe('CLI smoke tests', () => {
  it('noxctl --help exits 0 and shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, '--help'], execOpts) as string;
    expect(output).toContain('setup');
    expect(output).toContain('serve');
    expect(output).toContain('invoices');
    expect(output).toContain('tax');
    expect(output).toContain('accounts');
    expect(output).toContain('customers');
    expect(output).toContain('company');
    expect(output).toContain('vouchers');
    expect(output).toContain('employees');
    expect(output).toContain('salary-transactions');
    expect(output).toContain('attendance-transactions');
    expect(output).toContain('absence-transactions');
    expect(output).toContain('schedule-times');
  });

  it('noxctl employees --help shows employee subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'employees', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl salary-transactions --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'salary-transactions', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('delete');
  });

  it('noxctl attendance-transactions --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'attendance-transactions', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('create');
    expect(output).toContain('delete');
  });

  it('noxctl absence-transactions --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'absence-transactions', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('create');
    expect(output).toContain('delete');
  });

  it('noxctl schedule-times --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'schedule-times', '--help'], execOpts) as string;
    expect(output).toContain('get');
    expect(output).toContain('update');
    expect(output).toContain('reset-day');
  });

  it('noxctl recurrings --help shows recurring-billing subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'recurrings', '--help'], execOpts) as string;
    expect(output).toContain('list-invoice-requests');
    expect(output).toContain('create-invoice-request');
  });

  it('noxctl init --help shows the --with-salary flag', () => {
    const output = execFileSync('node', [CLI_PATH, 'init', '--help'], execOpts) as string;
    expect(output).toContain('--with-salary');
  });

  it('noxctl invoices --help shows invoice subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'invoices', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('send');
    expect(output).toContain('pdf');
    expect(output).toContain('bookkeep');
    expect(output).toContain('credit');
  });

  it('noxctl invoices pdf --help documents the destination and --mark-sent options', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'invoices', 'pdf', '--help'],
      execOpts,
    ) as string;
    // The destination is --file: -o/--output is globally the output *format*.
    expect(output).toContain('--file');
    expect(output).toContain('--mark-sent');
    // The default must be the non-mutating endpoint.
    expect(output).toContain('/preview');
  });

  it('noxctl invoices pdf --file does not collide with the global --output format flag', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'invoices', 'pdf', '--help'],
      execOpts,
    ) as string;
    expect(output).not.toMatch(/-o, --output <path>/);
  });

  it('noxctl tax --help shows tax subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'tax', '--help'], execOpts) as string;
    expect(output).toContain('report');
  });

  it('noxctl customers --help shows customer subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'customers', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl company --help shows company subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'company', '--help'], execOpts) as string;
    expect(output).toContain('info');
  });

  it('noxctl vouchers --help shows voucher subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'vouchers', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('create');
    expect(output).toContain('attach');
  });

  it('noxctl vouchers attach --help shows file and year options', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'vouchers', 'attach', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('--year');
    expect(output).toContain('--dry-run');
  });

  it('noxctl reports --help shows report subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'reports', '--help'], execOpts) as string;
    expect(output).toContain('income');
    expect(output).toContain('balance');
  });

  it('noxctl reports income --help shows --from and --to options', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'reports', 'income', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('--from');
    expect(output).toContain('--to');
    expect(output).toContain('--year');
  });

  it('noxctl reports balance --help shows --to option', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'reports', 'balance', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('--to');
    expect(output).toContain('--year');
  });

  it('noxctl doctor --help exits 0', () => {
    const output = execFileSync('node', [CLI_PATH, 'doctor', '--help'], execOpts) as string;
    expect(output).toContain('Check setup');
  });

  it('noxctl logout --help shows --yes and --all options', () => {
    const output = execFileSync('node', [CLI_PATH, 'logout', '--help'], execOpts) as string;
    expect(output).toContain('--yes');
    expect(output).toContain('--all');
    expect(output).toContain('Remove stored');
  });

  it('noxctl init --help shows --profile option', () => {
    const output = execFileSync('node', [CLI_PATH, 'init', '--help'], execOpts) as string;
    expect(output).toContain('Interactive setup');
    expect(output).toContain('--profile');
  });

  it('noxctl --help mentions --profile global option', () => {
    const output = execFileSync('node', [CLI_PATH, '--help'], execOpts) as string;
    expect(output).toContain('--profile');
  });

  it('noxctl profile --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'profile', '--help'], execOpts) as string;
    expect(output).toContain('use');
    expect(output).toContain('current');
    expect(output).toContain('list');
  });

  it('noxctl profile current --help exits 0', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'profile', 'current', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('resolved profile');
  });

  it('noxctl supplier-invoices --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'supplier-invoices', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('bookkeep');
  });

  it('noxctl articles --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'articles', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl suppliers --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'suppliers', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl invoice-payments --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'invoice-payments', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('delete');
  });

  it('noxctl supplier-invoice-payments --help shows subcommands', () => {
    const output = execFileSync(
      'node',
      [CLI_PATH, 'supplier-invoice-payments', '--help'],
      execOpts,
    ) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('delete');
  });

  it('noxctl offers --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'offers', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('create-invoice');
    expect(output).toContain('create-order');
  });

  it('noxctl orders --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'orders', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('create-invoice');
  });

  it('noxctl projects --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'projects', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl costcenters --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'costcenters', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('delete');
  });

  it('noxctl tax-reductions --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'tax-reductions', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
  });

  it('noxctl pricelists --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'pricelists', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
  });

  it('noxctl prices --help shows subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'prices', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('update');
  });

  it('unknown command exits non-zero', () => {
    expect(() => {
      execFileSync('node', [CLI_PATH, 'nonexistent'], { ...execOpts, stdio: 'pipe' });
    }).toThrow();
  });
});

describe('version consistency', () => {
  // Both entry points hardcode their version string, so each can silently drift
  // from package.json across releases. Both have already done so: the CLI
  // shipped 0.5.0 announcing 0.4.1, and the MCP server was still reporting
  // 0.4.1 to clients after that was fixed. Cover both, not just the one that
  // was noticed first.
  const packageVersion = () =>
    (JSON.parse(readFileSync(path.resolve('package.json'), 'utf-8')) as { version: string })
      .version;

  it('noxctl --version matches the package version', () => {
    const output = execFileSync('node', [CLI_PATH, '--version'], execOpts) as string;
    expect(output.trim()).toBe(packageVersion());
  });

  it('the MCP server reports the package version to clients', async () => {
    const { createServer } = await import('../src/index.js');
    // McpServer keeps the registered implementation info on the inner server.
    const info = (
      createServer().server as unknown as { _serverInfo: { name: string; version: string } }
    )._serverInfo;
    expect(info.version).toBe(packageVersion());
  });
});
