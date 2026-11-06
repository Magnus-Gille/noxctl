import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import {
  backupCommand,
  baselineCustomerCommand,
  drainOneCommand,
  previewCommand,
  statusCommand,
} from '../../src/pilot/commands.js';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';
import { acquirePilotLock, PilotLockError } from '../../src/pilot/lock.js';
import { canonicalEncode, decode } from '../../src/shadow/codec.js';
import { connect, makeHost, ORG, stagedCreate, tempRoot, textOf } from './helpers.js';

type H = Awaited<ReturnType<typeof makeHost>>;
const jp = (dir: string) => join(dir, 'journal', 'dispatch.jsonl');
const pilotId = (dir: string) => readFileSync(join(dir, 'pilot-id'), 'utf8').trim();
const headPath = (h: { config: { directory: string }; headDir: string }) =>
  join(h.headDir, `${pilotId(h.config.directory)}.head.json`);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const lines = (dir: string) => readFileSync(jp(dir), 'utf8').split('\n').filter(Boolean);
const RECONCILE = /reconcil/i;

async function drain(h: H, id: string) {
  const preview = await previewCommand(h.host, id);
  return drainOneCommand(h.host, id, preview.hash!);
}
async function dispatched(root = tempRoot()) {
  const h = await makeHost({ root });
  await baselineCustomerCommand(h.host, '1');
  await baselineCustomerCommand(h.host, '2');
  const [a, b] = h.host.queue.snapshot().map((e) => e.record.id);
  expect((await drain(h, a!)).ok).toBe(true);
  expect((await drain(h, b!)).ok).toBe(true);
  return { h, root };
}
async function reopen(h: H) {
  await h.host.close();
  const r = await makeHost({ root: h.root });
  await statusCommand(r.host);
  return r;
}
/** Empty but valid databases, taken from the backup of a pristine pilot elsewhere. */
async function emptyDatabases() {
  const p = await makeHost();
  await backupCommand(p.host);
  const root = join(p.config.directory, 'backups');
  return join(root, readdirSync(root)[0]!);
}
function replaceDatabases(dir: string, snapshot: string, only?: 'queue') {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dir, 'queue', 'shadow.sqlite' + suffix), { force: true });
    if (!only) rmSync(join(dir, 'staged.sqlite' + suffix), { force: true });
  }
  copyFileSync(join(snapshot, 'shadow.sqlite'), join(dir, 'queue', 'shadow.sqlite'));
  if (!only) copyFileSync(join(snapshot, 'staged.sqlite'), join(dir, 'staged.sqlite'));
}

describe('finding 1: same JSON-RPC id cannot share or release a lock', () => {
  it('rejects a second in-flight request with the same id; the first keeps the lock', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => (started = resolve));
    let posts = 0;
    const synthetic = createSyntheticFortnox(ORG);
    const fortnox = {
      ...synthetic.transport,
      request: async (endpoint: string, options?: { method?: string }) => {
        if (options?.method === 'POST') {
          posts++;
          started();
          await hold;
        }
        return (synthetic.transport.request as (e: string, o?: unknown) => Promise<unknown>)(
          endpoint,
          options,
        );
      },
    } as unknown as FortnoxTransport;
    const h = await makeHost({ synthetic, fortnox });
    const client = await connect(h.host);
    const ids: string[] = [];
    for (const n of ['8', '9']) {
      const prepared = await client.callTool({
        name: 'staged_prepare',
        arguments: {
          tool: 'fortnox_create_customer',
          args: { Name: `X ${n}`, CustomerNumber: n, confirm: true },
        },
      });
      ids.push((JSON.parse(textOf(prepared as never)) as { id: string }).id);
    }
    await client.close();

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const responses: JSONRPCMessage[] = [];
    ct.onmessage = (message) => void responses.push(message);
    await h.host.staged.server.connect(h.host.wrapTransport(st));
    await ct.start();
    const call = (id: string) =>
      ct.send({
        jsonrpc: '2.0',
        id: 77,
        method: 'tools/call',
        params: { name: 'staged_execute', arguments: { id, confirm: true } },
      });
    const lock = join(h.config.directory, 'pilot.lock');
    await call(ids[0]!);
    await startedP;
    expect(existsSync(lock)).toBe(true);
    await call(ids[1]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 77, error: expect.anything() });
    expect(posts).toBe(1);
    // The rejected duplicate must not have released the first request's lock.
    expect(existsSync(lock)).toBe(true);
    expect((await backupCommand(h.host)).ok).toBe(false);
    expect((await baselineCustomerCommand(h.host, '5')).ok).toBe(false);
    expect(() => acquirePilotLock(h.config.directory, 'cli', 1)).toThrow(PilotLockError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({ id: 77, result: expect.anything() });
    expect('error' in responses[1]!).toBe(false);
    expect(existsSync(lock)).toBe(false);
    await ct.close();
  });
});

describe('finding 2: journal genesis, hash chain and independent head record', () => {
  it('initializes genesis, pilot-id and head, and advances chain and head', async () => {
    const { h } = await dispatched();
    const dir = h.config.directory;
    const all = lines(dir);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const id = pilotId(dir);
    expect(JSON.parse(all[0]!)).toMatchObject({ kind: 'genesis', pilotId: id });
    all.slice(1).forEach((line, index) => {
      expect(JSON.parse(line)).toMatchObject({ seq: index + 1, prev: sha(all[index]!) });
    });
    const head = JSON.parse(readFileSync(headPath(h), 'utf8'));
    expect(head).toEqual({ pilotId: id, seq: all.length - 1, hash: sha(all.at(-1)!) });
    expect(statSync(h.headDir).mode & 0o777).toBe(0o700);
    expect(statSync(headPath(h)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'pilot-id')).mode & 0o777).toBe(0o600);
    expect(await h.host.checkGate()).toEqual({ ok: true });
  });

  it('refuses a zero-length journal with restored pending records', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    writeFileSync(jp(h.config.directory), '');
    const r = await reopen(h);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses a journal truncated by its last line (head mismatch)', async () => {
    const { h } = await dispatched();
    const all = lines(h.config.directory);
    writeFileSync(jp(h.config.directory), `${all.slice(0, -1).join('\n')}\n`);
    const r = await reopen(h);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses a missing journal with restored empty databases after a real dispatch', async () => {
    const { h } = await dispatched();
    const snapshot = await emptyDatabases();
    await h.host.close();
    replaceDatabases(h.config.directory, snapshot);
    rmSync(jp(h.config.directory));
    const r = await makeHost({ root: h.root });
    await statusCommand(r.host);
    expect(existsSync(jp(r.config.directory))).toBe(false);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses a tampered middle line', async () => {
    const { h } = await dispatched();
    const all = lines(h.config.directory);
    all[1] = all[1]!.replace(/"at":\d+/, '"at":1');
    writeFileSync(jp(h.config.directory), `${all.join('\n')}\n`);
    const r = await reopen(h);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses when the head record is missing for an initialized pilot', async () => {
    const { h } = await dispatched();
    rmSync(headPath(h));
    const r = await reopen(h);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses when databases exist but pilot-id is missing, and does not re-initialize', async () => {
    const { h } = await dispatched();
    rmSync(join(h.config.directory, 'pilot-id'));
    const r = await reopen(h);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
    expect(existsSync(join(h.config.directory, 'pilot-id'))).toBe(false);
  });
});

describe('finding 3: a completed Fortnox write needs its queue record', () => {
  async function completed() {
    const root = tempRoot();
    const h = await makeHost({ root });
    const client = await connect(h.host);
    const done = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      CustomerNumber: '9',
    });
    expect(done.isError, textOf(done)).not.toBe(true);
    await client.close();
    expect(await h.host.checkGate()).toEqual({ ok: true });
    return h;
  }

  it('refuses a restored older (empty) shadow.sqlite after a completed execute', async () => {
    const h = await completed();
    const snapshot = await emptyDatabases();
    await h.host.close();
    replaceDatabases(h.config.directory, snapshot, 'queue');
    const r = await makeHost({ root: h.root });
    await statusCommand(r.host);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });

  it('refuses a deleted shadow.sqlite or staged.sqlite instead of recreating it', async () => {
    for (const file of [join('queue', 'shadow.sqlite'), 'staged.sqlite']) {
      const h = await completed();
      await h.host.close();
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(join(h.config.directory, file + suffix), { force: true });
      const r = await makeHost({ root: h.root });
      await statusCommand(r.host);
      const gate = await r.host.checkGate();
      expect(gate.ok, file).toBe(false);
      expect(JSON.stringify(gate)).toMatch(RECONCILE);
    }
  });

  it('refuses a queue record whose operation does not match the staged tool', async () => {
    const h = await completed();
    await h.host.close();
    const db = new DatabaseSync(join(h.config.directory, 'staged.sqlite'));
    const row = db.prepare('SELECT id,record FROM staged_calls').get()!;
    const record = decode(row.record as string) as Record<string, unknown>;
    record.tool = 'fortnox_create_invoice';
    db.prepare('UPDATE staged_calls SET record=? WHERE id=?').run(
      canonicalEncode(record),
      row.id as string,
    );
    db.close();
    const r = await makeHost({ root: h.root });
    await statusCommand(r.host);
    const gate = await r.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(RECONCILE);
  });
});

describe('finding 4: backups are durable before success is reported', () => {
  it('keeps the marker when an fsync fails, and fsyncs files and directories on success', async () => {
    let failing = false;
    let calls = 0;
    const h = await makeHost({
      fsync: () => {
        calls++;
        if (failing) throw new Error('EIO');
      },
    });
    const marker = join(h.config.directory, 'backup-pending');
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    failing = true;
    const result = await drainOneCommand(h.host, id, preview.hash!);
    // the journal append shares the failing fsync, so nothing was dispatched either
    expect(JSON.stringify(result)).toMatch(/backup failed/i);
    expect(existsSync(marker)).toBe(true);
    expect((await h.host.checkGate()).ok).toBe(false);
    expect((await backupCommand(h.host)).ok).toBe(false);
    expect(existsSync(marker)).toBe(true);
    failing = false;
    calls = 0;
    expect((await backupCommand(h.host)).ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(existsSync(marker)).toBe(false);
    expect(h.host.isStorageOk()).toBe(true);
  });

  it('refuses a corrupted or manifest-less newest backup until a new backup succeeds', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    const root = join(h.config.directory, 'backups');
    const newest = () => join(root, readdirSync(root).sort().at(-1)!);
    expect((await backupCommand(h.host)).ok).toBe(true);
    expect(await h.host.checkGate()).toEqual({ ok: true });
    appendFileSync(join(newest(), 'shadow.sqlite'), 'x');
    const gate = await h.host.checkGate();
    expect(gate.ok).toBe(false);
    expect(JSON.stringify(gate)).toMatch(/backup/i);
    expect((await backupCommand(h.host)).ok).toBe(true);
    expect(await h.host.checkGate()).toEqual({ ok: true });
    rmSync(join(newest(), 'manifest.json'));
    expect((await h.host.checkGate()).ok).toBe(false);
    expect((await backupCommand(h.host)).ok).toBe(true);
    expect(await h.host.checkGate()).toEqual({ ok: true });
  });
});
