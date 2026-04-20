import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');

let tmpHome: string;
let cfgDir: string;
let activePointerFile: string;
let profilesIndexFile: string;

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; status: number } {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    ...env,
  };
  if (!('NOXCTL_PROFILE' in env)) delete mergedEnv.NOXCTL_PROFILE;

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
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: (e.stdout?.toString() ?? '') as string,
      stderr: (e.stderr?.toString() ?? '') as string,
      status: e.status ?? 1,
    };
  }
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-cli-profile-'));
  cfgDir = path.join(tmpHome, '.fortnox-mcp');
  activePointerFile = path.join(cfgDir, 'active-profile');
  profilesIndexFile = path.join(cfgDir, 'profiles.json');
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// Note: stdout is piped in these tests, so isJsonMode defaults to JSON.
// The human-readable format is exercised via `--output table`.

describe('profile current', () => {
  it('prints default/default when nothing is set', () => {
    const res = run(['profile', 'current']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'default', source: 'default' });
  });

  it('reports flag source when --profile is passed', () => {
    const res = run(['--profile', 'work', 'profile', 'current']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'work', source: 'flag' });
  });

  it('reports env source when NOXCTL_PROFILE is set', () => {
    const res = run(['profile', 'current'], { NOXCTL_PROFILE: 'work' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'work', source: 'env' });
  });

  it('reports pointer source when active-profile file exists', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(activePointerFile, 'work\n');
    const res = run(['profile', 'current']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'work', source: 'pointer' });
  });

  it('prefers flag over env and pointer', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(activePointerFile, 'point\n');
    const res = run(['--profile', 'flagwin', 'profile', 'current'], {
      NOXCTL_PROFILE: 'envlose',
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'flagwin', source: 'flag' });
  });

  it('prefers env over pointer when no flag is set', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(activePointerFile, 'point\n');
    const res = run(['profile', 'current'], { NOXCTL_PROFILE: 'envwin' });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'envwin', source: 'env' });
  });

  it('emits human-readable output when --output table is passed', () => {
    const res = run(['--output', 'table', '--profile', 'work', 'profile', 'current']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('work (source: flag)');
  });

  it('falls back to default when active-profile contains an invalid name', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(activePointerFile, 'has space\n');
    const res = run(['profile', 'current']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'default', source: 'default' });
  });

  it('exits non-zero when --profile value is invalid', () => {
    const res = run(['--profile', 'bad name!', 'profile', 'current']);
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('invalid profile name');
  });
});

describe('profile list', () => {
  it('emits an empty JSON array when no profiles registered (pipe mode)', () => {
    const res = run(['profile', 'list']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });

  it('shows a friendly message with --output table when no profiles', () => {
    const res = run(['--output', 'table', 'profile', 'list']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No profiles registered');
  });

  it('emits JSON with all profile metadata (pipe mode)', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      profilesIndexFile,
      JSON.stringify({
        schema_version: 1,
        profiles: [
          {
            name: 'default',
            company_name: 'Acme AB',
            tenant_id: '12345',
            created_at: '2026-01-01T00:00:00.000Z',
            schema_version: 2,
          },
          { name: 'work', created_at: '2026-01-02T00:00:00.000Z', schema_version: 2 },
        ],
      }),
    );
    const res = run(['profile', 'list']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as Array<{ name: string; company_name?: string }>;
    expect(parsed.map((p) => p.name)).toEqual(['default', 'work']);
    expect(parsed[0]!.company_name).toBe('Acme AB');
  });

  it('renders a human-readable listing with --output table', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      profilesIndexFile,
      JSON.stringify({
        schema_version: 1,
        profiles: [
          {
            name: 'default',
            company_name: 'Acme AB',
            tenant_id: '12345',
            created_at: '2026-01-01T00:00:00.000Z',
            schema_version: 2,
          },
        ],
      }),
    );
    const res = run(['--output', 'table', 'profile', 'list']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Acme AB');
    expect(res.stdout).toContain('tenant 12345');
  });
});

describe('profile use', () => {
  it('refuses to switch to a profile without credentials', () => {
    const res = run(['profile', 'use', 'work']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('No credentials found for profile "work"');
  });

  it('rejects an invalid profile name', () => {
    const res = run(['profile', 'use', 'bad name!']);
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('invalid profile name');
  });
});

describe('stderr profile indicator', () => {
  it('is absent in non-TTY output (test runs without a TTY)', () => {
    const res = run(['--profile', 'work', 'profile', 'current']);
    expect(res.stderr).not.toContain('[profile:');
  });
});
