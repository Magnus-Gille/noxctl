import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');
const CLI_TIMEOUT_MS = 30_000;

// Every run uses an empty HOME, so no credentials exist: a dry run that reached
// Fortnox (or even the keychain) would fail instead of printing the preview.
function run(args: string[]) {
  const tmpHome = mkdtempSync(path.join(tmpdir(), 'noxctl-noxfinans-home-'));
  try {
    return spawnSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NOXCTL_PROFILE: 'default' },
      input: '',
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

describe('noxctl noxfinans', () => {
  it('lists every Fortnox Finans subcommand', () => {
    const help = execFileSync('node', [CLI_PATH, 'noxfinans', '--help'], {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
    });
    for (const sub of ['get', 'send', 'pause', 'unpause', 'stop', 'take-fees', 'report-payment']) {
      expect(help).toContain(sub);
    }
  });

  it('send --dry-run prints the exact POST body and contacts nothing', () => {
    const result = run([
      'noxfinans',
      'send',
      '7201',
      '--service',
      'REMINDER',
      '--send-method',
      'LETTER',
      '--dry-run',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No request was sent to Fortnox');
    expect(payloadOf(result.stdout)).toEqual({
      NoxFinansInvoice: { InvoiceNumber: '7201', SendMethod: 'LETTER', Service: 'REMINDER' },
    });
  });

  it('send requires --service and --send-method (no silent defaults)', () => {
    const result = run(['noxfinans', 'send', '7201', '--dry-run']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--service/);
  });

  it('send refuses NONE with the REMINDER service', () => {
    const result = run([
      'noxfinans',
      'send',
      '7201',
      '--service',
      'REMINDER',
      '--send-method',
      'NONE',
      '--dry-run',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/NONE/);
  });

  it('send without --yes refuses when not on a TTY', () => {
    const result = run([
      'noxfinans',
      'send',
      '7201',
      '--service',
      'LEDGERBASE',
      '--send-method',
      'EMAIL',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Confirmation required/);
  });

  it('pause --dry-run prints the pause body', () => {
    const result = run(['noxfinans', 'pause', '7201', '--until', '2026-12-15', '--dry-run']);
    expect(result.status).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      NoxFinansInvoice: { PausedUntilDate: '2026-12-15' },
    });
  });

  it('report-payment --dry-run prints the payment body with bookkeeping defaults on', () => {
    const result = run([
      'noxfinans',
      'report-payment',
      '7201',
      '--amount',
      '500',
      '--method-code',
      'BG',
      '--account',
      '1930',
      '--dry-run',
    ]);
    expect(result.status).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      NoxFinansInvoice: {
        PaymentAmount: 500,
        PaymentMethodCode: 'BG',
        PaymentMethodAccount: 1930,
        ClientTakesFees: false,
        BookkeepPaymentInFortnox: true,
        ReportToFinance: true,
      },
    });
  });

  it.each(['unpause', 'stop', 'take-fees'])('%s --dry-run sends nothing', (sub) => {
    const result = run(['noxfinans', sub, '7201', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No request was sent to Fortnox');
  });
});
