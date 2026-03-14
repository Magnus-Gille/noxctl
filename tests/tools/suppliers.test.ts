import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('supplier tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_suppliers', () => {
    it('lists suppliers', async () => {
      mockFetch({
        Suppliers: [
          { SupplierNumber: '1', Name: 'Anthropic' },
          { SupplierNumber: '2', Name: 'Apple' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_suppliers', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Anthropic');
      expect(text).toContain('Apple');
    });
  });

  describe('fortnox_get_supplier', () => {
    it('fetches a single supplier', async () => {
      mockFetch({
        Supplier: { SupplierNumber: '1', Name: 'Anthropic', Email: 'billing@anthropic.com' },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier',
        arguments: { supplierNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Name).toBe('Anthropic');
    });
  });

  describe('fortnox_create_supplier', () => {
    it('creates a supplier with confirmation', async () => {
      mockFetch({ Supplier: { SupplierNumber: '3', Name: 'New Supplier' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_supplier',
        arguments: { Name: 'New Supplier', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
    });

    it('requires confirmation', async () => {
      mockFetch({ Supplier: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier',
        arguments: { Name: 'Test' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
