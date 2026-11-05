import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../../src/embedded.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import {
  AccountedShadowAdapter,
  type AccountedRequest,
} from '../../src/shadow/accounted-adapter.js';
import { createQueueObserver } from '../../src/shadow/observer.js';
import { openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';
import type { OperationObserver, ShadowBinding } from '../../src/shadow/types.js';

const binding: ShadowBinding = {
  sourceCompany: 'fortnox-company-77',
  targetCompany: 'accounted-company-88',
};
const firstTargetId = '11111111-1111-4111-8111-111111111111';

function responseText(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content)) throw new Error('Expected immediate MCP tool result');
  const item = result.content.find((content) => content.type === 'text');
  if (typeof item?.text !== 'string' || !item.text)
    throw new Error('Expected text content from MCP tool');
  return item.text;
}

// A synthetic trusted host injects logical IDs. This is not a deployed client integration.
async function connect(queue: ShadowQueue, intentIdProvider: () => string) {
  const observer: OperationObserver = createQueueObserver(queue, intentIdProvider);
  const server = createServer({
    transport: makeFortnoxTransport(),
    observer,
  });
  const client = new Client({ name: 'shadow-integration-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const requestIds: Array<string | number> = [];
  const serverMessageHandler = serverTransport.onmessage;
  serverTransport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message)
      requestIds.push(message.id);
    serverMessageHandler?.(message, extra);
  };
  return { client, server, requestIds };
}

let fortnoxCalls: Array<{ endpoint: string; method: string; body?: unknown }>;
let accountedCalls: AccountedRequest[];
let targetMode: 'success' | 'unknown';

function makeFortnoxTransport(): FortnoxTransport {
  return {
    async request<T>(
      endpoint: string,
      options: { method?: string; body?: unknown } = {},
    ): Promise<T> {
      const method = options.method ?? 'GET';
      fortnoxCalls.push({ endpoint, method, body: options.body });
      if (endpoint !== 'customers' || method !== 'POST')
        throw new Error(`Unexpected synthetic Fortnox call: ${method} ${endpoint}`);
      const body = options.body as { Customer: Record<string, unknown> };
      return {
        Customer: {
          ...body.Customer,
          CustomerNumber: `F-${fortnoxCalls.length}`,
          Name: body.Customer.Name,
          Type: body.Customer.Type,
          CountryCode: body.Customer.CountryCode,
        },
      } as T;
    },
    async requestWithMetadata<T>(): Promise<T> {
      throw new Error('Unexpected synthetic Fortnox metadata call');
    },
    async requestPdf(): Promise<Buffer> {
      throw new Error('Unexpected synthetic Fortnox PDF call');
    },
    async requestPdfFromMutation(): Promise<Buffer | undefined> {
      throw new Error('Unexpected synthetic Fortnox PDF mutation');
    },
    async requestFile(): Promise<never> {
      throw new Error('Unexpected synthetic Fortnox file call');
    },
    async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
      items: T[];
      totalResources: number;
    }> {
      throw new Error('Unexpected synthetic Fortnox pagination call');
    },
  };
}

function makeAccountedAdapter(): AccountedShadowAdapter {
  return new AccountedShadowAdapter(binding.targetCompany, async (request) => {
    accountedCalls.push(request);
    const collectionPath = `/api/v1/companies/${binding.targetCompany}/customers`;
    if (request.path === collectionPath && request.method === 'POST') {
      if (targetMode === 'unknown')
        return { status: 429, json: { error: 'synthetic unknown outcome' } };
      return {
        status: 201,
        json: {
          data: { id: firstTargetId, ...(request.body as Record<string, unknown>) },
          meta: {},
        },
      };
    }
    if (request.method === 'GET' && request.path === `${collectionPath}/${firstTargetId}`) {
      const created = accountedCalls.find(
        (call) => call.method === 'POST' && call.path === collectionPath,
      );
      return {
        status: 200,
        json: {
          data: { id: firstTargetId, ...(created?.body as Record<string, unknown>) },
          meta: {},
        },
      };
    }
    throw new Error(
      `Unexpected synthetic Accounted path or method: ${request.method} ${request.path}`,
    );
  });
}

describe('synthetic Accounted shadow integration', () => {
  it('gates writes, queues one stable Fortnox intent, drains once, and pauses safely on unknown target outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noxctl-shadow-integration-'));
    fortnoxCalls = [];
    accountedCalls = [];
    targetMode = 'success';
    let queue = await openShadowQueue(join(root, 'queue'), binding);
    let currentIntent = 'first-intent';
    let session = await connect(queue, () => currentIntent);

    const customerArgs = (Name: string) => ({ Name, Type: 'COMPANY', CountryCode: 'SE' });
    try {
      const tools = await session.client.listTools();
      const createTool = tools.tools.find((tool) => tool.name === 'fortnox_create_customer');
      expect(createTool?.inputSchema.properties).toMatchObject({
        confirm: expect.any(Object),
        dryRun: expect.any(Object),
        Name: expect.any(Object),
        Type: expect.any(Object),
        CountryCode: expect.any(Object),
      });
      const statusTool = tools.tools.find((tool) => tool.name === 'fortnox_shadow_status');
      expect(statusTool?.inputSchema.properties).toEqual({});

      const unconfirmed = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: customerArgs('First Example AB'),
      });
      expect(unconfirmed.isError).toBe(true);
      expect(fortnoxCalls).toHaveLength(0);
      expect(accountedCalls).toHaveLength(0);
      expect(queue.status().items).toHaveLength(0);

      const dryRun = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: { ...customerArgs('First Example AB'), confirm: true, dryRun: true },
      });
      expect(dryRun.isError).not.toBe(true);
      expect(fortnoxCalls).toHaveLength(0);
      expect(accountedCalls).toHaveLength(0);
      expect(queue.status().items).toHaveLength(0);

      const firstArgs = { ...customerArgs('First Example AB'), confirm: true };
      currentIntent = 'first-intent';
      const firstResult = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: firstArgs,
      });
      expect(firstResult.isError).not.toBe(true);
      expect(responseText(firstResult)).toContain('F-1');
      expect(fortnoxCalls).toHaveLength(1);
      expect(accountedCalls).toHaveLength(0);
      const firstCall = fortnoxCalls[0]!;
      expect(firstCall).toMatchObject({
        endpoint: 'customers',
        method: 'POST',
        body: { Customer: { Name: 'First Example AB', Type: 'COMPANY', CountryCode: 'SE' } },
      });
      const firstIntentId = 'first-intent';
      const pending = queue.get(firstIntentId);
      expect(pending).toMatchObject({
        sourceCompany: binding.sourceCompany,
        targetCompany: binding.targetCompany,
        operation: 'createCustomer',
        state: 'pending',
        sourceResult: {
          Name: 'First Example AB',
          Type: 'COMPANY',
          CountryCode: 'SE',
          CustomerNumber: 'F-1',
        },
      });

      const status = await session.client.callTool({
        name: 'fortnox_shadow_status',
        arguments: {},
      });
      expect(JSON.parse(responseText(status))).toMatchObject({
        binding,
        counts: { pending: 1, applied: 0 },
        items: [expect.objectContaining({ id: firstIntentId, state: 'pending' })],
      });

      const adapter = makeAccountedAdapter();
      expect(await queue.drainOne(adapter)).toBe(true);
      expect(queue.get(firstIntentId)).toMatchObject({ state: 'applied', targetId: firstTargetId });
      expect(accountedCalls).toHaveLength(2);
      expect(accountedCalls.map(({ method, path }) => [method, path])).toEqual([
        ['POST', `/api/v1/companies/${binding.targetCompany}/customers`],
        ['GET', `/api/v1/companies/${binding.targetCompany}/customers/${firstTargetId}`],
      ]);
      expect(accountedCalls.every(({ path }) => path.includes('/customers'))).toBe(true);

      const repeated = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: firstArgs,
      });
      expect(repeated.isError).not.toBe(true);
      expect(fortnoxCalls).toHaveLength(1);
      expect(await queue.drainOne(adapter)).toBe(false);
      expect(accountedCalls).toHaveLength(2);

      await session.client.close();
      await session.server.close();
      queue.close();
      queue = await openShadowQueue(join(root, 'queue'), binding);
      expect(queue.get(firstIntentId)).toMatchObject({
        sourceCompany: binding.sourceCompany,
        targetCompany: binding.targetCompany,
        state: 'applied',
        targetId: firstTargetId,
      });
      session = await connect(queue, () => currentIntent);
      const replayAfterRestart = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: firstArgs,
      });
      expect(replayAfterRestart.isError).not.toBe(true);
      expect(responseText(replayAfterRestart)).toContain('F-1');
      expect(fortnoxCalls).toHaveLength(1);
      expect(await queue.drainOne(adapter)).toBe(false);
      expect(accountedCalls).toHaveLength(2);

      targetMode = 'unknown';
      currentIntent = 'second-intent';
      const second = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: { ...customerArgs('Second Example AB'), confirm: true },
      });
      expect(second.isError).not.toBe(true);
      const secondId = 'second-intent';
      expect(queue.get(secondId)?.state).toBe('pending');
      expect(await queue.drainOne(adapter)).toBe(false);
      expect(queue.get(secondId)?.state).toBe('target_unknown');
      expect(accountedCalls).toHaveLength(3);
      expect(await queue.drainOne(adapter)).toBe(false);
      expect(accountedCalls).toHaveLength(3);

      currentIntent = 'third-intent';
      const third = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: { ...customerArgs('Third Example AB'), confirm: true },
      });
      expect(third.isError).not.toBe(true);
      expect(fortnoxCalls).toHaveLength(3);
      expect(queue.get('third-intent')?.state).toBe('pending');
      expect(await queue.drainOne(adapter)).toBe(false);
      expect(accountedCalls).toHaveLength(3);
      expect(fortnoxCalls.every(({ endpoint }) => endpoint === 'customers')).toBe(true);
      expect(
        accountedCalls.every(({ path }) =>
          /^\/api\/v1\/companies\/[^/]+\/customers(?:\/[0-9a-f-]+)?$/.test(path),
        ),
      ).toBe(true);
    } finally {
      await session.client.close();
      await session.server.close();
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches identical payloads twice under distinct explicit host intents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noxctl-shadow-integration-'));
    fortnoxCalls = [];
    accountedCalls = [];
    targetMode = 'success';
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    let currentIntent = 'identical-a';
    const session = await connect(queue, () => currentIntent);
    const customerArgs = { Name: 'Identical Payload AB', Type: 'COMPANY', CountryCode: 'SE' };
    try {
      const first = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: { ...customerArgs, confirm: true },
      });
      currentIntent = 'identical-b';
      const second = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: { ...customerArgs, confirm: true },
      });

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(fortnoxCalls).toHaveLength(2);
      expect(queue.status().items.map(({ id }) => id)).toEqual(['identical-a', 'identical-b']);
    } finally {
      await session.client.close();
      await session.server.close();
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays the original receipt for the same explicit intent after reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noxctl-shadow-integration-'));
    fortnoxCalls = [];
    accountedCalls = [];
    targetMode = 'success';
    let queue = await openShadowQueue(join(root, 'queue'), binding);
    const currentIntent = 'reconnect-intent';
    let session = await connect(queue, () => currentIntent);
    const customerArgs = {
      Name: 'Reconnect AB',
      Type: 'COMPANY',
      CountryCode: 'SE',
      confirm: true,
    };
    try {
      const first = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: customerArgs,
      });
      expect(first.isError).not.toBe(true);
      expect(responseText(first)).toContain('F-1');
      await session.client.close();
      await session.server.close();
      queue.close();

      queue = await openShadowQueue(join(root, 'queue'), binding);
      session = await connect(queue, () => currentIntent);
      const replay = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: customerArgs,
      });
      expect(replay.isError).not.toBe(true);
      expect(responseText(replay)).toContain('F-1');
      expect(fortnoxCalls).toHaveLength(1);
      expect(queue.status().items).toEqual([
        expect.objectContaining({ id: currentIntent, state: 'pending' }),
      ]);
    } finally {
      await session.client.close();
      await session.server.close();
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects changed payloads for a reused explicit intent without a second source call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noxctl-shadow-integration-'));
    fortnoxCalls = [];
    accountedCalls = [];
    targetMode = 'success';
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const currentIntent = 'changed-payload-intent';
    const session = await connect(queue, () => currentIntent);
    try {
      const first = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: {
          Name: 'Original Payload AB',
          Type: 'COMPANY',
          CountryCode: 'SE',
          confirm: true,
        },
      });
      const changed = await session.client.callTool({
        name: 'fortnox_create_customer',
        arguments: {
          Name: 'Changed Payload AB',
          Type: 'COMPANY',
          CountryCode: 'SE',
          confirm: true,
        },
      });

      expect(first.isError).not.toBe(true);
      expect(changed.isError).toBe(true);
      expect(responseText(changed)).toContain('Shadow intent identity conflict');
      expect(fortnoxCalls).toHaveLength(1);
      expect(queue.status().items).toHaveLength(1);
    } finally {
      await session.client.close();
      await session.server.close();
      queue.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps four concurrent sessions distinct with fixed host intents and identical payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noxctl-shadow-integration-'));
    fortnoxCalls = [];
    accountedCalls = [];
    targetMode = 'success';
    const queue = await openShadowQueue(join(root, 'queue'), binding);
    const intentIds = ['concurrent-a', 'concurrent-b', 'concurrent-c', 'concurrent-d'];
    const queues = [
      queue,
      ...(await Promise.all(
        intentIds.slice(1).map(() => openShadowQueue(join(root, 'queue'), binding)),
      )),
    ];
    const sessions = await Promise.all(
      intentIds.map((id, index) => connect(queues[index]!, () => id)),
    );
    const customerArgs = { Name: 'Concurrent Payload AB', Type: 'COMPANY', CountryCode: 'SE' };
    try {
      const results = await Promise.all(
        sessions.map((session) =>
          session.client.callTool({
            name: 'fortnox_create_customer',
            arguments: { ...customerArgs, confirm: true },
          }),
        ),
      );

      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(fortnoxCalls).toHaveLength(4);
      expect(
        queue
          .status()
          .items.map(({ id }) => id)
          .sort(),
      ).toEqual([...intentIds].sort());
      expect(queue.status().counts.pending).toBe(4);
      const sourceNumbers = intentIds.map(
        (id) => (queue.get(id)?.sourceResult as { CustomerNumber: string }).CustomerNumber,
      );
      expect(new Set(sourceNumbers).size).toBe(4);
      const requestIds = sessions.flatMap(({ requestIds: ids }) => ids);
      expect(requestIds).toHaveLength(4);
      expect(new Set(requestIds).size).toBe(1);
    } finally {
      await Promise.all(
        sessions.flatMap((session) => [session.client.close(), session.server.close()]),
      );
      queues.forEach((connection) => connection.close());
      await rm(root, { recursive: true, force: true });
    }
  });
});
