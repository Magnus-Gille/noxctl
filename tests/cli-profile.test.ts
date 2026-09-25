import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLI_PATH = path.resolve('dist/cli.js');

// Windows CI runners spawn Node far slower than a warm local machine; 10s put
// these subprocess assertions right at the edge and they flaked intermittently.
const CLI_TIMEOUT_MS = 30_000;

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
    timeout: CLI_TIMEOUT_MS,
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

async function mockCredentialEnv(
  state: 'missing' | 'available' = 'missing',
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { NOXCTL_KEYCHAIN_PATH: '' };
  if (process.platform === 'win32') return env;

  const binDir = path.join(tmpHome, 'mock-bin');
  await fs.mkdir(binDir, { recursive: true });
  const backend = process.platform === 'darwin' ? 'security' : 'secret-tool';
  const missingExit = process.platform === 'darwin' ? '44' : '1';
  const script =
    `#!/bin/sh\n` +
    `if [ "$NOXCTL_TEST_CREDENTIAL_STATE" = "available" ]; then\n` +
    `  printf '%s' "$NOXCTL_TEST_CREDENTIAL_BLOB"\n` +
    `  exit 0\n` +
    `fi\n` +
    `exit ${missingExit}\n`;
  await fs.writeFile(path.join(binDir, backend), script, { mode: 0o700 });

  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    NOXCTL_TEST_CREDENTIAL_STATE: state,
    NOXCTL_TEST_CREDENTIAL_BLOB: JSON.stringify({
      client_id: 'test-client',
      client_secret: 'synthetic-test-secret',
      access_token: 'synthetic-test-token',
      refresh_token: 'synthetic-refresh-token',
      expires_at: 0,
    }),
    NOXCTL_KEYCHAIN_PATH: '',
  };
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

describe('profile help', () => {
  it('explains invocation overrides and saved profile precedence in detailed help', () => {
    const root = run(['--help']);
    expect(root.status).toBe(0);
    const rootHelp = root.stdout.replace(/\s+/g, ' ');
    expect(rootHelp).toContain('one invocation only');

    const detail = run(['profile', '--help']);
    expect(detail.status).toBe(0);
    const profileHelp = detail.stdout.replace(/\s+/g, ' ');
    expect(profileHelp).toContain('--profile');
    expect(profileHelp).toContain('NOXCTL_PROFILE');
    expect(profileHelp).toContain('profile use');
    expect(profileHelp).toContain('default');
  });

  it('describes profile use as saving the default without exposing the pointer path', () => {
    const res = run(['profile', 'use', '--help']);
    expect(res.status).toBe(0);
    expect(res.stdout.replace(/\s+/g, ' ')).toContain('Save the default profile');
    expect(res.stdout).not.toContain('~/.fortnox-mcp/active-profile');
  });

  it('explains that keychain unlock applies to the keychain, not an individual profile', () => {
    const res = run(['keychain', 'unlock', '--help']);
    expect(res.status).toBe(0);
    const unlockHelp = res.stdout.replace(/\s+/g, ' ');
    expect(unlockHelp).toContain('dedicated keychain');
    expect(unlockHelp).toContain('not a per-profile lock');
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
  it('refuses to switch when credentials are missing or the store is inaccessible', () => {
    const res = run(['profile', 'use', 'work']);
    expect(res.status).not.toBe(0);
    const message = res.stderr.trim().startsWith('{')
      ? (JSON.parse(res.stderr) as { error: { message: string } }).error.message
      : res.stderr;
    expect(message).toMatch(
      /No credentials found for profile "work"|Credential state: inaccessible for profile "work"/,
    );
  });

  it('rejects an invalid profile name', () => {
    const res = run(['profile', 'use', 'bad name!']);
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('invalid profile name');
  });

  it('suggests a close known profile and lists profiles before the creation hint', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      profilesIndexFile,
      JSON.stringify({
        schema_version: 1,
        profiles: [{ name: 'default', created_at: '2026-01-01T00:00:00.000Z', schema_version: 2 }],
      }),
    );

    const res = run(['--output', 'table', 'profile', 'use', 'defaukt'], await mockCredentialEnv());
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Did you mean "default"?');
    expect(res.stderr).toContain('noxctl profile list');
    expect(res.stderr).toContain('noxctl init --profile defaukt');
    expect(res.stderr.indexOf('noxctl profile list')).toBeLessThan(
      res.stderr.indexOf('noxctl init --profile defaukt'),
    );
    await expect(fs.access(activePointerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const indexAfter = JSON.parse(await fs.readFile(profilesIndexFile, 'utf-8')) as {
      profiles: Array<{ name: string }>;
    };
    expect(indexAfter.profiles.map((entry) => entry.name)).toEqual(['default']);
  });

  it.skipIf(process.platform === 'win32')(
    'writes the selected profile and reports the saved default clearly',
    async () => {
      const res = run(
        ['--output', 'table', 'profile', 'use', 'work'],
        await mockCredentialEnv('available'),
      );
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('Saved default profile set to "work".');
      expect(res.stderr).not.toContain('[profile: work]');
      expect(await fs.readFile(activePointerFile, 'utf-8')).toBe('work\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the successful JSON response contract',
    async () => {
      const res = run(
        ['--output', 'json', 'profile', 'use', 'work'],
        await mockCredentialEnv('available'),
      );
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({ name: 'work', source: 'pointer' });
    },
  );
});

describe('credential recovery safety', () => {
  async function registerProfile(name: string): Promise<void> {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      profilesIndexFile,
      JSON.stringify({
        schema_version: 1,
        profiles: [{ name, created_at: '2026-01-01T00:00:00.000Z', schema_version: 2 }],
      }),
    );
  }

  it('init fails closed before setup when a registered profile lookup is inconclusive', async () => {
    await registerProfile('work');

    const res = run(['--output', 'table', '--profile', 'work', 'init']);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Credential state: inaccessible');
    expect(res.stderr).toContain('profile "work" (source: flag)');
    expect(res.stderr).toContain('unsandboxed terminal');
    expect(res.stdout).not.toContain('Welcome to noxctl init');
    expect(res.stdout).not.toContain('replace your current credentials');
  });

  it('doctor uses the same inaccessible vocabulary and reports profile source', async () => {
    await registerProfile('work');

    const res = run(['--output', 'table', '--profile', 'work', 'doctor']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Profile — work (source: flag)');
    expect(res.stdout).toContain('Credentials — inaccessible');
    expect(res.stdout).toContain('unsandboxed terminal');
    expect(res.stdout).not.toContain('noxctl init --profile work');
  });

  it('keychain status uses the same inaccessible vocabulary on every platform', async () => {
    await registerProfile('work');

    const res = run(['--output', 'table', '--profile', 'work', 'keychain', 'status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Credential state  inaccessible');
    expect(res.stdout).toContain('profile "work" (source: flag)');
    expect(res.stdout).toContain('unsandboxed terminal');
  });
});

describe('stderr profile indicator', () => {
  it('is absent in non-TTY output (test runs without a TTY)', () => {
    const res = run(['--profile', 'work', 'profile', 'current']);
    expect(res.stderr).not.toContain('[profile:');
  });
});

describe('logout --all', () => {
  it('reports nothing to remove when no profiles are registered', () => {
    const res = run(['logout', '--all', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No credentials found');
  });

  it('clears the index and active pointer even when credentials are absent', async () => {
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(
      profilesIndexFile,
      JSON.stringify({
        schema_version: 1,
        profiles: [
          { name: 'default', created_at: '2026-01-01T00:00:00.000Z', schema_version: 2 },
          { name: 'work', created_at: '2026-01-02T00:00:00.000Z', schema_version: 2 },
        ],
      }),
    );
    await fs.writeFile(activePointerFile, 'work\n');

    const res = run(['logout', '--all', '--yes']);
    expect(res.status).toBe(0);

    const idxAfter = JSON.parse(await fs.readFile(profilesIndexFile, 'utf-8')) as {
      profiles: unknown[];
    };
    expect(idxAfter.profiles).toEqual([]);
    await expect(fs.access(activePointerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
