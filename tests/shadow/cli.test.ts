import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openShadowQueue } from '../../src/shadow/queue.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'noxctl-shadow-cli-'));
  roots.push(root);
  const config = {
    version: 1,
    profile: 'fixture',
    sourceCompany: 'fixture-source',
    targetCompany: 'fixture-target',
    directory: join(root, 'queue'),
  };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve('dist/cli.js'), '--profile', 'fixture', ...args], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 15000,
    });
  return { config, configPath, run };
}
describe('CLI shadow capture controls', () => {
  it('is disabled by default and does not need credentials to report status', () => {
    const { run } = setup();
    const result = run(['shadow', 'status']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ enabled: false });
  });
  it('preserves dry-run and missing-confirmation gates with capture configured', async () => {
    const { config, configPath, run } = setup();
    const prefix = ['--shadow-config', configPath, '--shadow-intent', 'synthetic-command'];
    const dry = run([...prefix, 'customers', 'create', '--name', 'Synthetic', '--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('Dry run');
    const missing = run([...prefix, 'customers', 'create', '--name', 'Synthetic']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Confirmation required');
    const queue = await openShadowQueue(config.directory, {
      sourceCompany: config.sourceCompany,
      targetCompany: config.targetCompany,
    });
    expect(queue.status().items).toEqual([]);
    queue.close();
    const status = run([...prefix, 'shadow', 'status']);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).counts.pending).toBe(0);
  });
  it('refuses unbound stdio activation and an intent without configuration', () => {
    const { configPath, run } = setup();
    expect(run(['--shadow-config', configPath, 'serve']).stderr).toContain(
      'tenant-bound embedded host',
    );
    expect(run(['--shadow-intent', 'id', 'shadow', 'status']).stderr).toContain(
      'requires --shadow-config',
    );
  });
});
