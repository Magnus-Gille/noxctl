import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalShadowObserver, loadLocalShadowConfig } from '../../src/shadow/local.js';
const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'noxctl-local-shadow-'));
  roots.push(root);
  const config = {
    version: 1 as const,
    profile: 'fixture',
    sourceCompany: 'synthetic-company',
    targetCompany: 'target',
    directory: join(root, 'queue'),
  };
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { root, config, path };
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe('explicit local capture binding', () => {
  it('rejects wrong profile and extra configuration, without accepting credentials', () => {
    const { config, path } = setup();
    expect(loadLocalShadowConfig(path, 'fixture')).toEqual(config);
    expect(() => loadLocalShadowConfig(path, 'other')).toThrow(/profile/);
    writeFileSync(path, JSON.stringify({ ...config, token: 'not-a-real-token' }));
    expect(() => loadLocalShadowConfig(path, 'fixture')).toThrow(/fields/);
  });
  it('refuses a write without a stable intent before any provider call', async () => {
    const { config } = setup();
    const getCompany = vi.fn();
    const invoke = vi.fn();
    const { observer, queue } = await createLocalShadowObserver(config, undefined, getCompany);
    await expect(observer.execute('createCustomer', [], invoke)).rejects.toThrow(/intent/);
    expect(invoke).not.toHaveBeenCalled();
    expect(getCompany).not.toHaveBeenCalled();
    expect(queue.status().items).toEqual([]);
    queue.close();
  });
  it('verifies the actual source company before capture/dispatch and rejects mismatches', async () => {
    const { config } = setup();
    const invoke = vi.fn();
    const { observer, queue } = await createLocalShadowObserver(config, 'stable', async () => ({
      OrganizationNumber: 'wrong',
    }));
    await expect(observer.execute('createCustomer', [], invoke)).rejects.toThrow(
      /company identity/,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(queue.status().items).toEqual([]);
    queue.close();
  });
  it('reuses per-command ordered identities after restart with no duplicate source write', async () => {
    const { config } = setup();
    const getCompany = vi.fn().mockResolvedValue({ OrganizationNumber: config.sourceCompany });
    const invoke = vi.fn().mockResolvedValue({ id: '1' });
    let runtime = await createLocalShadowObserver(config, 'stable', getCompany);
    await runtime.observer.execute('createCustomer', [{ Name: 'Synthetic' }], invoke);
    runtime.queue.close();
    runtime = await createLocalShadowObserver(config, 'stable', getCompany);
    await runtime.observer.execute('createCustomer', [{ Name: 'Synthetic' }], invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(runtime.queue.status().items[0].id).toBe('stable:0');
    runtime.queue.close();
  });
});
