import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backupCommand,
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
  reconcileCommand,
  statusCommand,
} from '../../src/pilot/commands.js';
import { loadPilotConfig } from '../../src/pilot/host.js';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';
import {
  ARTICLE_UUID,
  BASE_TIME,
  COMPANY,
  ORG,
  connect,
  configFor,
  fakeAccounted,
  invoiceArgs,
  makeHost,
  stagedCreate,
  tempRoot,
  textOf,
} from './helpers.js';

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('config', () => {
  it('requires a private, strict, complete file', () => {
    const root = tempRoot();
    const { path } = configFor(root);
    expect(loadPilotConfig(path)).toMatchObject({ targetCompany: COMPANY, sourceCompany: ORG });
    chmodSync(path, 0o666);
    expect(() => loadPilotConfig(path)).toThrow();
    chmodSync(path, 0o600);
    for (const bad of [
      { extra: 1 },
      { targetCompany: 'not-a-uuid' },
      { accountedOrigin: 'http://a.test' },
      { accountedOrigin: 'https://a.test/x' },
      { directory: 'relative/path' },
      { revision: 'abc' },
      { keychainService: '' },
      { version: 2 },
    ]) {
      const { path: p } = configFor(root, bad);
      expect(() => loadPilotConfig(p)).toThrow();
    }
  });
});

describe('preview and drain-one', () => {
  async function pendingCustomer() {
    const h = await makeHost();
    const baseline = await baselineCustomerCommand(h.host, '1');
    expect(baseline.ok).toBe(true);
    const id = h.host.queue.snapshot()[0]!.record.id;
    return { ...h, id };
  }

  it('preview prints the request and writes a private preview file', async () => {
    const h = await pendingCustomer();
    const preview = await previewCommand(h.host, h.id);
    expect(preview.ok).toBe(true);
    expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(preview.request)).toContain('customer_number');
    const file = join(h.config.directory, 'previews', `${h.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      hash: preview.hash,
      createdAt: BASE_TIME,
      osUser: 'pilot-operator',
    });
    expect(h.accounted.calls).toEqual([]);
  });

  it('happy path: drain applies, writes a verified two-database backup, uses one POST', async () => {
    const h = await pendingCustomer();
    const preview = await previewCommand(h.host, h.id);
    const drained = await drainOneCommand(h.host, h.id, preview.hash!);
    expect(drained).toMatchObject({ ok: true, state: 'applied' });
    expect(h.host.queue.get(h.id)).toMatchObject({ state: 'applied' });
    expect(h.accounted.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const backups = join(h.config.directory, 'backups');
    const [stamp] = readdirSync(backups);
    const dir = join(backups, stamp!);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(Object.keys(manifest.files).sort()).toEqual(['shadow.sqlite', 'staged.sqlite']);
    for (const name of ['staged.sqlite', 'shadow.sqlite']) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      expect(manifest.files[name].sha256).toBe(sha(join(dir, name)));
    }
    // single use: the preview file is consumed
    expect(existsSync(join(h.config.directory, 'previews', `${h.id}.json`))).toBe(false);
    const status = await statusCommand(h.host);
    expect(status.message).toContain(h.accounted.customers.keys().next().value);
  });

  it('refuses wrong hash, stale preview, other user, drift and non-oldest ids with no network', async () => {
    const h = await pendingCustomer();
    await baselineCustomerCommand(h.host, '2');
    const second = h.host.queue.snapshot()[1]!.record.id;
    expect((await previewCommand(h.host, second)).ok).toBe(false);
    const preview = await previewCommand(h.host, h.id);
    expect((await drainOneCommand(h.host, h.id, 'f'.repeat(64))).ok).toBe(false);
    expect((await drainOneCommand(h.host, second, preview.hash!)).ok).toBe(false);

    // stale
    h.clock.now += 15 * 60_000 + 1;
    expect((await drainOneCommand(h.host, h.id, preview.hash!)).ok).toBe(false);
    h.clock.now = BASE_TIME;

    // other OS user
    const file = join(h.config.directory, 'previews', `${h.id}.json`);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), osUser: 'someone-else' }));
    expect((await drainOneCommand(h.host, h.id, preview.hash!)).ok).toBe(false);
    writeFileSync(file, original);

    // changed record: a different hash than the file/arg
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), hash: 'e'.repeat(64) }));
    expect((await drainOneCommand(h.host, h.id, preview.hash!)).ok).toBe(false);
    writeFileSync(file, original);

    expect(h.accounted.calls).toEqual([]);
    expect(h.host.queue.get(h.id)!.state).toBe('pending');
    // still drainable after all the refusals
    expect((await drainOneCommand(h.host, h.id, preview.hash!)).ok).toBe(true);
  });

  it('detects drift of the source between preview and drain', async () => {
    const h = await pendingCustomer();
    const preview = await previewCommand(h.host, h.id);
    // simulate a changed durable record behind the preview
    const record = h.host.queue.snapshot()[0]!.record;
    const original = record.sourceResult as Record<string, unknown>;
    expect(original).toBeDefined();
    const db = (
      h.host.queue as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }
    ).db;
    const changed = { ...record, sourceResult: { ...original, Name: 'Changed AB' } };
    const { canonicalEncode } = await import('../../src/shadow/codec.js');
    db.prepare('UPDATE intents SET record=? WHERE id=?').run(canonicalEncode(changed), h.id);
    expect((await drainOneCommand(h.host, h.id, preview.hash!)).ok).toBe(false);
    expect(h.accounted.calls).toEqual([]);
  });

  it('refuses unsupported operations', async () => {
    const h = await makeHost();
    await h.host.queue.execute(
      { id: 'x-supplier', operation: 'createSupplier', args: [] },
      async () => ({}),
    );
    expect((await previewCommand(h.host, 'x-supplier')).ok).toBe(false);
  });
});

describe('end to end with article-linked invoice', () => {
  it('baselines, links, creates via MCP, drains strictly in order', async () => {
    const h = await makeHost();
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
    expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(true);
    const client = await connect(h.host);
    const executed = await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
    expect(executed.isError, textOf(executed)).not.toBe(true);
    // backup after a successful staged execute
    expect(readdirSync(join(h.config.directory, 'backups')).length).toBeGreaterThanOrEqual(1);
    const [c, a, inv] = h.host.queue.snapshot().map((e) => e.record);
    expect(inv!.operation).toBe('createInvoice');

    // the invoice cannot jump the queue
    expect((await previewCommand(h.host, inv!.id)).ok).toBe(false);
    for (const record of [c!, a!, inv!]) {
      const preview = await previewCommand(h.host, record.id);
      expect(preview.ok, preview.message).toBe(true);
      const drained = await drainOneCommand(h.host, record.id, preview.hash!);
      expect(drained, drained.message).toMatchObject({ ok: true, state: 'applied' });
    }
    expect(
      h.accounted.calls.filter((x) => x.method === 'POST').map((x) => x.url.split('/').pop()),
    ).toEqual(['customers', 'invoices']);
    const status = await statusCommand(h.host);
    expect(status.message).toMatch(/A-1/);
    await client.close();
  });

  it('refuses to drain an invoice that changed, was booked or sent in Fortnox', async () => {
    for (const patch of [{ Booked: true }, { Sent: true }, { Cancelled: true }, { Net: 1 }]) {
      const h = await makeHost();
      await baselineCustomerCommand(h.host, '1');
      await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID);
      const client = await connect(h.host);
      await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
      for (const entry of h.host.queue.snapshot().slice(0, 2)) {
        const p = await previewCommand(h.host, entry.record.id);
        await drainOneCommand(h.host, entry.record.id, p.hash!);
      }
      const invoice = h.host.queue.snapshot()[2]!.record;
      const preview = await previewCommand(h.host, invoice.id);
      expect(preview.ok, preview.message).toBe(true);
      Object.assign(h.synthetic.state.invoices.get('1')!, patch);
      const posts = h.accounted.calls.filter((x) => x.method === 'POST').length;
      const drained = await drainOneCommand(h.host, invoice.id, preview.hash!);
      expect(drained.ok).toBe(false);
      expect(h.accounted.calls.filter((x) => x.method === 'POST').length).toBe(posts);
      expect(h.host.queue.get(invoice.id)!.state).toBe('pending');
      await client.close();
    }
  });

  it('reports (does not undo) a Fortnox change that happens during the drain', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID);
    const client = await connect(h.host);
    await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
    for (const entry of h.host.queue.snapshot().slice(0, 2)) {
      const p = await previewCommand(h.host, entry.record.id);
      await drainOneCommand(h.host, entry.record.id, p.hash!);
    }
    const invoice = h.host.queue.snapshot()[2]!.record;
    const preview = await previewCommand(h.host, invoice.id);
    // flip Sent when Accounted receives the POST
    h.accounted.state.onPost = () => {
      h.synthetic.state.invoices.get('1')!.Sent = true;
    };
    const drained = await drainOneCommand(h.host, invoice.id, preview.hash!);
    expect(h.host.queue.get(invoice.id)!.state).toBe('applied');
    expect(drained.ok).toBe(true);
    expect(drained.warnings?.join(' ')).toMatch(/changed/i);
    await client.close();
  });
});

describe('gate-driven refusals', () => {
  it('Fortnox organisation mismatch denies staged writes and calls no Fortnox write', async () => {
    const stderr: string[] = [];
    const h = await makeHost({ stderr });
    const client = await connect(h.host);
    const args = { Name: 'X AB', Type: 'COMPANY', CountryCode: 'SE', confirm: true };
    const prepared = await client.callTool({
      name: 'staged_prepare',
      arguments: { tool: 'fortnox_create_customer', args },
    });
    expect(prepared.isError).not.toBe(true);
    const id = (JSON.parse(textOf(prepared as never)) as { id: string }).id;
    h.synthetic.state.orgNr = '556999-9999'; // the Fortnox company changed underneath the host
    const result = await client.callTool({
      name: 'staged_execute',
      arguments: { id, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(h.synthetic.state.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(stderr.join('\n')).toMatch(/organi[sz]ation/i);
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(false);
    await client.close();
  });

  it('read-only staged actions stay available while the gate refuses', async () => {
    const h = await makeHost({ synthetic: createSyntheticFortnox('556999-9999') });
    const client = await connect(h.host);
    const status = await client.callTool({ name: 'fortnox_shadow_status', arguments: {} });
    expect(status.isError).not.toBe(true);
    await client.close();
  });
});

describe('crash and abort drills', () => {
  it('before the Fortnox call: source_unknown, gate refuses new writes', async () => {
    const root = tempRoot();
    const synthetic = createSyntheticFortnox(ORG);
    const failing = {
      ...synthetic.transport,
      request: async (endpoint: string, options?: unknown) => {
        if (endpoint.startsWith('customers/')) throw new Error('network down');
        return synthetic.transport.request(endpoint, options as never);
      },
    } as never;
    const h = await makeHost({ root, fortnox: failing, synthetic });
    await expect(baselineCustomerCommand(h.host, '1')).rejects.toThrow();
    expect(h.host.queue.snapshot()[0]!.record.state).toBe('source_unknown');
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    await h.host.close();
    const again = await makeHost({ root });
    expect(await again.host.checkGate()).toMatchObject({ ok: false });
    expect((await baselineCustomerCommand(again.host, '2')).ok).toBe(false);
  });

  it('after Fortnox success but before the source receipt: source_in_flight remains and refuses', async () => {
    const root = tempRoot();
    const synthetic = createSyntheticFortnox(ORG);
    const ref: { host?: Awaited<ReturnType<typeof makeHost>>['host'] } = {};
    const crashing = {
      ...synthetic.transport,
      request: async (endpoint: string, options?: unknown) => {
        const result = await synthetic.transport.request(endpoint, options as never);
        if (endpoint.startsWith('customers/')) ref.host!.queue.close(); // process dies here
        return result;
      },
    } as never;
    const h = await makeHost({ root, fortnox: crashing, synthetic });
    ref.host = h.host;
    await expect(baselineCustomerCommand(h.host, '1')).rejects.toThrow();
    const again = await makeHost({ root });
    expect(again.host.queue.snapshot()[0]!.record.state).toBe('source_in_flight');
    const gate = await again.host.checkGate();
    expect(gate).toMatchObject({ ok: false });
    expect(JSON.stringify(gate)).toContain('source_in_flight');
  });

  it('after the Accounted POST but before the receipt: target_unknown, never retried, gate refuses', async () => {
    const accounted = fakeAccounted({ postFailsAfterStore: true });
    const h = await makeHost({ accounted });
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    const drained = await drainOneCommand(h.host, id, preview.hash!);
    expect(drained).toMatchObject({ ok: false, state: 'target_unknown' });
    expect(accounted.customers.size).toBe(1);
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    expect((await previewCommand(h.host, id)).ok).toBe(false);
    expect((await drainOneCommand(h.host, id, preview.hash!)).ok).toBe(false);
    expect(accounted.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('after the receipt but before the backup: storage stays not-ok across restart until a backup succeeds', async () => {
    const root = tempRoot();
    const h = await makeHost({ root });
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const preview = await previewCommand(h.host, id);
    // break backups: the directory exists but cannot be written
    const backups = join(h.config.directory, 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    chmodSync(backups, 0o500);
    const drained = await drainOneCommand(h.host, id, preview.hash!);
    expect(h.host.queue.get(id)!.state).toBe('applied');
    expect(drained.warnings?.join(' ')).toMatch(/backup/i);
    expect(await h.host.checkGate()).toMatchObject({ ok: false });
    await h.host.close();

    const again = await makeHost({ root });
    expect(await again.host.checkGate()).toMatchObject({ ok: false });
    chmodSync(backups, 0o700);
    expect((await backupCommand(again.host)).ok).toBe(true);
    expect(await again.host.checkGate()).toEqual({ ok: true });
  });

  it('restoring a backup keeps the gate closed until the operator runs status', async () => {
    const root = tempRoot();
    const h = await makeHost({ root });
    await baselineCustomerCommand(h.host, '1');
    expect((await backupCommand(h.host)).ok).toBe(true);
    await baselineCustomerCommand(h.host, '2');
    const stamp = readdirSync(join(h.config.directory, 'backups'))[0]!;
    const snapshot = join(h.config.directory, 'backups', stamp);
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
    const restored = await makeHost({ root });
    const gate = await restored.host.checkGate();
    expect(gate).toMatchObject({ ok: false });
    expect(JSON.stringify(gate)).toMatch(/status/);
    expect((await baselineCustomerCommand(restored.host, '3')).ok).toBe(false);
    expect((await statusCommand(restored.host)).ok).toBe(true);
    expect(await restored.host.checkGate()).toEqual({ ok: true });
  });
});

describe('status and manual backup', () => {
  it('lists non-applied records with reasons and the number to target map', async () => {
    const h = await makeHost();
    await baselineCustomerCommand(h.host, '1');
    const status = await statusCommand(h.host);
    expect(status.message).toMatch(/pending/);
    expect(status.message).toMatch(/baselineCustomer/);
    expect((await backupCommand(h.host)).ok).toBe(true);
  });
  it('refuses a duplicate baseline for a number that already has a record', async () => {
    const h = await makeHost();
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(false);
  });
});

describe('bootstrap', () => {
  it('opens a synthetic-source host from a config file without touching keychain or network', async () => {
    const { openPilotHost } = await import('../../src/pilot/bootstrap.js');
    const root = tempRoot();
    const { path } = configFor(root);
    const host = await openPilotHost({
      configPath: path,
      synthetic: true,
      headDir: join(root, 'heads'),
    });
    try {
      expect((await statusCommand(host)).ok).toBe(true);
      expect(await host.checkGate()).toEqual({ ok: true });
    } finally {
      await host.close();
    }
  });

  it('reconciles an unknown create read-only and never sends another POST', async () => {
    const h = await makeHost();
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
    const [c] = h.host.queue.snapshot().map((e) => e.record);
    const preview = await previewCommand(h.host, c!.id);
    h.accounted.state.getFails = true;
    const drained = await drainOneCommand(h.host, c!.id, preview.hash!);
    expect(drained.state).toBe('target_unknown');
    // still failing: stays unknown
    const again = await reconcileCommand(h.host, c!.id);
    expect(again.ok).toBe(false);
    expect(h.host.queue.get(c!.id)!.state).toBe('target_unknown');
    h.accounted.state.getFails = false;
    const ok = await reconcileCommand(h.host, c!.id);
    expect(ok, ok.message).toMatchObject({ ok: true, state: 'applied' });
    expect(
      h.accounted.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/customers')),
    ).toHaveLength(1);
    expect((await reconcileCommand(h.host, c!.id)).ok).toBe(false);
  });
});
