import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStagedServer, type StagedAuthorizationContext } from '../../src/embedded.js';
import type { FortnoxTransport, RequestOptions } from '../../src/fortnox-client.js';

const binding = {
  sourceCompany: 'synthetic-fortnox-company',
  targetCompany: 'synthetic-accounted-company',
};
const revision = 'a'.repeat(64);
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const roots: string[] = [];
const runtimes: Array<{ close: () => Promise<void> }> = [];

type JsonRecord = Record<string, unknown>;
type Session = Awaited<ReturnType<typeof createStagedServer>> & { client: Client; root: string };

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'noxctl-staged-runtime-'));
  roots.push(value);
  return value;
}

function customerArgs(name = 'Synthetic customer AB'): JsonRecord {
  return { Name: name, Type: 'COMPANY', CountryCode: 'SE', confirm: true };
}

function invoiceArgs(marker = 'Synthetic invoice'): JsonRecord {
  return {
    CustomerNumber: '42',
    InvoiceRows: [{ Description: marker, DeliveredQuantity: 1, Price: 100, VAT: 25 }],
    InvoiceDate: '2026-10-29',
    DueDate: '2026-11-29',
    OurReference: marker,
    confirm: true,
    includeRaw: true,
  };
}

function transport(
  options: {
    request?: (endpoint: string, options?: RequestOptions) => Promise<unknown>;
    effects?: unknown[];
  } = {},
): FortnoxTransport {
  const request =
    options.request ??
    vi.fn(async (endpoint: string, requestOptions?: { method?: string; body?: unknown }) => {
      options.effects?.push({ endpoint, ...requestOptions });
      if (endpoint === 'customers') {
        const body = requestOptions?.body as { Customer?: JsonRecord } | undefined;
        return { Customer: { CustomerNumber: 'C-1', ...(body?.Customer ?? {}) } };
      }
      if (endpoint === 'invoices') {
        const body = requestOptions?.body as { Invoice?: JsonRecord } | undefined;
        return { Invoice: { DocumentNumber: 'I-1', ...(body?.Invoice ?? {}) } };
      }
      return {};
    });
  return {
    request: async <T>(endpoint: string, requestOptions?: RequestOptions) =>
      (await request(endpoint, requestOptions)) as T,
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn(),
    requestPdfFromMutation: vi.fn(),
    requestFile: vi.fn(),
    fetchAllPages: vi.fn(),
  } as unknown as FortnoxTransport;
}

function textOf(result: CallToolResult): string {
  const text = result.content?.find((item) => item.type === 'text');
  return text && 'text' in text ? text.text : '';
}

function jsonOf<T = JsonRecord>(result: CallToolResult): T {
  return JSON.parse(textOf(result)) as T;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return textOf(result);
}

async function session(
  options: {
    directory?: string;
    transport?: FortnoxTransport;
    authorize?: (context: StagedAuthorizationContext) => boolean | Promise<boolean>;
    now?: () => number;
    actorId?: string;
    revision?: string;
    binding?: typeof binding;
    maxPreparationAgeMs?: number;
  } = {},
): Promise<Session> {
  const directory = options.directory ?? root();
  const runtime = await createStagedServer({
    transport: options.transport ?? transport(),
    directory,
    binding: options.binding ?? binding,
    actorId: options.actorId ?? 'synthetic-owner',
    revision: options.revision ?? revision,
    maxPreparationAgeMs: options.maxPreparationAgeMs ?? 60_000,
    authorize: options.authorize ?? (() => true),
    now: options.now,
  });
  const client = new Client({ name: 'synthetic-staged-runtime-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  const value = { ...runtime, client, root: directory };
  runtimes.push(value);
  return value;
}

async function call(client: Client, name: string, args: JsonRecord = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function prepare(
  client: Client,
  tool: 'fortnox_create_customer' | 'fortnox_create_invoice',
  args: JsonRecord,
): Promise<JsonRecord> {
  const result = await call(client, 'staged_prepare', { tool, args });
  expect(result.isError).not.toBe(true);
  return jsonOf(result);
}

async function closeSession(value: Session | undefined): Promise<void> {
  if (!value) return;
  await value.client.close();
  await value.close();
  const index = runtimes.indexOf(value);
  if (index >= 0) runtimes.splice(index, 1);
}

afterEach(async () => {
  const outcomes = await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  const errors = outcomes.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, 'Staged test cleanup failed; scratch retained');
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('embedded staged runtime', () => {
  it('exposes exactly the staged selectors and no original business tools', async () => {
    const runtime = await session();
    const listed = await runtime.client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      'fortnox_shadow_status',
      'staged_execute',
      'staged_get',
      'staged_list',
      'staged_prepare',
    ]);
    for (const tool of listed.tools) expect(tool.inputSchema.additionalProperties).toBe(false);
    await closeSession(runtime);
  });

  it('rejects strict selector schemas and unknown IDs without source effects', async () => {
    const effects: unknown[] = [];
    const runtime = await session({ transport: transport({ effects }) });
    const invalid = await Promise.all([
      call(runtime.client, 'staged_prepare', {
        tool: 'fortnox_create_customer',
        args: customerArgs(),
        extra: true,
      }),
      call(runtime.client, 'staged_list', { limit: 0 }),
      call(runtime.client, 'staged_list', { limit: 101 }),
      call(runtime.client, 'staged_list', { cursor: -1 }),
      call(runtime.client, 'staged_get', { id: 'not-a-uuid' }),
      call(runtime.client, 'staged_execute', { id: 'not-a-uuid', confirm: true }),
    ]);
    expect(invalid.every((result) => result.isError === true)).toBe(true);
    expect(
      jsonOf(
        await call(runtime.client, 'staged_get', { id: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).toEqual({ missing: true });
    expect(
      errorText(
        await call(runtime.client, 'staged_execute', {
          id: '00000000-0000-4000-8000-000000000000',
          confirm: true,
        }),
      ),
    ).toMatch(/stoppades/i);
    const oversized = await call(runtime.client, 'staged_prepare', {
      tool: 'fortnox_create_customer',
      args: { ...customerArgs(), Name: 'x'.repeat(70_000) },
    });
    expect(errorText(oversized)).toMatch(/stoppades/i);
    expect(effects).toHaveLength(0);
    await closeSession(runtime);
  });

  it('validates actual customer and invoice schemas, including nested extras, before saving', async () => {
    const effects: unknown[] = [];
    const runtime = await session({ transport: transport({ effects }) });
    const invalidCustomer = await call(runtime.client, 'staged_prepare', {
      tool: 'fortnox_create_customer',
      args: { confirm: true },
    });
    const invoice = invoiceArgs();
    invoice.InvoiceRows = [{ ...(invoice.InvoiceRows as JsonRecord[])[0], nestedExtra: true }];
    const invalidInvoice = await call(runtime.client, 'staged_prepare', {
      tool: 'fortnox_create_invoice',
      args: invoice,
    });
    expect(invalidCustomer.isError).toBe(true);
    expect(invalidInvoice.isError).toBe(true);
    expect(effects).toHaveLength(0);
    const list = jsonOf<{ items: unknown[] }>(await call(runtime.client, 'staged_list'));
    expect(list.items).toHaveLength(0);
    await closeSession(runtime);
  });

  it('requires confirm=true and rejects dryRun before source dispatch', async () => {
    const request = vi.fn();
    const runtime = await session({ transport: transport({ request }) });
    for (const args of [
      { ...customerArgs(), confirm: false },
      { ...customerArgs(), dryRun: true },
      { ...customerArgs(), confirm: undefined },
    ]) {
      const result = await call(runtime.client, 'staged_prepare', {
        tool: 'fortnox_create_customer',
        args,
      });
      expect(result.isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
    await closeSession(runtime);
  });

  it('prepares and executes customer and invoice writes with source MCP receipts', async () => {
    const effects: unknown[] = [];
    const runtime = await session({ transport: transport({ effects }) });
    const customer = await prepare(runtime.client, 'fortnox_create_customer', customerArgs());
    expect(customer).toMatchObject({
      state: 'prepared',
      tool: 'fortnox_create_customer',
      args: customerArgs(),
    });
    const customerResult = await call(runtime.client, 'staged_execute', {
      id: customer.id,
      confirm: true,
    });
    expect(customerResult.isError).not.toBe(true);
    const invoice = await prepare(runtime.client, 'fortnox_create_invoice', invoiceArgs());
    const invoiceResult = await call(runtime.client, 'staged_execute', {
      id: invoice.id,
      confirm: true,
    });
    expect(invoiceResult.isError).not.toBe(true);
    expect(effects).toHaveLength(2);
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpoint: 'customers' }),
        expect.objectContaining({ endpoint: 'invoices' }),
      ]),
    );
    const replay = await call(runtime.client, 'staged_execute', { id: customer.id, confirm: true });
    expect(replay).toEqual(customerResult);
    await closeSession(runtime);
  });

  it('requires authorization for every action, including cached replay, and denies false or thrown callbacks', async () => {
    let allowed = true;
    const contexts: StagedAuthorizationContext[] = [];
    const request = vi.fn(async () => ({ Customer: { CustomerNumber: 'C-1' } }));
    const authorize = vi.fn(async (context: StagedAuthorizationContext) => {
      contexts.push(context);
      if (context.action === 'status' && !allowed) throw new Error('revoked');
      return allowed;
    });
    const runtime = await session({ authorize, transport: transport({ request }) });
    const prepared = await prepare(runtime.client, 'fortnox_create_customer', customerArgs());
    const completed = await call(runtime.client, 'staged_execute', {
      id: prepared.id,
      confirm: true,
    });
    expect(completed.isError).not.toBe(true);
    allowed = false;
    expect(
      errorText(
        await call(runtime.client, 'staged_prepare', {
          tool: 'fortnox_create_customer',
          args: customerArgs(),
        }),
      ),
    ).toMatch(/stoppades/i);
    expect(errorText(await call(runtime.client, 'staged_get', { id: prepared.id }))).toMatch(
      /stoppades/i,
    );
    expect(errorText(await call(runtime.client, 'staged_list'))).toMatch(/stoppades/i);
    expect(errorText(await call(runtime.client, 'fortnox_shadow_status'))).toMatch(/stoppades/i);
    expect(
      errorText(await call(runtime.client, 'staged_execute', { id: prepared.id, confirm: true })),
    ).toMatch(/stoppades/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(contexts.map((context) => context.action)).toEqual(
      expect.arrayContaining(['prepare', 'get', 'list', 'status', 'execute']),
    );
    expect(contexts[0]).toMatchObject({
      actorId: 'synthetic-owner',
      binding,
      revision,
      maxPreparationAgeMs: 60_000,
    });
    await closeSession(runtime);
  });

  it('enforces expiry equality and clock rollback while allowing authorized completed replay', async () => {
    let now = 10_000;
    const request = vi.fn(async () => ({ Customer: { CustomerNumber: 'C-1' } }));
    const runtime = await session({ now: () => now, transport: transport({ request }) });
    const completed = await prepare(
      runtime.client,
      'fortnox_create_customer',
      customerArgs('replayable'),
    );
    const first = await call(runtime.client, 'staged_execute', { id: completed.id, confirm: true });
    now += 60_000;
    expect(
      await call(runtime.client, 'staged_execute', { id: completed.id, confirm: true }),
    ).toEqual(first);
    const expired = await prepare(
      runtime.client,
      'fortnox_create_customer',
      customerArgs('expired'),
    );
    now = Number(jsonOf(await call(runtime.client, 'staged_get', { id: expired.id })).expiresAt);
    expect(
      errorText(await call(runtime.client, 'staged_execute', { id: expired.id, confirm: true })),
    ).toMatch(/stoppades/i);
    now = 9_999;
    expect(
      errorText(await call(runtime.client, 'staged_execute', { id: expired.id, confirm: true })),
    ).toMatch(/stoppades/i);
    expect(request).toHaveBeenCalledTimes(1);
    await closeSession(runtime);
  });

  it('persists prepared calls across restart and rejects binding, actor, or revision drift', async () => {
    const directory = root();
    const runtime = await session({ directory });
    const prepared = await prepare(
      runtime.client,
      'fortnox_create_customer',
      customerArgs('restartable'),
    );
    await closeSession(runtime);
    const reopened = await session({ directory });
    expect(jsonOf(await call(reopened.client, 'staged_get', { id: prepared.id }))).toMatchObject({
      id: prepared.id,
      state: 'prepared',
    });
    await closeSession(reopened);
    for (const options of [
      { binding: { ...binding, targetCompany: 'other-target' } },
      { actorId: 'other-owner' },
      { revision: 'b'.repeat(64) },
      { maxPreparationAgeMs: 61_000 },
    ]) {
      await expect(session({ directory, ...options })).rejects.toThrow(/mismatch/i);
    }
  });

  it('reports aggregate queue lag without exposing queue items', async () => {
    const runtime = await session();
    const prepared = await prepare(runtime.client, 'fortnox_create_customer', customerArgs());
    await call(runtime.client, 'staged_execute', { id: prepared.id, confirm: true });
    const status = jsonOf<JsonRecord>(await call(runtime.client, 'fortnox_shadow_status'));
    expect(status).toMatchObject({ enabled: true, binding, counts: { pending: 1 } });
    expect(status).not.toHaveProperty('items');
    expect(status).toHaveProperty('oldestUnappliedAgeMs');
    await closeSession(runtime);
  });

  it('creates distinct IDs for identical payloads and claims a duplicate execute only once', async () => {
    const started = deferred();
    const release = deferred();
    let count = 0;
    const request = vi.fn(async () => {
      count += 1;
      started.resolve();
      await release.promise;
      return { Customer: { CustomerNumber: `C-${count}` } };
    });
    const runtime = await session({ transport: transport({ request }) });
    const first = await prepare(runtime.client, 'fortnox_create_customer', customerArgs('same'));
    const second = await prepare(runtime.client, 'fortnox_create_customer', customerArgs('same'));
    expect(second.id).not.toBe(first.id);
    const firstExecution = call(runtime.client, 'staged_execute', { id: first.id, confirm: true });
    await started.promise;
    try {
      const duplicate = await call(runtime.client, 'staged_execute', {
        id: first.id,
        confirm: true,
      });
      expect(errorText(duplicate)).toMatch(/stoppades/i);
    } finally {
      release.resolve();
    }
    expect((await firstExecution).isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await closeSession(runtime);
  });

  it('marks thrown source outcomes unknown and never retries the source effect', async () => {
    const request = vi.fn(async () => {
      throw new Error('synthetic provider failure');
    });
    const runtime = await session({ transport: transport({ request }) });
    const prepared = await prepare(runtime.client, 'fortnox_create_customer', customerArgs());
    expect(
      errorText(await call(runtime.client, 'staged_execute', { id: prepared.id, confirm: true })),
    ).toMatch(/stoppades/i);
    expect(jsonOf(await call(runtime.client, 'staged_get', { id: prepared.id }))).toMatchObject({
      state: 'unknown',
    });
    expect(runtime.queue.get(`${prepared.id}:0`)).toMatchObject({ state: 'source_unknown' });
    expect(
      errorText(await call(runtime.client, 'staged_execute', { id: prepared.id, confirm: true })),
    ).toMatch(/stoppades/i);
    expect(request).toHaveBeenCalledTimes(1);
    await closeSession(runtime);
  });

  it('paginates at 100 with numeric cursors and summaries containing no args or results', async () => {
    const runtime = await session();
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      ids.push(
        (
          await prepare(
            runtime.client,
            'fortnox_create_customer',
            customerArgs(`customer-${index}`),
          )
        ).id as string,
      );
    }
    const first = jsonOf<{ items: JsonRecord[]; nextCursor: number | null }>(
      await call(runtime.client, 'staged_list', { limit: 100 }),
    );
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBe(100);
    expect(first.items[0]).toMatchObject({
      id: ids[0],
      tool: 'fortnox_create_customer',
      state: 'prepared',
    });
    expect(first.items[0]).not.toHaveProperty('args');
    expect(first.items[0]).not.toHaveProperty('result');
    const second = jsonOf<{ items: JsonRecord[]; nextCursor: number | null }>(
      await call(runtime.client, 'staged_list', { cursor: first.nextCursor!, limit: 100 }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).toBe(ids[100]);
    expect(second.nextCursor).toBeNull();
    await closeSession(runtime);
  });

  it('requires a private non-symlink directory and keeps its SQLite file private', async () => {
    const directory = root();
    const runtime = await session({ directory });
    const mode = statSync(join(directory, 'staged.sqlite')).mode & 0o777;
    expect(mode).toBe(0o600);
    await closeSession(runtime);
    const linkedRoot = root();
    const target = join(linkedRoot, 'target');
    const link = join(linkedRoot, 'link');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, link, 'dir');
    await expect(session({ directory: link })).rejects.toThrow(/private|directory/i);
    expect(readFileSync(join(directory, 'staged.sqlite'))).toBeDefined();
  });
});
