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

  it('unknown command exits non-zero', () => {
    expect(() => {
      execFileSync('node', [CLI_PATH, 'nonexistent'], { ...execOpts, stdio: 'pipe' });
    }).toThrow();
  });
});
