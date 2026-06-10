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
