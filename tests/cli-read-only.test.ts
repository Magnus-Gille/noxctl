import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Requires `npm run build`, like the other subprocess CLI tests.
const CLI_PATH = path.resolve('dist/cli.js');
const TIMEOUT_MS = 30_000;

function runServe(args: string[], readOnlyEnv: string | undefined) {
  // Isolate HOME so the active-profile pointer of the developer machine is never read.
  const home = mkdtempSync(path.join(tmpdir(), 'noxctl-cli-read-only-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env['NOXCTL_PROFILE'];
    if (readOnlyEnv === undefined) delete env['NOXCTL_READ_ONLY'];
    else env['NOXCTL_READ_ONLY'] = readOnlyEnv;
    // Empty stdin ends the stdio transport so a valid startup returns instead of waiting.
    return spawnSync('node', [CLI_PATH, 'serve', ...args], {
      encoding: 'utf8',
      input: '',
      env,
      timeout: TIMEOUT_MS,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('noxctl serve read-only mode', () => {
  it('documents --read-only in serve help', () => {
    const result = spawnSync('node', [CLI_PATH, 'serve', '--help'], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--read-only');
    expect(result.stdout).toContain('NOXCTL_READ_ONLY');
  });

  it('fails closed with exit code 2 for an unrecognized NOXCTL_READ_ONLY value', () => {
    const result = runServe([], 'yes');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOXCTL_READ_ONLY');
  });

  it('announces read-only mode on stderr when the flag is set', () => {
    const result = runServe(['--read-only'], undefined);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('[read-only:');
  });

  it('announces read-only mode on stderr when only the env var is set', () => {
    const result = runServe([], 'TRUE');
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('[read-only:');
  });

  it('keeps a full server when NOXCTL_READ_ONLY is off', () => {
    const result = runServe([], '0');
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain('[read-only:');
  });
});
