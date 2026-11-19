import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');
const CLI_TIMEOUT_MS = 30_000;

// Empty HOME: no credentials, so a dry run that reached Fortnox would fail.
function run(args: string[], input: string) {
  const tmpHome = mkdtempSync(path.join(tmpdir(), 'noxctl-contracts-home-'));
  try {
    return spawnSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NOXCTL_PROFILE: 'default' },
      input,
      timeout: CLI_TIMEOUT_MS,
    });
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function payloadOf(output: string): unknown {
  const marker = 'Request payload:\n';
  const start = output.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(start + marker.length));
}

describe('noxctl contracts create --dry-run', () => {
  it('previews ContractLength 0 for a continuous contract, as the real call sends', () => {
    const result = run(
      ['contracts', 'create', '--customer', '25', '--input', '-', '--dry-run'],
      JSON.stringify({ Continuous: true, InvoiceInterval: 1 }),
    );
    expect(result.status).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      Contract: { CustomerNumber: '25', Continuous: true, InvoiceInterval: 1, ContractLength: 0 },
    });
  });

  it('rejects a positive ContractLength on a continuous contract before previewing', () => {
    const result = run(
      ['contracts', 'create', '--customer', '25', '--input', '-', '--dry-run'],
      JSON.stringify({ Continuous: true, ContractLength: 12 }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Continuous: true cannot be combined with ContractLength 12/);
  });
});

describe('noxctl invoices create --dry-run', () => {
  it('passes invoice fields through without contract normalization', () => {
    const result = run(
      ['invoices', 'create', '--customer', '25', '--input', '-', '--dry-run'],
      JSON.stringify({ InvoiceRows: [{ Description: 'X', DeliveredQuantity: 1, Price: 1 }] }),
    );
    expect(result.status).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      Invoice: {
        CustomerNumber: '25',
        InvoiceRows: [{ Description: 'X', DeliveredQuantity: 1, Price: 1 }],
      },
    });
  });
});
