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

describe('supplier invoice tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_supplier_invoices', () => {
    it('lists supplier invoices', async () => {
      mockFetch({
        SupplierInvoices: [
          { GivenNumber: 1, SupplierName: 'Apple', Total: 1299 },
          { GivenNumber: 2, SupplierName: 'Fortnox AB', Total: 2490 },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoices',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Apple');
      expect(text).toContain('Fortnox');
    });

    it('passes filter parameter', async () => {
      mockFetch({ SupplierInvoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_supplier_invoices',
        arguments: { filter: 'unpaid' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaid');
    });
  });

  describe('fortnox_get_supplier_invoice', () => {
    it('fetches a single supplier invoice', async () => {
      mockFetch({
        SupplierInvoice: {
          GivenNumber: 1,
          SupplierName: 'Apple',
          Total: 1299,
          InvoiceNumber: 'UA30394930',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice',
        arguments: { givenNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.InvoiceNumber).toBe('UA30394930');
    });
  });

  describe('fortnox_create_supplier_invoice', () => {
    it('creates a supplier invoice with confirmation', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 10, SupplierNumber: '5', Total: 1250 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: {
          SupplierNumber: '5',
          Total: 1250,
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoice.SupplierNumber).toBe('5');
    });

    it('requires confirmation', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: { SupplierNumber: '5' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('supports dry run', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: { SupplierNumber: '5', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_bookkeep_supplier_invoice', () => {
    it('bookkeeps with confirmation', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 1, Booked: true },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_bookkeep_supplier_invoice',
        arguments: { givenNumber: '1', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('supplierinvoices/1/bookkeep');
    });

    it('requires confirmation', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_bookkeep_supplier_invoice',
        arguments: { givenNumber: '1' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
