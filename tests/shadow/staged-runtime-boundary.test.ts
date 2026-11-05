import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { createStagedServer, type FortnoxTransport } from '../../src/embedded.js';
import { createStrictMcpServer, parseStrictToolInput } from '../../src/strict-mcp-server.js';

it('retains an actual killed runtime source claim across a new host process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-runtime-crash-'));
  const embedded = pathToFileURL(join(process.cwd(), 'dist/embedded.js')).href;
  const clientModule = pathToFileURL(
    join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  ).href;
  const transportModule = pathToFileURL(
    join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js'),
  ).href;
  const script = `
    import { createStagedServer } from ${JSON.stringify(embedded)};
    import { Client } from ${JSON.stringify(clientModule)};
    import { InMemoryTransport } from ${JSON.stringify(transportModule)};
    import { writeFileSync } from 'node:fs';
    const directory = ${JSON.stringify(directory)};
    const unsupported = async () => { throw new Error('Unexpected synthetic operation'); };
    const host = await createStagedServer({ directory,
      actorId:'synthetic-owner', revision:'a'.repeat(64), maxPreparationAgeMs:60000,
      binding:{sourceCompany:'synthetic-source',targetCompany:'synthetic-target'}, authorize:async()=>true,
      transport:{ request:async()=>{
        writeFileSync(directory+'/effect','once');
        process.kill(process.pid,'SIGKILL');
        await new Promise(()=>{});
      },requestWithMetadata:unsupported,requestPdf:unsupported,requestPdfFromMutation:unsupported,requestFile:unsupported,fetchAllPages:unsupported}
    });
    const client=new Client({name:'synthetic-kill',version:'1'});
    const [ct,st]=InMemoryTransport.createLinkedPair();
    await Promise.all([host.server.connect(st),client.connect(ct)]);
    const prepared=await client.callTool({name:'staged_prepare',arguments:{tool:'fortnox_create_customer',args:{Name:'Synthetic',confirm:true}}});
    const {id}=JSON.parse(prepared.content[0].text);
    writeFileSync(directory+'/id',id);
    await client.callTool({name:'staged_execute',arguments:{id,confirm:true}});
  `;
  let host: Awaited<ReturnType<typeof createStagedServer>> | undefined;
  let client: Client | undefined;
  try {
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin' },
      timeout: 10000,
      encoding: 'utf8',
    });
    expect(killed.error).toBeUndefined();
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(readFileSync(join(directory, 'effect'), 'utf8')).toBe('once');
    const id = readFileSync(join(directory, 'id'), 'utf8');
    const request = vi.fn();
    host = await createStagedServer({
      directory,
      actorId: 'synthetic-owner',
      revision: 'a'.repeat(64),
      maxPreparationAgeMs: 60000,
      binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
      authorize: async () => true,
      transport: { request } as unknown as FortnoxTransport,
    });
    client = new Client({ name: 'synthetic-reopen', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.server.connect(st), client.connect(ct)]);
    const get = (await client.callTool({
      name: 'staged_get',
      arguments: { id },
    })) as CallToolResult;
    const text = get.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing recovered record');
    expect(JSON.parse(text.text)).toMatchObject({ id, state: 'executing' });
    expect(host.queue.get(`${id}:0`)).toMatchObject({ state: 'source_in_flight' });
    const result = await client.callTool({
      name: 'staged_execute',
      arguments: { id, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await client?.close();
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('validates the registered schema without invoking its callback', async () => {
  const server = createStrictMcpServer({ name: 'synthetic-validation', version: '1' });
  const callback = vi.fn(async () => ({ content: [] }));
  server.tool('sample', 'synthetic', { name: z.string() }, callback);
  expect(parseStrictToolInput(server, 'sample', { name: 'Sample' })).toEqual({ name: 'Sample' });
  expect(() => parseStrictToolInput(server, 'sample', {})).toThrow();
  expect(() => parseStrictToolInput(server, 'sample', { name: 'Sample', extra: true })).toThrow();
  expect(() => parseStrictToolInput(server, 'missing', {})).toThrow();
  expect(callback).not.toHaveBeenCalled();
  await server.close();
});

it.each(['dispatch-message', 'initial-name'] as const)(
  'does not expose or persist an authorization exception (%s)',
  async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), 'staged-runtime-diagnostic-'));
    let executions = 0;
    const sentinel = 'SYNTHETIC_PRIVATE_AUTH_DIAGNOSTIC';
    const request = vi.fn();
    const host = await createStagedServer({
      directory,
      actorId: 'synthetic-owner',
      revision: 'a'.repeat(64),
      maxPreparationAgeMs: 60000,
      binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
      authorize: async ({ action }) => {
        if (action === 'execute') {
          executions++;
          if (stage === 'initial-name') {
            const error = new Error('synthetic');
            error.name = sentinel;
            throw error;
          }
          if (executions === 2) throw new Error(sentinel);
        }
        return true;
      },
      transport: { request } as unknown as FortnoxTransport,
    });
    const client = new Client({ name: 'synthetic-diagnostic-test', version: '1' });
    try {
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([host.server.connect(st), client.connect(ct)]);
      const prepared = (await client.callTool({
        name: 'staged_prepare',
        arguments: {
          tool: 'fortnox_create_customer',
          args: { Name: 'Synthetic', confirm: true },
        },
      })) as CallToolResult;
      const text = prepared.content.find((item) => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('Missing preparation');
      const { id } = JSON.parse(text.text) as { id: string };
      const result = await client.callTool({
        name: 'staged_execute',
        arguments: { id, confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      const get = await client.callTool({ name: 'staged_get', arguments: { id } });
      const replay = await client.callTool({
        name: 'staged_execute',
        arguments: { id, confirm: true },
      });
      expect(JSON.stringify([get, replay])).not.toContain(sentinel);
      expect(replay.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(host.queue.status().items).toHaveLength(0);
      expect(readFileSync(join(directory, 'staged.sqlite')).includes(Buffer.from(sentinel))).toBe(
        false,
      );
    } finally {
      await client.close();
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('preserves a successful source receipt when the outer completed receipt cannot persist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-runtime-receipt-'));
  const request = vi.fn(async () => ({ Customer: { CustomerNumber: 'S1' } }));
  const host = await createStagedServer({
    directory,
    actorId: 'synthetic-owner',
    revision: 'a'.repeat(64),
    maxPreparationAgeMs: 60000,
    binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
    authorize: async () => true,
    transport: { request } as unknown as FortnoxTransport,
  });
  const fault = new DatabaseSync(join(directory, 'staged.sqlite'));
  const client = new Client({ name: 'synthetic-receipt-failure', version: '1' });
  try {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.server.connect(st), client.connect(ct)]);
    const result = (await client.callTool({
      name: 'staged_prepare',
      arguments: { tool: 'fortnox_create_customer', args: { Name: 'Synthetic', confirm: true } },
    })) as CallToolResult;
    const text = result.content.find((item) => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing preparation');
    const { id } = JSON.parse(text.text) as { id: string };
    fault.exec(
      "CREATE TRIGGER reject_completed BEFORE UPDATE ON staged_calls WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL, 'synthetic receipt failure'); END;",
    );
    expect(
      (await client.callTool({ name: 'staged_execute', arguments: { id, confirm: true } })).isError,
    ).toBe(true);
    expect(host.queue.get(`${id}:0`)).toMatchObject({
      state: 'pending',
      sourceResult: { CustomerNumber: 'S1' },
    });
    expect(fault.prepare('SELECT state FROM staged_calls WHERE id=?').get(id)?.state).toBe(
      'unknown',
    );
    fault.exec('DROP TRIGGER reject_completed');
    expect(
      (await client.callTool({ name: 'staged_execute', arguments: { id, confirm: true } })).isError,
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    fault.close();
    await client.close();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rechecks expiry after asynchronous dispatch authorization before a source effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'staged-expiry-'));
  let time = 1000;
  let executions = 0;
  let effects = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected fixture operation');
  };
  const transport: FortnoxTransport = {
    request: async <T>() => {
      effects++;
      return { Customer: { CustomerNumber: 'S1' } } as T;
    },
    requestWithMetadata: unavailable,
    requestPdf: unavailable,
    requestPdfFromMutation: unavailable,
    requestFile: unavailable,
    fetchAllPages: unavailable,
  };
  const host = await createStagedServer({
    directory,
    transport,
    actorId: 'synthetic-owner',
    revision: 'a'.repeat(64),
    binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
    maxPreparationAgeMs: 1000,
    now: () => time,
    authorize: async ({ action }) => {
      if (action === 'execute' && ++executions === 2) time = 2000;
      return true;
    },
  });
  const client = new Client({ name: 'synthetic-expiry-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([host.server.connect(st), client.connect(ct)]);
    const prepared = (await client.callTool({
      name: 'staged_prepare',
      arguments: {
        tool: 'fortnox_create_customer',
        args: { Name: 'Synthetic', confirm: true },
      },
    })) as CallToolResult;
    const content = prepared.content.find((item) => item.type === 'text');
    if (!content || content.type !== 'text') throw new Error('Missing preparation receipt');
    const { id } = JSON.parse(content.text) as { id: string };
    const result = await client.callTool({
      name: 'staged_execute',
      arguments: { id, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(effects).toBe(0);
    expect(host.queue.status().items).toHaveLength(0);
  } finally {
    await client.close();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
