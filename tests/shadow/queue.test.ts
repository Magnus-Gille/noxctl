import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShadowQueue, canonicalEncode } from '../../src/shadow/queue.js';
import { TargetNotDispatchedError } from '../../src/shadow/types.js';
import type { ShadowAdapter } from '../../src/shadow/types.js';

const roots: string[] = [];
const binding = { sourceCompany: 'fixture-source', targetCompany: 'fixture-target' };
const intent = { id: 'intent-1', operation: 'createCustomer', args: [{ Name: 'Fixture' }] };
function directory() {
  const p = mkdtempSync(join(tmpdir(), 'noxctl-shadow-'));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function adapter(): ShadowAdapter {
  return {
    prepare: () => ({ request: { name: 'Fixture' } }),
    apply: vi.fn().mockResolvedValue({ targetId: 'target-1', receipt: { id: 'target-1' } }),
    verify: vi.fn().mockResolvedValue(true),
  };
}

describe('durable source-first queue', () => {
  it('persists source confirmation, survives restart, and never repeats a confirmed intent', async () => {
    const root = directory();
    let q = await openShadowQueue(root, binding);
    const upstream = vi.fn().mockResolvedValue({ CustomerNumber: '7' });
    expect(await q.execute(intent, upstream)).toEqual({ CustomerNumber: '7' });
    expect(q.status().counts.pending).toBe(1);
    q.close();
    q = await openShadowQueue(root, binding);
    expect(await q.execute(intent, upstream)).toEqual({ CustomerNumber: '7' });
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(q.execute({ ...intent, args: [{ Name: 'Different' }] }, upstream)).rejects.toThrow(
      /conflict/i,
    );
    q.close();
    await expect(openShadowQueue(root, { ...binding, targetCompany: 'other' })).rejects.toThrow(
      /binding/i,
    );
  });
  it('persists before dispatch and exposes unknown source outcomes without replay', async () => {
    const root = directory();
    let q = await openShadowQueue(root, binding);
    const call = vi.fn(async () => {
      expect(q.status().counts.source_in_flight).toBe(1);
      throw new Error('timeout');
    });
    await expect(q.execute(intent, call)).rejects.toThrow('timeout');
    q.close();
    q = await openShadowQueue(root, binding);
    expect(q.status().counts.source_unknown).toBe(1);
    await expect(q.execute(intent, call)).rejects.toThrow(/unknown/i);
    expect(call).toHaveBeenCalledTimes(1);
    q.close();
  });
  it('rejects competing dispatch across two connections while first source call is running', async () => {
    const root = directory();
    const q1 = await openShadowQueue(root, binding);
    const q2 = await openShadowQueue(root, binding);
    let finish!: (value: unknown) => void;
    const first = q1.execute(
      intent,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(q2.execute(intent, vi.fn())).rejects.toThrow(/unknown|in.flight/i);
    finish({ CustomerNumber: '8' });
    await first;
    expect(q2.status().counts.pending).toBe(1);
    q1.close();
    q2.close();
  });
  it('continues upstream during target outage and holds unknown target ahead of dependent operations', async () => {
    const q = await openShadowQueue(directory(), binding);
    await q.execute(intent, async () => ({ CustomerNumber: '1' }));
    const a = adapter();
    vi.mocked(a.apply).mockRejectedValue(new Error('offline'));
    await q.drainOne(a);
    await q.execute({ ...intent, id: 'intent-2' }, async () => ({ CustomerNumber: '2' }));
    expect(q.status().counts.target_unknown).toBe(1);
    expect(q.status().counts.pending).toBe(1);
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    q.close();
  });
  it('never retries an unknown outcome after 24 hours, a restart, or a missing cache', async () => {
    let now = 1000;
    const root = directory();
    let q = await openShadowQueue(root, binding, () => now);
    await q.execute(intent, async () => ({}));
    const a = adapter();
    vi.mocked(a.apply).mockRejectedValue(new Error('cache missing'));
    await q.drainOne(a);
    q.close();
    now += 48 * 3600 * 1000;
    q = await openShadowQueue(root, binding, () => now);
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(q.status().oldestUnappliedAgeMs).toBe(48 * 3600 * 1000);
    q.close();
  });
  it('retains unsupported operations as visible blocked records with zero target calls', async () => {
    const q = await openShadowQueue(directory(), binding);
    await q.execute(intent, async () => ({}));
    const a = adapter();
    a.prepare = () => ({ blocked: 'unsupported fields' });
    await q.drainOne(a);
    expect(q.status().items[0]).toMatchObject({ state: 'blocked', reason: 'unsupported fields' });
    expect(a.apply).not.toHaveBeenCalled();
    q.close();
  });
  it('persists target identity/receipt and verifies it only with a read', async () => {
    const root = directory();
    let q = await openShadowQueue(root, binding);
    await q.execute(intent, async () => ({}));
    const a = adapter();
    await q.drainOne(a);
    q.close();
    q = await openShadowQueue(root, binding);
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(q.get(intent.id)).toMatchObject({
      state: 'applied',
      targetId: 'target-1',
      targetReceipt: { id: 'target-1' },
    });
    expect(await q.verifyApplied(intent.id, a)).toBe(true);
    expect(a.verify).toHaveBeenCalledTimes(1);
    q.close();
  });
  it('does not dispatch without a writable durable store or serialize unsafe inputs', async () => {
    const root = directory();
    chmodSync(root, 0o755);
    await expect(openShadowQueue(root, binding)).rejects.toThrow(/private/i);
    const q = await openShadowQueue(directory(), binding);
    const fn = vi.fn();
    await expect(q.execute({ ...intent, args: [Infinity] }, fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
    q.close();
  });
  it('canonicalizes keys but distinguishes types and preserves binary/undefined results', async () => {
    expect(canonicalEncode({ z: 1, a: 2 })).toBe(canonicalEncode({ a: 2, z: 1 }));
    expect(canonicalEncode(Buffer.from('x'))).not.toBe(
      canonicalEncode({ type: 'Buffer', data: [120] }),
    );
    const q = await openShadowQueue(directory(), binding);
    const result = { bytes: Buffer.from('pdf'), optional: undefined };
    await q.execute(intent, async () => result);
    expect(await q.execute(intent, vi.fn())).toEqual(result);
    q.close();
  });
  it('retries only proven pre-dispatch outages with durable backoff and no blocked source work', async () => {
    let now = 1000;
    const root = directory();
    let q = await openShadowQueue(root, binding, () => now);
    await q.execute(intent, async () => ({}));
    const a = adapter();
    vi.mocked(a.apply).mockRejectedValueOnce(new TargetNotDispatchedError());
    await q.drainOne(a);
    expect(q.status().counts.retry_wait).toBe(1);
    await q.execute({ ...intent, id: 'intent-2' }, async () => ({}));
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(1);
    q.close();
    q = await openShadowQueue(root, binding, () => now);
    now += 1000;
    await q.drainOne(a);
    expect(a.apply).toHaveBeenCalledTimes(2);
    expect(q.get(intent.id)?.state).toBe('applied');
    q.close();
  });
  it('can reconcile a known target receipt with reads and never sends a second mutation', async () => {
    const root = directory();
    const q = await openShadowQueue(root, binding);
    await q.execute(intent, async () => ({}));
    const { DatabaseSync } = await import('node:sqlite');
    const fault = new DatabaseSync(join(root, 'shadow.sqlite'));
    fault.exec(
      "CREATE TRIGGER fail_ack BEFORE UPDATE ON intents WHEN NEW.state='applied' BEGIN SELECT RAISE(FAIL, 'synthetic fault'); END;",
    );
    const a = adapter();
    await q.drainOne(a);
    fault.exec('DROP TRIGGER fail_ack');
    fault.close();
    expect(await q.reconcileTarget(intent.id, a)).toBe(true);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(a.verify).toHaveBeenCalledTimes(1);
    expect(q.status().counts.applied).toBe(1);
    q.close();
  });
  it('revalidates only a mapping-blocked intent before any target attempt, preserving source receipt and hash', async () => {
    const q = await openShadowQueue(directory(), binding);
    const upstream = vi.fn().mockResolvedValue({ CustomerNumber: '7' });
    await q.execute(intent, upstream);
    const a = adapter();
    const blocked = { ...a, prepare: () => ({ blocked: 'Missing mapping' }) };
    await q.drainOne(blocked);
    const original = q.get(intent.id);
    expect(q.revalidateBlocked(intent.id, blocked)).toBe(false);
    expect(q.get(intent.id)).toEqual(original);
    expect(q.revalidateBlocked(intent.id, a)).toBe(true);
    expect(q.get(intent.id)).toMatchObject({
      state: 'pending',
      requestHash: original!.requestHash,
      sourceResult: original!.sourceResult,
    });
    expect(a.apply).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(q.revalidateBlocked(intent.id, a)).toBe(false);
    expect(await q.drainOne(a)).toBe(true);
    expect(a.apply).toHaveBeenCalledTimes(1);
    q.close();
  });

  it('cannot reopen an unknown outcome or applied-record drift as a mapping block', async () => {
    const q = await openShadowQueue(directory(), binding);
    await q.execute(intent, async () => ({ CustomerNumber: '7' }));
    const a = adapter();
    a.apply = vi.fn().mockRejectedValue(new Error('unknown'));
    await q.drainOne(a);
    expect(q.revalidateBlocked(intent.id, adapter())).toBe(false);
    const next = { ...intent, id: 'next' };
    await q.execute(next, async () => ({ CustomerNumber: '8' }));
    // A separate queue supplies a real applied -> readback-drift transition.
    const q2 = await openShadowQueue(directory(), binding);
    await q2.execute(intent, async () => ({ CustomerNumber: '7' }));
    const applied = adapter();
    await q2.drainOne(applied);
    applied.verify = vi.fn().mockResolvedValue(false);
    await q2.verifyApplied(intent.id, applied);
    expect(q2.get(intent.id)?.state).toBe('blocked');
    expect(q2.revalidateBlocked(intent.id, adapter())).toBe(false);
    q.close();
    q2.close();
  });

  it('keeps a mapping block intact when the new translation throws or is not serializable', async () => {
    const q = await openShadowQueue(directory(), binding);
    await q.execute(intent, async () => ({ CustomerNumber: '7' }));
    const a = adapter();
    await q.drainOne({ ...a, prepare: () => ({ blocked: 'Missing mapping' }) });
    const original = q.get(intent.id);
    expect(() =>
      q.revalidateBlocked(intent.id, {
        ...a,
        prepare: () => {
          throw new Error('invalid');
        },
      }),
    ).toThrow('invalid');
    expect(() =>
      q.revalidateBlocked(intent.id, { ...a, prepare: () => ({ request: () => 1 }) }),
    ).toThrow();
    expect(q.get(intent.id)).toEqual(original);
    expect(a.apply).not.toHaveBeenCalled();
    q.close();
  });
});
