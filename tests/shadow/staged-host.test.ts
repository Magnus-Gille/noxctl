import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowBinding } from '../../src/shadow/types.js';
import {
  StagedCallStore,
  createStagedHost,
  createStagedInvoker,
  type StagedCall,
} from './fixtures/staged-host.js';

const binding: ShadowBinding = {
  sourceCompany: 'simulated-fortnox-company',
  targetCompany: 'simulated-accounted-company',
};
const revision = 'staged-host-fixture-v1';
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'noxctl-staged-host-'));
  roots.push(root);
  return root;
}

function makeDatabase(root: string): { db: DatabaseSync; path: string } {
  const path = join(root, 'staged-host.sqlite');
  return { db: new DatabaseSync(path), path };
}

function makeStore(root = makeRoot()): {
  db: DatabaseSync;
  path: string;
  store: StagedCallStore;
} {
  const { db, path } = makeDatabase(root);
  return { db, path, store: new StagedCallStore(db, binding, revision) };
}

function customerArgs(name = 'Fixture customer AB') {
  return {
    Name: name,
    Type: 'COMPANY',
    CountryCode: 'SE',
    confirm: true,
  };
}

function invoiceArgs(marker = 'Fixture invoice') {
  return {
    CustomerNumber: '42',
    InvoiceRows: [
      {
        Description: marker,
        DeliveredQuantity: 1,
        Price: 100,
        VAT: 25,
      },
    ],
    InvoiceDate: '2026-10-29',
    DueDate: '2026-11-29',
    OurReference: marker,
    confirm: true,
    includeRaw: true,
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function successfulReceipt(name = 'created'): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, name }) }],
  };
}

function errorReceipt(message = 'simulated provider failure'): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function textOf(result: CallToolResult): string {
  const item = result.content?.find((content) => content.type === 'text');
  return item && 'text' in item ? item.text : '';
}

function jsonOf(result: CallToolResult): unknown {
  const text = textOf(result);
  if (!text) return result.structuredContent;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function connectHost(
  store: StagedCallStore,
  invoke: (record: StagedCall) => Promise<CallToolResult>,
  clientName = 'simulated-gateway-client',
  shadowStatus?: () => unknown,
) {
  const server = createStagedHost(store, invoke, shadowStatus);
  const client = new Client({ name: clientName, version: 'fixture' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('staged shadow host store', () => {
  it('generates UUID prepare IDs, preserves caller arguments, and never invokes a provider while preparing', () => {
    const { db, store } = makeStore();
    const args = { ...customerArgs(), metadata: { label: 'original' } };
    const expectedArgs = structuredClone(args);
    const first = store.prepare('fortnox_create_customer', args);
    const second = store.prepare('fortnox_create_customer', args);
    args.Name = 'mutated after prepare';
    args.metadata.label = 'mutated after prepare';

    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({ state: 'prepared', tool: 'fortnox_create_customer' });
    expect(store.get(first.id)?.args).toEqual(expectedArgs);
    expect(store.list().map(({ id }) => id)).toEqual([first.id, second.id]);
    db.close();
  });

  it('accepts only the two staged Fortnox writes and requires confirmed, non-dry-run arguments', () => {
    const { db, store } = makeStore();

    expect(() => store.prepare('fortnox_delete_customer', customerArgs())).toThrow(
      /allow|unknown|staged/i,
    );
    expect(() =>
      store.prepare('fortnox_create_customer', { ...customerArgs(), confirm: false }),
    ).toThrow(/confirm/i);
    expect(() =>
      store.prepare('fortnox_create_customer', { ...customerArgs(), dryRun: true }),
    ).toThrow(/dry.?run/i);
    expect(() => store.prepare('fortnox_create_invoice', customerArgs())).not.toThrow();
    db.close();
  });

  it('rejects unconfirmed execution without invoking, claims once, and caches the full MCP receipt', async () => {
    const { db, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    const invoke = vi.fn().mockResolvedValue(successfulReceipt('first'));

    await expect(store.execute(prepared.id, false, invoke)).rejects.toThrow(/confirm/i);
    expect(invoke).not.toHaveBeenCalled();
    await expect(store.execute(prepared.id, true, invoke)).resolves.toEqual(
      successfulReceipt('first'),
    );
    expect(store.get(prepared.id)).toMatchObject({
      id: prepared.id,
      state: 'completed',
      tool: prepared.tool,
    });
    expect(invoke).toHaveBeenCalledOnce();
    await expect(store.execute(prepared.id, true, vi.fn())).resolves.toEqual(
      successfulReceipt('first'),
    );
    expect(invoke).toHaveBeenCalledOnce();
    db.close();
  });

  it('caches completed isError receipts and replays them without invoking again', async () => {
    const { db, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    const receipt = errorReceipt();
    const invoke = vi.fn().mockResolvedValue(receipt);

    await expect(store.execute(prepared.id, true, invoke)).resolves.toEqual(receipt);
    expect(store.get(prepared.id)).toMatchObject({ state: 'completed', result: receipt });
    await expect(store.execute(prepared.id, true, vi.fn())).resolves.toEqual(receipt);
    expect(invoke).toHaveBeenCalledOnce();
    db.close();
  });

  it('marks a thrown invocation unknown and blocks automatic retry, including after reopen', async () => {
    const { db, path, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    const invoke = vi.fn().mockRejectedValue(new Error('provider connection lost'));

    await expect(store.execute(prepared.id, true, invoke)).rejects.toThrow(
      'provider connection lost',
    );
    expect(store.get(prepared.id)).toMatchObject({ state: 'unknown' });
    await expect(store.execute(prepared.id, true, vi.fn())).rejects.toThrow(
      /unknown|retry|blocked/i,
    );
    db.close();

    const reopenedDb = new DatabaseSync(path);
    const reopened = new StagedCallStore(reopenedDb, binding, revision);
    expect(reopened.get(prepared.id)).toMatchObject({ state: 'unknown' });
    await expect(reopened.execute(prepared.id, true, vi.fn())).rejects.toThrow(
      /unknown|retry|blocked/i,
    );
    reopenedDb.close();
  });

  it('blocks a second concurrent execution while the first invocation is executing', async () => {
    const root = makeRoot();
    const firstConnection = makeDatabase(root);
    const secondConnection = makeDatabase(root);
    const firstStore = new StagedCallStore(firstConnection.db, binding, revision);
    const secondStore = new StagedCallStore(secondConnection.db, binding, revision);
    const prepared = firstStore.prepare('fortnox_create_customer', customerArgs());
    let release!: (receipt: CallToolResult) => void;
    const running = new Promise<CallToolResult>((resolve) => {
      release = resolve;
    });
    const first = firstStore.execute(prepared.id, true, () => running);

    expect(firstStore.get(prepared.id)?.state).toBe('executing');
    expect(secondStore.get(prepared.id)?.state).toBe('executing');
    await expect(secondStore.execute(prepared.id, true, vi.fn())).rejects.toThrow(
      /executing|in flight|progress|claim/i,
    );
    release(successfulReceipt('concurrent winner'));
    await expect(first).resolves.toEqual(successfulReceipt('concurrent winner'));
    expect(firstStore.get(prepared.id)?.state).toBe('completed');
    firstConnection.db.close();
    secondConnection.db.close();
  });

  it('keeps a raw-SQL interrupted executing row blocked after database reopen', async () => {
    const { db, path, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    db.prepare("UPDATE staged_calls SET state='executing' WHERE id=?").run(prepared.id);
    db.close();

    const reopenedDb = new DatabaseSync(path);
    const reopened = new StagedCallStore(reopenedDb, binding, revision);
    expect(reopened.get(prepared.id)?.state).toBe('executing');
    await expect(reopened.execute(prepared.id, true, vi.fn())).rejects.toThrow(
      /executing|in flight|crash|blocked/i,
    );
    reopenedDb.close();
  });

  it('survives reconnect with the same ID and replays the durable receipt without invoking', async () => {
    const { db, path, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    const receipt = successfulReceipt('reconnect');
    await store.execute(prepared.id, true, vi.fn().mockResolvedValue(receipt));
    db.close();

    const reopenedDb = new DatabaseSync(path);
    const reopened = new StagedCallStore(reopenedDb, binding, revision);
    const replay = vi.fn();
    await expect(reopened.execute(prepared.id, true, replay)).resolves.toEqual(receipt);
    expect(replay).not.toHaveBeenCalled();
    reopenedDb.close();
  });

  it('rejects a database reopened with a different binding or revision', () => {
    const { db, path, store } = makeStore();
    store.prepare('fortnox_create_customer', customerArgs());
    db.close();

    const wrongBindingDb = new DatabaseSync(path);
    expect(
      () =>
        new StagedCallStore(
          wrongBindingDb,
          { ...binding, targetCompany: 'different-target' },
          revision,
        ),
    ).toThrow(/binding/i);
    wrongBindingDb.close();

    const wrongRevisionDb = new DatabaseSync(path);
    expect(() => new StagedCallStore(wrongRevisionDb, binding, 'different-revision')).toThrow(
      /revision/i,
    );
    wrongRevisionDb.close();
  });

  it('returns defensive copies from get and list so stored canonical arguments stay immutable', () => {
    const { db, store } = makeStore();
    const immutableArgs = { ...customerArgs(), metadata: { label: 'original' } };
    const expectedArgs = structuredClone(immutableArgs);
    const prepared = store.prepare('fortnox_create_customer', immutableArgs);
    const copy = store.get(prepared.id)!;
    copy.args.Name = 'changed through get';
    (copy.args.metadata as { label: string }).label = 'changed nested through get';
    const listed = store.list();
    listed[0]!.args.Name = 'changed through list';
    expect(store.get(prepared.id)?.args).toEqual(expectedArgs);
    db.close();
  });

  it('retains unknown when completion persistence fails after the provider returns', async () => {
    const { db, store } = makeStore();
    const prepared = store.prepare('fortnox_create_customer', customerArgs());
    db.exec(
      "CREATE TRIGGER fail_completion BEFORE UPDATE OF state ON staged_calls WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL, 'synthetic completion failure'); END;",
    );
    const invoke = vi.fn().mockResolvedValue(successfulReceipt());
    await expect(store.execute(prepared.id, true, invoke)).rejects.toThrow(
      'synthetic completion failure',
    );
    expect(store.get(prepared.id)?.state).toBe('unknown');
    await expect(store.execute(prepared.id, true, invoke)).rejects.toThrow(/unknown/);
    expect(invoke).toHaveBeenCalledOnce();
    db.close();
  });

  it('does not expose a prepared ID if its insert cannot be persisted', () => {
    const { db, store } = makeStore();
    db.exec(
      "CREATE TRIGGER fail_preparation BEFORE INSERT ON staged_calls BEGIN SELECT RAISE(FAIL, 'synthetic preparation failure'); END;",
    );
    expect(() => store.prepare('fortnox_create_customer', customerArgs())).toThrow(
      'synthetic preparation failure',
    );
    expect(store.list()).toEqual([]);
    db.close();
  });
});

describe('staged shadow host MCP gateway', () => {
  it('exposes only strict staged tools with no binding or origin selectors', async () => {
    const { db, store } = makeStore();
    const { client } = await connectHost(store, vi.fn().mockResolvedValue(successfulReceipt()));
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(
      ['staged_execute', 'staged_get', 'staged_list', 'staged_prepare'].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
    expect(tools.find(({ name }) => name === 'staged_prepare')?.inputSchema.properties).toEqual(
      expect.objectContaining({ tool: expect.any(Object), args: expect.any(Object) }),
    );
    expect(
      tools.find(({ name }) => name === 'staged_prepare')?.inputSchema.properties,
    ).not.toHaveProperty('binding');
    expect(
      tools.find(({ name }) => name === 'staged_prepare')?.inputSchema.properties,
    ).not.toHaveProperty('origin');
    expect(
      tools.find(({ name }) => name === 'staged_execute')?.inputSchema.properties,
    ).not.toHaveProperty('binding');
    await client.close();
    db.close();
  });

  it('rejects unknown selectors and unknown top-level fields before provider invocation', async () => {
    const { db, store } = makeStore();
    const invoke = vi.fn().mockResolvedValue(successfulReceipt());
    const { client } = await connectHost(store, invoke);

    const unknownTool = await client.callTool({
      name: 'staged_prepare',
      arguments: { tool: 'fortnox_delete_customer', args: customerArgs() },
    });
    expect(unknownTool.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();

    const unknownField = await client.callTool({
      name: 'staged_prepare',
      arguments: {
        tool: 'fortnox_create_customer',
        args: customerArgs(),
        origin: 'installed-4apps',
      },
    });
    expect(unknownField.isError).toBe(true);
    const invalidExecute = await client.callTool({
      name: 'staged_execute',
      arguments: {
        id: '00000000-0000-4000-8000-000000000000',
        confirm: true,
        origin: 'installed-4apps',
      },
    });
    expect(invalidExecute.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await client.close();
    db.close();
  });

  it('prepares through the gateway without source calls and executes only after confirmation', async () => {
    const { db, store } = makeStore();
    const invoke = vi.fn().mockResolvedValue(successfulReceipt('gateway'));
    const { client } = await connectHost(store, invoke);

    const prepared = await client.callTool({
      name: 'staged_prepare',
      arguments: { tool: 'fortnox_create_customer', args: customerArgs() },
    });
    expect(prepared.isError).not.toBe(true);
    const record = jsonOf(prepared as CallToolResult) as {
      id: string;
      state: string;
      args: unknown;
    };
    expect(record).toMatchObject({
      state: 'prepared',
      tool: 'fortnox_create_customer',
      args: customerArgs(),
    });
    expect(invoke).not.toHaveBeenCalled();

    const unconfirmed = await client.callTool({
      name: 'staged_execute',
      arguments: { id: record.id },
    });
    expect(unconfirmed.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();

    const executed = await client.callTool({
      name: 'staged_execute',
      arguments: { id: record.id, confirm: true },
    });
    expect(executed.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(executed.content).toEqual(successfulReceipt('gateway').content);
    await client.close();
    db.close();
  });
});

describe('staged shadow host source integration', () => {
  function syntheticTransport(
    calls: Array<{ endpoint: string; body?: unknown }>,
  ): FortnoxTransport {
    return {
      async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}) {
        if (endpoint !== 'customers' || options.method !== 'POST')
          throw new Error(
            `Unexpected simulated source call: ${options.method ?? 'GET'} ${endpoint}`,
          );
        calls.push({ endpoint, body: options.body });
        const body = options.body as { Customer: Record<string, unknown> };
        return {
          Customer: {
            ...body.Customer,
            CustomerNumber: `SIM-${calls.length}`,
          },
        } as T;
      },
      async requestWithMetadata<T>(): Promise<T> {
        throw new Error('Unexpected simulated metadata call');
      },
      async requestPdf(): Promise<Buffer> {
        throw new Error('Unexpected simulated PDF call');
      },
      async requestPdfFromMutation(): Promise<Buffer> {
        throw new Error('Unexpected simulated PDF mutation call');
      },
      async requestFile<T>(): Promise<T> {
        throw new Error('Unexpected simulated file call');
      },
      async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
        items: T[];
        totalResources: number;
      }> {
        throw new Error('Unexpected simulated pagination call');
      },
    };
  }

  function syntheticInvoiceTransport(
    calls: Array<{ endpoint: string; body?: unknown }>,
  ): FortnoxTransport {
    return {
      async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}) {
        if (endpoint !== 'invoices' || options.method !== 'POST')
          throw new Error(
            `Unexpected simulated invoice call: ${options.method ?? 'GET'} ${endpoint}`,
          );
        calls.push({ endpoint, body: options.body });
        const body = options.body as { Invoice: Record<string, unknown> };
        return {
          Invoice: {
            ...body.Invoice,
            DocumentNumber: `SIM-INV-${calls.length}`,
            Total: 125,
          },
        } as T;
      },
      async requestWithMetadata<T>(): Promise<T> {
        throw new Error('Unexpected simulated invoice metadata call');
      },
      async requestPdf(): Promise<Buffer> {
        throw new Error('Unexpected simulated invoice PDF call');
      },
      async requestPdfFromMutation(): Promise<Buffer> {
        throw new Error('Unexpected simulated invoice PDF mutation call');
      },
      async requestFile<T>(): Promise<T> {
        throw new Error('Unexpected simulated invoice file call');
      },
      async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
        items: T[];
        totalResources: number;
      }> {
        throw new Error('Unexpected simulated invoice pagination call');
      },
    };
  }

  it('rejects a different store company before invoking the bound source queue', async () => {
    const root = makeRoot();
    const { db } = makeDatabase(root);
    const store = new StagedCallStore(db, { ...binding, sourceCompany: 'other-source' }, revision);
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const calls: Array<{ endpoint: string; body?: unknown }> = [];
    const staged = await createStagedInvoker(queue, syntheticTransport(calls));
    try {
      const record = store.prepare('fortnox_create_customer', customerArgs());
      await expect(store.execute(record.id, true, staged.invoke)).rejects.toThrow(/binding/);
      expect(calls).toEqual([]);
      expect(queue.status().items).toEqual([]);
    } finally {
      await staged.close();
      queue.close();
      db.close();
    }
  });

  it('replays a completed MCP result after both stores and gateway clients are reopened', async () => {
    const root = makeRoot();
    const calls: Array<{ endpoint: string; body?: unknown }> = [];
    const initial = makeStore(root);
    let { db, store } = initial;
    const { path } = initial;
    let queue = await openShadowQueue(join(root, 'queue'), binding);
    let staged = await createStagedInvoker(queue, syntheticTransport(calls));
    let session = await connectHost(store, staged.invoke);
    try {
      const prepared = await session.client.callTool({
        name: 'staged_prepare',
        arguments: { tool: 'fortnox_create_customer', args: customerArgs() },
      });
      const id = (jsonOf(prepared as CallToolResult) as { id: string }).id;
      const receipt = await session.client.callTool({
        name: 'staged_execute',
        arguments: { id, confirm: true },
      });
      expect(receipt.isError).not.toBe(true);
      expect(calls).toHaveLength(1);
      await session.client.close();
      await session.server.close();
      await staged.close();
      queue.close();
      db.close();
      db = new DatabaseSync(path);
      store = new StagedCallStore(db, binding, revision);
      queue = await openShadowQueue(join(root, 'queue'), binding);
      staged = await createStagedInvoker(queue, syntheticTransport(calls));
      session = await connectHost(store, staged.invoke);
      const replay = await session.client.callTool({
        name: 'staged_execute',
        arguments: { id, confirm: true },
      });
      expect(replay).toEqual(receipt);
      expect(calls).toHaveLength(1);
      expect(queue.get(`${id}:0`)?.state).toBe('pending');
    } finally {
      await session.client.close();
      await session.server.close();
      await staged.close();
      queue.close();
      db.close();
    }
  });

  it('uses the real embedded MCP source client and queues synthetic Fortnox writes under child intent IDs', async () => {
    const root = makeRoot();
    const { db, store } = makeStore(root);
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const sourceCalls: Array<{ endpoint: string; body?: unknown }> = [];
    const transport = syntheticTransport(sourceCalls);
    const staged = await createStagedInvoker(queue, transport);
    const { client } = await connectHost(
      store,
      staged.invoke,
      'simulated-gateway-client-a',
      staged.status,
    );
    try {
      const prepared = await client.callTool({
        name: 'staged_prepare',
        arguments: { tool: 'fortnox_create_customer', args: customerArgs('Simulated source AB') },
      });
      const record = jsonOf(prepared as CallToolResult) as { id: string };
      expect(sourceCalls).toHaveLength(0);
      await client.callTool({
        name: 'staged_execute',
        arguments: { id: record.id, confirm: true },
      });
      expect(sourceCalls).toHaveLength(1);
      expect(queue.status().counts.pending).toBe(1);
      expect(queue.get(`${record.id}:0`)).toMatchObject({
        id: `${record.id}:0`,
        operation: 'createCustomer',
        state: 'pending',
      });
      const status = await client.callTool({ name: 'fortnox_shadow_status', arguments: {} });
      expect(jsonOf(status as CallToolResult)).toMatchObject({ binding, counts: { pending: 1 } });
    } finally {
      await client.close();
      await staged.close();
      queue.close();
      db.close();
    }
  });

  it('keeps concurrent logical scopes and same-payload receipts distinct', async () => {
    const root = makeRoot();
    const { db, store } = makeStore(root);
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const sourceCalls: Array<{ endpoint: string; body?: unknown }> = [];
    const staged = await createStagedInvoker(queue, syntheticTransport(sourceCalls));
    const first = await connectHost(store, staged.invoke, 'simulated-gateway-client-a');
    const second = await connectHost(store, staged.invoke, 'simulated-gateway-client-b');
    try {
      const payload = customerArgs('Same simulated payload AB');
      const prepared = await Promise.all([
        first.client.callTool({
          name: 'staged_prepare',
          arguments: { tool: 'fortnox_create_customer', args: payload },
        }),
        second.client.callTool({
          name: 'staged_prepare',
          arguments: { tool: 'fortnox_create_customer', args: payload },
        }),
      ]);
      const records = prepared.map((result) => jsonOf(result as CallToolResult) as { id: string });
      expect(records[0]!.id).not.toBe(records[1]!.id);
      await Promise.all(
        [first.client, second.client].map((client, index) =>
          client.callTool({
            name: 'staged_execute',
            arguments: { id: records[index]!.id, confirm: true },
          }),
        ),
      );
      expect(sourceCalls).toHaveLength(2);
      expect(queue.status().items.map(({ id }) => id)).toEqual(
        expect.arrayContaining([`${records[0]!.id}:0`, `${records[1]!.id}:0`]),
      );
      expect(queue.status().items.map(({ id }) => id)).not.toContain('installed-4apps');
      const sourceNumbers = records.map(
        ({ id }) =>
          (queue.get(`${id}:0`)?.sourceResult as { CustomerNumber: string }).CustomerNumber,
      );
      expect(sourceNumbers.sort()).toEqual(['SIM-1', 'SIM-2']);
    } finally {
      await Promise.all([first.client.close(), second.client.close()]);
      await staged.close();
      queue.close();
      db.close();
    }
  });

  it('stages a real invoice create once, persists its createInvoice child receipt, and replays the same outer ID', async () => {
    const root = makeRoot();
    const { db, store } = makeStore(root);
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const sourceCalls: Array<{ endpoint: string; body?: unknown }> = [];
    const staged = await createStagedInvoker(queue, syntheticInvoiceTransport(sourceCalls));
    const { client } = await connectHost(store, staged.invoke, 'simulated-invoice-gateway');
    try {
      const prepared = await client.callTool({
        name: 'staged_prepare',
        arguments: {
          tool: 'fortnox_create_invoice',
          args: invoiceArgs('Staged invoice marker'),
        },
      });
      expect(prepared.isError).not.toBe(true);
      const outerId = (jsonOf(prepared as CallToolResult) as { id: string }).id;
      expect(sourceCalls).toHaveLength(0);

      const firstReceipt = await client.callTool({
        name: 'staged_execute',
        arguments: { id: outerId, confirm: true },
      });
      expect(firstReceipt.isError).not.toBe(true);
      expect(sourceCalls).toHaveLength(1);
      expect(sourceCalls[0]).toMatchObject({ endpoint: 'invoices' });
      expect((sourceCalls[0]!.body as { Invoice: Record<string, unknown> }).Invoice).toMatchObject({
        CustomerNumber: '42',
        InvoiceDate: '2026-10-29',
        InvoiceRows: [
          expect.objectContaining({
            Description: 'Staged invoice marker',
            DeliveredQuantity: 1,
            Price: 100,
            VAT: 25,
          }),
        ],
      });

      const child = queue.get(`${outerId}:0`);
      expect(child).toMatchObject({
        id: `${outerId}:0`,
        operation: 'createInvoice',
        state: 'pending',
        sourceResult: expect.objectContaining({
          DocumentNumber: 'SIM-INV-1',
          CustomerNumber: '42',
        }),
      });
      expect(child).not.toHaveProperty('targetId');
      expect(child).not.toHaveProperty('targetReceipt');
      expect(
        queue.status().items.filter(({ operation }) => operation === 'createInvoice'),
      ).toHaveLength(1);

      const replay = await client.callTool({
        name: 'staged_execute',
        arguments: { id: outerId, confirm: true },
      });
      expect(replay).toEqual(firstReceipt);
      expect(sourceCalls).toHaveLength(1);
      expect(
        queue.status().items.filter(({ operation }) => operation === 'createInvoice'),
      ).toHaveLength(1);
    } finally {
      await client.close();
      await staged.close();
      queue.close();
      db.close();
    }
  });

  it('keeps overlapping real gateway customer receipts and child source results paired when the second finishes first', async () => {
    const root = makeRoot();
    const { db, store } = makeStore(root);
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const firstName = 'Overlap first simulated customer';
    const secondName = 'Overlap second simulated customer';
    const firstStarted = deferred();
    const secondStarted = deferred();
    const firstGate = deferred();
    const secondGate = deferred();
    const sourceCalls: Array<{ endpoint: string; body?: unknown }> = [];
    const transport: FortnoxTransport = {
      async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}) {
        if (endpoint !== 'customers' || options.method !== 'POST')
          throw new Error(`Unexpected overlap source call: ${options.method ?? 'GET'} ${endpoint}`);
        const body = options.body as { Customer: Record<string, unknown> };
        const name = body.Customer.Name;
        sourceCalls.push({ endpoint, body: options.body });
        if (name === firstName) {
          firstStarted.release();
          await firstGate.promise;
          return {
            Customer: { ...body.Customer, CustomerNumber: 'SIM-FIRST' },
          } as T;
        }
        if (name === secondName) {
          secondStarted.release();
          await secondGate.promise;
          return {
            Customer: { ...body.Customer, CustomerNumber: 'SIM-SECOND' },
          } as T;
        }
        throw new Error(`Unexpected overlap customer marker: ${String(name)}`);
      },
      async requestWithMetadata<T>(): Promise<T> {
        throw new Error('Unexpected overlap metadata call');
      },
      async requestPdf(): Promise<Buffer> {
        throw new Error('Unexpected overlap PDF call');
      },
      async requestPdfFromMutation(): Promise<Buffer> {
        throw new Error('Unexpected overlap PDF mutation call');
      },
      async requestFile<T>(): Promise<T> {
        throw new Error('Unexpected overlap file call');
      },
      async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
        items: T[];
        totalResources: number;
      }> {
        throw new Error('Unexpected overlap pagination call');
      },
    };
    const staged = await createStagedInvoker(queue, transport);
    const first = await connectHost(store, staged.invoke, 'simulated-overlap-client-a');
    const second = await connectHost(store, staged.invoke, 'simulated-overlap-client-b');
    let firstExecution: Promise<CallToolResult> | undefined;
    let secondExecution: Promise<CallToolResult> | undefined;
    try {
      const prepared = await Promise.all([
        first.client.callTool({
          name: 'staged_prepare',
          arguments: { tool: 'fortnox_create_customer', args: customerArgs(firstName) },
        }),
        second.client.callTool({
          name: 'staged_prepare',
          arguments: { tool: 'fortnox_create_customer', args: customerArgs(secondName) },
        }),
      ]);
      const firstId = (jsonOf(prepared[0] as CallToolResult) as { id: string }).id;
      const secondId = (jsonOf(prepared[1] as CallToolResult) as { id: string }).id;
      expect(firstId).not.toBe(secondId);

      const firstPromise = first.client.callTool({
        name: 'staged_execute',
        arguments: { id: firstId, confirm: true },
      }) as Promise<CallToolResult>;
      const secondPromise = second.client.callTool({
        name: 'staged_execute',
        arguments: { id: secondId, confirm: true },
      }) as Promise<CallToolResult>;
      firstExecution = firstPromise;
      secondExecution = secondPromise;
      await Promise.all([firstStarted.promise, secondStarted.promise]);

      secondGate.release();
      const secondReceipt = await secondPromise;
      expect(secondReceipt.isError).not.toBe(true);
      expect(textOf(secondReceipt as CallToolResult)).toContain('SIM-SECOND');
      expect(textOf(secondReceipt as CallToolResult)).not.toContain('SIM-FIRST');
      expect(queue.get(`${secondId}:0`)).toMatchObject({
        id: `${secondId}:0`,
        operation: 'createCustomer',
        state: 'pending',
        sourceResult: { CustomerNumber: 'SIM-SECOND' },
      });

      firstGate.release();
      const firstReceipt = await firstPromise;
      expect(firstReceipt.isError).not.toBe(true);
      expect(textOf(firstReceipt as CallToolResult)).toContain('SIM-FIRST');
      expect(textOf(firstReceipt as CallToolResult)).not.toContain('SIM-SECOND');
      expect(queue.get(`${firstId}:0`)).toMatchObject({
        id: `${firstId}:0`,
        operation: 'createCustomer',
        state: 'pending',
        sourceResult: { CustomerNumber: 'SIM-FIRST' },
      });
      expect(sourceCalls).toHaveLength(2);
    } finally {
      firstGate.release();
      secondGate.release();
      await Promise.allSettled([firstExecution, secondExecution].filter(Boolean));
      await Promise.all([first.client.close(), second.client.close()]);
      await staged.close();
      queue.close();
      db.close();
    }
  });
});
