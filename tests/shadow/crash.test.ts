import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openShadowQueue, SourceReceiptPersistenceError } from '../../src/shadow/queue.js';
import type { ShadowAdapter } from '../../src/shadow/types.js';
const roots: string[] = [];
const binding = { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' };
const intent = { id: 'crash-1', operation: 'createCustomer', args: [{ Name: 'Synthetic' }] };
function directory() {
  const p = mkdtempSync(join(tmpdir(), 'noxctl-crash-'));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/shadow/queue.js')).href;
function crash(root: string, phase: 'source' | 'target') {
  const script = `import {openShadowQueue} from ${JSON.stringify(moduleUrl)};
  import {writeFileSync} from 'node:fs';
  const q=await openShadowQueue(${JSON.stringify(root)},${JSON.stringify(binding)});
  const effect=()=>{writeFileSync(${JSON.stringify(join(root, 'effect'))},'once');process.kill(process.pid,'SIGKILL');return new Promise(()=>{});};
  ${phase === 'source' ? `await q.execute(${JSON.stringify(intent)},effect);` : 'await q.drainOne({prepare:()=>({request:{}}),apply:effect});'}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: '/usr/bin:/bin', HOME: root },
    timeout: 10000,
    encoding: 'utf8',
  });
  expect(child.signal, child.stderr).toBe('SIGKILL');
  expect(readFileSync(join(root, 'effect'), 'utf8')).toBe('once');
}

describe('real crash and receipt failure boundaries', () => {
  it('retains an interrupted source claim and refuses replay after process death', async () => {
    const root = directory();
    crash(root, 'source');
    const q = await openShadowQueue(root, binding);
    expect(q.status().counts.source_in_flight).toBe(1);
    const upstream = vi.fn();
    await expect(q.execute(intent, upstream)).rejects.toThrow(/unknown|in flight/i);
    expect(upstream).not.toHaveBeenCalled();
    q.close();
  });
  it('retains an interrupted target claim and never repeats it after process death', async () => {
    const root = directory();
    let q = await openShadowQueue(root, binding);
    await q.execute(intent, async () => ({}));
    q.close();
    crash(root, 'target');
    q = await openShadowQueue(root, binding);
    const apply = vi.fn();
    expect(q.status().counts.target_in_flight).toBe(1);
    await q.drainOne({ prepare: () => ({ request: {} }), apply });
    expect(apply).not.toHaveBeenCalled();
    q.close();
  });
  it('reports actual source success when durable acknowledgement fails, without replay', async () => {
    const root = directory();
    const q = await openShadowQueue(root, binding);
    const fault = new DatabaseSync(join(root, 'shadow.sqlite'));
    fault.exec(
      "CREATE TRIGGER fail_source_receipt BEFORE UPDATE ON intents WHEN NEW.state='pending' BEGIN SELECT RAISE(FAIL, 'synthetic disk failure'); END;",
    );
    const upstream = vi.fn().mockResolvedValue({ CustomerNumber: '9' });
    await expect(q.execute(intent, upstream)).rejects.toBeInstanceOf(SourceReceiptPersistenceError);
    fault.exec('DROP TRIGGER fail_source_receipt');
    fault.close();
    await expect(q.execute(intent, upstream)).rejects.toThrow(/unknown|in flight/i);
    expect(upstream).toHaveBeenCalledTimes(1);
    q.close();
  });
  it('keeps target receipt/identity when acknowledgement fails, and does not retry', async () => {
    const root = directory();
    const q = await openShadowQueue(root, binding);
    await q.execute(intent, async () => ({}));
    const fault = new DatabaseSync(join(root, 'shadow.sqlite'));
    fault.exec(
      "CREATE TRIGGER fail_target_receipt BEFORE UPDATE ON intents WHEN NEW.state='applied' BEGIN SELECT RAISE(FAIL, 'synthetic disk failure'); END;",
    );
    const a: ShadowAdapter = {
      prepare: () => ({ request: {} }),
      apply: vi.fn().mockResolvedValue({ targetId: 'known-id', receipt: { id: 'known-id' } }),
    };
    expect(await q.drainOne(a)).toBe(false);
    expect(q.get(intent.id)).toMatchObject({ state: 'target_unknown', targetId: 'known-id' });
    fault.exec('DROP TRIGGER fail_target_receipt');
    fault.close();
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    q.close();
  });
  it('has no effect before durable dispatch if process exits before calling execute', async () => {
    const root = directory();
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {openShadowQueue} from ${JSON.stringify(moduleUrl)}; const q=await openShadowQueue(${JSON.stringify(root)},${JSON.stringify(binding)});process.kill(process.pid,'SIGKILL');`,
      ],
      { env: { HOME: root }, timeout: 10000 },
    );
    expect(child.signal).toBe('SIGKILL');
    expect(existsSync(join(root, 'effect'))).toBe(false);
    const q = await openShadowQueue(root, binding);
    expect(q.status().items).toEqual([]);
    const upstream = vi.fn().mockResolvedValue({});
    await q.execute(intent, upstream);
    expect(upstream).toHaveBeenCalledTimes(1);
    q.close();
  });
});
