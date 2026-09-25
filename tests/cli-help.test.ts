import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { commandGroups, validateCommandGroups } from '../src/cli-help.js';

function run(args: string[], width = 80) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,Object.defineProperties(process.stdout,{columns:{value:${width}},isTTY:{value:true}})`,
      path.resolve('dist/cli.js'),
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NOXCTL_PROFILE: 'invalid/profile' },
    },
  );
}

describe('CLI help discovery', () => {
  it('rejects missing, stale, and duplicate catalogue membership', () => {
    const names = commandGroups.flatMap(([, commands]) => [...commands]);
    expect(new Set(names).size).toBe(names.length);
    expect(() => validateCommandGroups(names)).not.toThrow();
    expect(() => validateCommandGroups([...names, 'new-command'])).toThrow('missing [new-command]');
    expect(() => validateCommandGroups(names.filter((name) => name !== 'profile'))).toThrow(
      'stale [profile]',
    );
  });

  it.each([80, 120])('keeps the first screen compact at %i columns', (width) => {
    const result = run(['--help'], width);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Fortnox accounting from your terminal');
    expect(result.stdout).toContain('--help-all');
    expect(result.stdout).not.toContain('MCP');
    expect(result.stdout.trim().split('\n').length).toBeLessThanOrEqual(37);
    expect(Math.max(...result.stdout.split('\n').map((line) => line.length))).toBeLessThanOrEqual(
      width,
    );
  });

  it.each([80, 120])('shows the complete grouped catalogue at %i columns', (width) => {
    const result = run(['--help-all'], width);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const group of [
      'Sales',
      'Purchases',
      'Accounting & reports',
      'Payroll',
      'Files',
      'Reference & company setup',
      'CLI setup',
      'Integrations',
    ]) {
      expect(result.stdout).toContain(`${group}:`);
    }
    expect(result.stdout).toContain('serve');
    expect(result.stdout).toContain('salary-transactions');
    expect(result.stdout).not.toContain('supplier-invoices|si');
    for (const [group] of commandGroups) {
      const section = result.stdout.split(`${group}:\n`)[1]!.split('\n\n')[0]!;
      const names = [...section.matchAll(/^  ([a-z][a-z-]+)\s/gm)].map((match) => match[1]!);
      expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    }
    expect(Math.max(...result.stdout.split('\n').map((line) => line.length))).toBeLessThanOrEqual(
      width,
    );
  });

  it('preserves alias parsing and explains shortcuts in detailed help', () => {
    for (const [alias, canonical] of [
      ['si', 'supplier-invoices'],
      ['ip', 'invoice-payments'],
      ['sip', 'supplier-invoice-payments'],
      ['ledger', 'general-ledger'],
      ['reports resultat', 'reports income'],
      ['reports balans', 'reports balance'],
    ]) {
      const result = run([...alias.split(' '), '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(run([...canonical.split(' '), '--help']).stdout);
      expect(result.stdout).toContain('Aliases:');
    }
  });

  it('validates --help-all arguments and never runs a subcommand with it', () => {
    for (const args of [
      ['--help-all', '--unknown'],
      ['--help-all', 'unknown'],
      ['--help-all', '--profile'],
      ['--help-all', 'profile', 'current'],
      ['--help-all', 'serve'],
    ]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('');
    }
  });

  it('keeps all canonical commands and --help-all available to completion', () => {
    const completion = run(['completion', 'bash']);
    expect(completion.status).toBe(0);
    expect(completion.stdout).toContain('--help-all');
    const full = run(['--help-all']).stdout;
    const names = [...completion.stdout.matchAll(/^      ([a-z][a-z-]+)\)/gm)].map(
      (match) => match[1],
    );
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      expect(
        full.split('\n').filter((line) => new RegExp(`^  ${name}\\s`).test(line)),
      ).toHaveLength(1);
    }
  });
});
