import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');
const CLI_TIMEOUT_MS = 30_000;

// Empty HOME: no credentials, so input that reached Fortnox would fail on auth instead.
function run(args: string[], input: string) {
  const tmpHome = mkdtempSync(path.join(tmpdir(), 'noxctl-articles-home-'));
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

describe('noxctl articles bundle-prices', () => {
  it.each([
    ['an object without rows', { Price: 1 }],
    ['a row that is not an object', { Rows: [1] }],
  ])('rejects %s before contacting Fortnox', (_label, input) => {
    const result = run(['articles', 'bundle-prices', '--input', '-'], JSON.stringify(input));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Bundle price input must be an array of row objects/);
  });

  it('rejects an empty row list before contacting Fortnox', () => {
    const result = run(['articles', 'bundle-prices', '--input', '-'], JSON.stringify([]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/at least one row/);
  });
});
