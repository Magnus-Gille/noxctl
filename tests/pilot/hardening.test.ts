import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupCommand,
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
  previewHash,
  statusCommand,
} from '../../src/pilot/commands.js';
import {
  ARTICLE_UUID,
  connect,
  fakeAccounted,
  invoiceArgs,
  makeHost,
  stagedCreate,
  tempRoot,
  textOf,
} from './helpers.js';
import type { PilotHost } from '../../src/pilot/host.js';
import { ShadowRecord } from '../../src/shadow/types.js';

const posts = (h: { accounted: ReturnType<typeof fakeAccounted> }) =>
  h.accounted.calls.filter((c) => c.method === 'POST').length;

async function twoPending() {
  const h = await makeHost();
  await baselineCustomerCommand(h.host, '1');
  await baselineCustomerCommand(h.host, '2');
  const [a, b] = h.host.queue.snapshot().map((e) => e.record);
  return { ...h, a: a!, b: b! };
}

describe('finding 1: drain claims exactly the previewed record and request', () => {
  it('a second drain validated against the same preview cannot dispatch the next record', async () => {
    const h = await twoPending();
    const preview = await previewCommand(h.host, h.a.id);
    const adapter = h.host.adapterFor('baselineCustomer')!;
    const digestOf = (r: ShadowRecord, request: unknown) => previewHash(h.host, r, request);
    const first = await h.host.queue.drainExpected(adapter, {
      id: h.a.id,
      expectedDigest: preview.hash!,
      digestOf,
    });
    expect(first).toMatchObject({ claimed: true, applied: true });
    const second = await h.host.queue.drainExpected(adapter, {
      id: h.a.id,
      expectedDigest: preview.hash!,
      digestOf,
    });
    expect(second.claimed).toBe(false);
    expect(h.host.queue.get(h.b.id)!.state).toBe('pending');
    expect(posts(h)).toBe(1);
  });

  it('refuses a digest mismatch or a non-oldest id without claiming anything', async () => {
    const h = await twoPending();
    const preview = await previewCommand(h.host, h.a.id);
    const adapter = h.host.adapterFor('baselineCustomer')!;
    const digestOf = (r: ShadowRecord, request: unknown) => previewHash(h.host, r, request);
    const wrong = await h.host.queue.drainExpected(adapter, {
      id: h.a.id,
      expectedDigest: 'f'.repeat(64),
      digestOf,
    });
    expect(wrong.claimed).toBe(false);
    const notOldest = await h.host.queue.drainExpected(adapter, {
      id: h.b.id,
      expectedDigest: preview.hash!,
      digestOf,
    });
    expect(notOldest.claimed).toBe(false);
    expect(h.host.queue.get(h.a.id)).toMatchObject({ state: 'pending' });
    expect(h.host.queue.get(h.b.id)).toMatchObject({ state: 'pending' });
    expect(posts(h)).toBe(0);
  });

  it('two concurrent drain-one commands: one completes, the other dispatches nothing', async () => {
    const h = await twoPending();
    const preview = await previewCommand(h.host, h.a.id);
    const results = await Promise.all([
      drainOneCommand(h.host, h.a.id, preview.hash!),
      drainOneCommand(h.host, h.a.id, preview.hash!),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.host.queue.get(h.b.id)!.state).toBe('pending');
    expect(posts(h)).toBe(1);
  });
});

describe('finding 2: cross-process lock and on-disk storage health', () => {
  it('refuses mutations and backup while the lock exists, never deleting it', async () => {
    const h = await makeHost();
    const lock = join(h.config.directory, 'pilot.lock');
    writeFileSync(lock, JSON.stringify({ pid: 1, command: 'other', startedAt: 1 }), {
      mode: 0o600,
    });
    const baseline = await baselineCustomerCommand(h.host, '1');
    expect(baseline.ok).toBe(false);
    expect(baseline.message).toMatch(/lock/i);
    expect((await backupCommand(h.host)).ok).toBe(false);
    expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(h.host.queue.snapshot()).toHaveLength(0);
    rmSync(lock);
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('a mutation in progress blocks a concurrent backup; lock holds pid/command/startedAt', async () => {
    const h = await makeHost();
    const lock = join(h.config.directory, 'pilot.lock');
    await h.host.withLock('probe', async () => {
      const body = JSON.parse(readFileSync(lock, 'utf8'));
      expect(body).toMatchObject({ pid: process.pid, command: 'probe' });
      expect(typeof body.startedAt).toBe('number');
      expect(statSync(lock).mode & 0o777).toBe(0o600);
      expect((await backupCommand(h.host)).ok).toBe(false);
    });
    expect(existsSync(lock)).toBe(false);
    expect((await backupCommand(h.host)).ok).toBe(true);
  });

  it('releases the lock when the mutation throws', async () => {
    const h = await makeHost();
    await expect(
      h.host.withLock('boom', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(existsSync(join(h.config.directory, 'pilot.lock'))).toBe(false);
  });

  it('the gate re-reads the backup-pending marker from disk at every check', async () => {
    const h = await makeHost();
    expect(await h.host.checkGate()).toEqual({ ok: true });
    const marker = join(h.config.directory, 'backup-pending');
    writeFileSync(marker, '1', { mode: 0o600 }); // another process began a mutation
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    expect(h.host.isStorageOk()).toBe(false);
    const client = await connect(h.host);
    const refused = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      CustomerNumber: '9',
    });
    expect(refused.isError).toBe(true);
    rmSync(marker);
    expect(await h.host.checkGate()).toEqual({ ok: true });
    await client.close();
  });

  it('a staged execute holds the lock and refuses when another process holds it', async () => {
    const h = await makeHost();
    const client = await connect(h.host);
    const lock = join(h.config.directory, 'pilot.lock');
    writeFileSync(lock, '{}', { mode: 0o600 });
    const refused = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      CustomerNumber: '9',
    });
    expect(refused.isError).toBe(true);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    const ok = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      CustomerNumber: '9',
    });
    expect(ok.isError, textOf(ok)).not.toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(h.config.directory, 'backups')).length).toBeGreaterThan(0);
    await client.close();
  });
});

function restoreFrom(h: { config: { directory: string }; host: PilotHost }, snapshot: string) {
  return async () => {
    await h.host.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(h.config.directory, 'staged.sqlite' + suffix), { force: true });
      rmSync(join(h.config.directory, 'queue', 'shadow.sqlite' + suffix), { force: true });
    }
    copyFileSync(join(snapshot, 'staged.sqlite'), join(h.config.directory, 'staged.sqlite'));
    copyFileSync(
      join(snapshot, 'shadow.sqlite'),
      join(h.config.directory, 'queue', 'shadow.sqlite'),
    );
  };
}
const latestBackup = (directory: string) => {
  const root = join(directory, 'backups');
  return join(root, readdirSync(root).sort().at(-1)!);
};

describe('finding 3: dispatch journal survives restore', () => {
  const journalPath = (directory: string) => join(directory, 'journal', 'dispatch.jsonl');

  it('journals the target intent (0600/0700) before the POST is sent', async () => {
    let atPost = '';
    let dir = '';
    const accounted = fakeAccounted({
      onPost: () => {
        atPost = readFileSync(journalPath(dir), 'utf8');
      },
    });
    const h = await makeHost({ accounted });
    dir = h.config.directory;
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    expect((await drainOneCommand(h.host, id, preview.hash!)).ok).toBe(true);
    const entry = JSON.parse(atPost.trim().split('\n').at(-1)!);
    expect(entry).toMatchObject({ kind: 'target', intentId: id });
    expect(entry.requestHash).toBe(h.host.queue.get(id)!.requestHash);
    expect(statSync(journalPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'journal')).mode & 0o777).toBe(0o700);
  });

  it('a failed journal append prevents the POST and leaves the record not dispatched', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    chmodSync(journalPath(h.config.directory), 0o400);
    const drained = await drainOneCommand(h.host, id, preview.hash!);
    expect(drained.ok).toBe(false);
    expect(posts(h)).toBe(0);
    expect(h.host.queue.get(id)!.state).toBe('retry_wait');
  });

  it.each([
    ['a successful POST', false],
    ['an uncertain POST', true],
  ])(
    'restoring a pre-POST backup after %s is refused and cannot dispatch',
    async (_n, uncertain) => {
      const root = tempRoot();
      const accounted = fakeAccounted({ postFailsAfterStore: uncertain });
      const h = await makeHost({ root, accounted });
      await baselineCustomerCommand(h.host, '1');
      const id = h.host.queue.snapshot()[0]!.record.id;
      const snapshot = latestBackup(h.config.directory); // pre-POST
      const preview = await previewCommand(h.host, id);
      await drainOneCommand(h.host, id, preview.hash!);
      expect(posts(h)).toBe(1);
      await restoreFrom(h, snapshot)();
      const restored = await makeHost({ root, accounted });
      await statusCommand(restored.host); // acknowledge: the journal alone must refuse
      expect(restored.host.queue.get(id)!.state).toBe('pending');
      const gate = await restored.host.checkGate(id);
      expect(gate.ok).toBe(false);
      expect(JSON.stringify(gate)).toMatch(/reconcil/i);
      const again = await previewCommand(restored.host, id);
      const drained = await drainOneCommand(restored.host, id, again.hash!);
      expect(drained.ok).toBe(false);
      expect(posts(restored)).toBe(1);
    },
  );

  it('restoring a pre-execute staged backup is refused', async () => {
    const root = tempRoot();
    const h = await makeHost({ root });
    const client = await connect(h.host);
    const prepared = await client.callTool({
      name: 'staged_prepare',
      arguments: {
        tool: 'fortnox_create_customer',
        args: { Name: 'X AB', CustomerNumber: '9', confirm: true },
      },
    });
    const { id } = JSON.parse(textOf(prepared as never)) as { id: string };
    expect((await backupCommand(h.host)).ok).toBe(true);
    const snapshot = latestBackup(h.config.directory);
    const executed = await client.callTool({
      name: 'staged_execute',
      arguments: { id, confirm: true },
    });
    expect(executed.isError, textOf(executed as never)).not.toBe(true);
    expect(readFileSync(journalPath(h.config.directory), 'utf8')).toContain(
      `"kind":"source","stagedId":"${id}"`,
    );
    await client.close();
    await restoreFrom(h, snapshot)();
    const restored = await makeHost({ root });
    await statusCommand(restored.host);
    const gate = await restored.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(/reconcil/i);
  });

  it('refuses when the journal is missing while state exists, and never recreates it silently', async () => {
    const root = tempRoot();
    const h = await makeHost({ root });
    await baselineCustomerCommand(h.host, '1');
    rmSync(journalPath(h.config.directory));
    const gate = await h.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(/journal/i);
  });

  it('ends a legitimate not-dispatched retry_wait without a rollback refusal', async () => {
    const h = await makeHost({ accounted: fakeAccounted({ companies: [] }) });
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    await drainOneCommand(h.host, id, preview.hash!);
    expect(h.host.queue.get(id)!.state).toBe('retry_wait');
    const gate = await h.host.checkGate(id);
    expect(JSON.stringify(gate)).not.toMatch(/reconcil/i);
  });
});

void invoiceArgs;
