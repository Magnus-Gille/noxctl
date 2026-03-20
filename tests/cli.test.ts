import { describe, it, expect } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
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
  });

  it('noxctl invoices --help shows invoice subcommands', () => {
    const output = execFileSync('node', [CLI_PATH, 'invoices', '--help'], execOpts) as string;
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('send');
    expect(output).toContain('bookkeep');
    expect(output).toContain('credit');
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

  it('noxctl logout --help shows --yes option', () => {
    const output = execFileSync('node', [CLI_PATH, 'logout', '--help'], execOpts) as string;
    expect(output).toContain('--yes');
    expect(output).toContain('Remove stored');
  });

  it('noxctl init --help exits 0', () => {
    const output = execFileSync('node', [CLI_PATH, 'init', '--help'], execOpts) as string;
    expect(output).toContain('Interactive setup');
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
