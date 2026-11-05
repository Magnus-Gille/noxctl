import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createServer as createEmbeddedServer } from '../../src/embedded.js';
import {
  createFortnoxOperations,
  defaultFortnoxOperations,
  setDefaultOperationObserver,
} from '../../src/operations/index.js';
import { OPERATION_CATALOGUE, observeOperations } from '../../src/shadow/operations.js';
import type { OperationObserver } from '../../src/shadow/types.js';

function stubTransport(): FortnoxTransport {
  return {
    request: vi.fn().mockResolvedValue({ Customer: { CustomerNumber: '42' } }),
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-test')),
    requestPdfFromMutation: vi.fn().mockResolvedValue(Buffer.from('%PDF-test')),
    requestFile: vi.fn(),
    fetchAllPages: vi.fn().mockResolvedValue({ items: [], totalResources: 0 }),
  } as FortnoxTransport;
}

function makeObserver(): OperationObserver {
  return {
    execute: vi.fn((_operation, _args, invoke) => invoke()),
    status: vi.fn(() => ({
      enabled: true,
      binding: { sourceCompany: 'source', targetCompany: 'target' },
      counts: {
        prepared: 0,
        source_in_flight: 0,
        source_unknown: 0,
        pending: 0,
        retry_wait: 0,
        target_in_flight: 0,
        target_unknown: 0,
        blocked: 0,
        applied: 0,
      },
      oldestUnappliedAgeMs: null,
      items: [],
    })),
  };
}

describe('operation observer seam', () => {
  it('keeps default aggregate semantics transparent without an observer', async () => {
    const transport = stubTransport();
    const operations = createFortnoxOperations(transport);
    await expect(operations.createCustomer({ Name: 'A' })).resolves.toEqual({
      CustomerNumber: '42',
    });
    expect(transport.request).toHaveBeenCalledWith('customers', {
      method: 'POST',
      body: { Customer: { Name: 'A' } },
    });
  });

  it('passes reads through and observes an outer write exactly once', async () => {
    const transport = stubTransport();
    const operationObserver = makeObserver();
    const operations = createFortnoxOperations(transport, operationObserver);
    await operations.getCustomer('42');
    expect(operationObserver.execute).not.toHaveBeenCalled();
    await operations.createCustomer({ Name: 'A' });
    expect(operationObserver.execute).toHaveBeenCalledTimes(1);
    expect(operationObserver.execute).toHaveBeenCalledWith(
      'createCustomer',
      [{ Name: 'A' }],
      expect.any(Function),
    );
  });

  it('looks up the default observer on each call without invoking the transport', async () => {
    const operationObserver = makeObserver();
    operationObserver.execute = vi.fn(async () => ({ CustomerNumber: 'observer-result' }));
    setDefaultOperationObserver(operationObserver);
    try {
      await expect(defaultFortnoxOperations.createCustomer({ Name: 'A' })).resolves.toEqual({
        CustomerNumber: 'observer-result',
      });
      expect(operationObserver.execute).toHaveBeenCalledOnce();
    } finally {
      setDefaultOperationObserver(undefined);
    }
  });

  it('keeps the default aggregate unobserved and synchronous when disabled', () => {
    setDefaultOperationObserver(undefined);
    const extension = defaultFortnoxOperations.extensionForMime('application/pdf');
    expect(extension).toBe('.pdf');
    expect(extension).not.toBeInstanceOf(Promise);
  });

  it.each([
    ['getOfferPdf', 'preview', false],
    ['getOfferPdf', 'print', true],
    ['getOrderPdf', 'preview', false],
    ['getOrderPdf', 'print', true],
  ] as const)('%s %s classification observes mutation=%s', async (name, mode, mutating) => {
    const transport = stubTransport();
    const operationObserver = makeObserver();
    const operations = createFortnoxOperations(transport, operationObserver);
    await operations[name]('42', mode);
    expect(operationObserver.execute).toHaveBeenCalledTimes(mutating ? 1 : 0);
  });

  it('catalogues every aggregate key and rejects unknown observed operations before invocation', async () => {
    const operations = createFortnoxOperations(stubTransport());
    expect(Object.keys(OPERATION_CATALOGUE).sort()).toEqual(Object.keys(operations).sort());

    const invoke = vi.fn().mockResolvedValue('called');
    const unobserved = { addedLater: vi.fn(() => 'synchronous') };
    expect(observeOperations(unobserved)).toBe(unobserved);
    expect(observeOperations(unobserved).addedLater()).toBe('synchronous');

    const wrapped = observeOperations({ notCatalogued: invoke }, makeObserver());
    expect(() => wrapped.notCatalogued()).toThrow(/no classification/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires an explicit embedded transport and exposes only the bound observer status', async () => {
    const operationObserver = makeObserver();
    expect(() => createEmbeddedServer({ observer: operationObserver } as never)).toThrow(
      /tenant-bound transport/i,
    );
    const server = createEmbeddedServer({
      transport: stubTransport(),
      observer: operationObserver,
    });
    const client = new Client({ name: 'shadow-status-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain('fortnox_shadow_status');
      const tool = tools.tools.find(({ name }) => name === 'fortnox_shadow_status');
      expect(tool?.inputSchema.properties ?? {}).toEqual({});
      const status = await client.callTool({ name: 'fortnox_shadow_status', arguments: {} });
      expect(operationObserver.status).toHaveBeenCalledOnce();
      expect(status.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it('keeps embedded company operations isolated to each bound transport', async () => {
    const makeTenantTransport = (companyName: string) =>
      ({
        ...stubTransport(),
        request: vi.fn().mockResolvedValue({ CompanyInformation: { CompanyName: companyName } }),
      }) as FortnoxTransport;
    const serverA = createEmbeddedServer({ transport: makeTenantTransport('Tenant A AB') });
    const serverB = createEmbeddedServer({ transport: makeTenantTransport('Tenant B AB') });
    const localObserver = makeObserver();
    const clientA = new Client({ name: 'tenant-a-test', version: '1.0.0' });
    const clientB = new Client({ name: 'tenant-b-test', version: '1.0.0' });
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      serverA.connect(serverTransportA),
      clientA.connect(clientTransportA),
      serverB.connect(serverTransportB),
      clientB.connect(clientTransportB),
    ]);
    setDefaultOperationObserver(localObserver);
    try {
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: 'fortnox_company_info', arguments: {} }),
        clientB.callTool({ name: 'fortnox_company_info', arguments: {} }),
      ]);
      expect(JSON.stringify(resultA)).toContain('Tenant A AB');
      expect(JSON.stringify(resultB)).toContain('Tenant B AB');
      expect(JSON.stringify(resultA)).not.toContain('Tenant B AB');
      expect(JSON.stringify(resultB)).not.toContain('Tenant A AB');
      await clientB.callTool({
        name: 'fortnox_create_customer',
        arguments: { Name: 'Embedded tenant customer', confirm: true },
      });
      expect(localObserver.execute).not.toHaveBeenCalled();
    } finally {
      setDefaultOperationObserver(undefined);
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });
  it('binds ordinary business arguments before an asynchronous observer can yield', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operationObserver = makeObserver();
    operationObserver.execute = async (_op, _args, invoke) => {
      await gate;
      return invoke();
    };
    const transport = stubTransport();
    const operations = createFortnoxOperations(transport, operationObserver);
    const input = { Name: 'Original' };
    const pending = operations.createCustomer(input);
    input.Name = 'Changed after capture';
    release();
    await pending;
    expect(transport.request).toHaveBeenCalledWith('customers', {
      method: 'POST',
      body: { Customer: { Name: 'Original' } },
    });
  });
});
