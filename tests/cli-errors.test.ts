import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorEnvelope } from '../src/formatter.js';

const CLI_PATH = path.resolve('dist/cli.js');

let tmpHome: string;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
  };
  delete mergedEnv.NOXCTL_PROFILE;

  const opts: ExecFileSyncOptions = {
    encoding: 'utf-8',
    timeout: 10000,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], opts) as string;
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: (e.stdout?.toString() ?? '') as string,
      stderr: (e.stderr?.toString() ?? '') as string,
      status: e.status ?? 1,
    };
  }
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-cli-errors-'));
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('errorEnvelope', () => {
  it('maps FortnoxApiError-shaped errors to a fortnox-api envelope', () => {
    const err = Object.assign(
      new Error('Fortnox API error (400): Fältet Country är endast läsbart.'),
      {
        name: 'FortnoxApiError',
        statusCode: 400,
        fortnoxMessage: 'Fältet Country är endast läsbart.',
        hint: undefined,
      },
    );
    expect(errorEnvelope(err)).toEqual({
      error: {
        status: 400,
        message: 'Fältet Country är endast läsbart.',
        source: 'fortnox-api',
      },
    });
  });

  it('includes the hint when present', () => {
    const err = Object.assign(new Error('x'), {
      name: 'FortnoxApiError',
      statusCode: 403,
      fortnoxMessage: 'No access',
      hint: 'Check API scopes.',
    });
    expect(errorEnvelope(err).error.hint).toBe('Check API scopes.');
  });

  it('maps plain errors to a noxctl envelope', () => {
    expect(errorEnvelope(new Error('Invalid customer number'))).toEqual({
      error: { message: 'Invalid customer number', source: 'noxctl' },
    });
  });

  it('stringifies non-Error values', () => {
    expect(errorEnvelope('boom').error.message).toBe('boom');
  });
});

describe('CLI -o json error envelope', () => {
  it('emits a parseable JSON envelope on failure in json mode', () => {
    const res = run(['customers', 'get', '../evil', '-o', 'json']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stderr.trim()) as {
      error: { message: string; source: string };
    };
    expect(parsed.error.source).toBe('noxctl');
    expect(parsed.error.message).toContain('Invalid customer number');
  });

  it('keeps plain-text errors in table mode', () => {
    const res = run(['customers', 'get', '../evil', '-o', 'table']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Invalid customer number');
    expect(() => JSON.parse(res.stderr.trim())).toThrow();
  });
});

describe('CLI usage validation honors -o json (no period given)', () => {
  // These fire before any API call, so they exercise the JSON error contract
  // for direct-exit validation paths without needing credentials.
  it('tax report emits a JSON envelope (exit 2) in json mode', () => {
    const res = run(['tax', 'report', '-o', 'json']);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stderr.trim()) as { error: { message: string; source: string } };
    expect(parsed.error.source).toBe('noxctl');
    expect(parsed.error.message).toMatch(/requires a period/i);
  });

  it('tax report stays plain text (exit 2) in table mode', () => {
    const res = run(['tax', 'report', '-o', 'table']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/requires a period/i);
    expect(() => JSON.parse(res.stderr.trim())).toThrow();
  });

  it('analytics vat emits a JSON envelope (exit 2) in json mode', () => {
    const res = run(['analytics', 'vat', '-o', 'json']);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stderr.trim()) as { error: { message: string; source: string } };
    expect(parsed.error.source).toBe('noxctl');
    expect(parsed.error.message).toMatch(/requires a period/i);
  });
});

describe('Commander parse errors honor -o json', () => {
  it('a missing required option emits a JSON envelope in json mode', () => {
    const res = run(['-o', 'json', 'customers', 'create']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stderr.trim()) as { error: { message: string; source: string } };
    expect(parsed.error.source).toBe('noxctl');
    expect(parsed.error.message).toMatch(/required option/i);
  });

  it('a missing required option stays plain text in table mode, printed once', () => {
    const res = run(['-o', 'table', 'customers', 'create']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/required option '--name/);
    expect(() => JSON.parse(res.stderr.trim())).toThrow();
    // Commander prints its usage error exactly once (no double-print from the
    // top-level handler).
    expect(res.stderr.split('required option').length - 1).toBe(1);
  });
});

describe('global --profile validation honors -o json', () => {
  // The preAction hook validates --profile before any data command runs, so a
  // scripted `-o json` caller must still get a structured envelope.
  it('rejects an invalid profile with a JSON envelope in json mode', () => {
    const res = run(['-o', 'json', '--profile', '../evil', 'customers', 'list']);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stderr.trim()) as { error: { message: string; source: string } };
    expect(parsed.error.source).toBe('noxctl');
    expect(parsed.error.message).toMatch(/invalid profile name/i);
  });

  it('rejects an invalid profile with plain text in table mode', () => {
    const res = run(['-o', 'table', '--profile', '../evil', 'customers', 'list']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/invalid profile name/i);
    expect(() => JSON.parse(res.stderr.trim())).toThrow();
  });
});

describe('invoices pdf --file -', () => {
  // `run` pipes stdout, so isJsonMode() defaults to true here — which is exactly
  // how `--file -` is used in practice (`... --file - > invoice.pdf`). Guarding
  // on the resolved mode instead of an explicit -o json made the flag unusable.
  it('is not refused merely because stdout is piped', () => {
    const res = run(['invoices', 'pdf', '23', '--file', '-']);
    expect(res.stderr).not.toMatch(/cannot be combined/i);
    expect(res.stdout).not.toMatch(/cannot be combined/i);
  });

  it('is still refused when the caller explicitly asks for -o json', () => {
    const res = run(['-o', 'json', 'invoices', 'pdf', '23', '--file', '-']);
    expect(res.stderr).toMatch(/cannot be combined/i);
  });
});
