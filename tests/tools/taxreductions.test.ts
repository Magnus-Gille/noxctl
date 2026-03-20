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

describe('tax reduction tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_taxreductions', () => {
    it('lists tax reductions', async () => {
      const mockData = {
        TaxReductions: [
          { Id: 1, CustomerName: 'Kund AB', TypeOfReduction: 'rot', AskedAmount: 50000 },
          { Id: 2, CustomerName: 'Kund CD', TypeOfReduction: 'rut', AskedAmount: 25000 },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_taxreductions',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Kund AB');
      expect(text).toContain('Kund CD');
    });

    it('supports filter', async () => {
      mockFetch({ TaxReductions: [], MetaInformation: {} });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_taxreductions',
        arguments: { filter: 'invoices' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=invoices');
    });
  });

  describe('fortnox_get_taxreduction', () => {
    it('fetches a single tax reduction', async () => {
      mockFetch({
        TaxReduction: {
          Id: 1,
          CustomerName: 'Kund AB',
          TypeOfReduction: 'rot',
          AskedAmount: 50000,
          ApprovedAmount: 45000,
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_taxreduction',
        arguments: { id: 1, includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Id).toBe(1);
      expect(parsed.TypeOfReduction).toBe('rot');
    });
  });

  describe('fortnox_create_taxreduction', () => {
    it('creates a tax reduction', async () => {
      mockFetch({
        TaxReduction: { Id: 3, TypeOfReduction: 'rut', ReferenceNumber: '10' },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_taxreduction',
        arguments: {
          ReferenceNumber: '10',
          ReferenceDocumentType: 'INVOICE',
          TypeOfReduction: 'rut',
          CustomerName: 'Test Kund',
          AskedAmount: 25000,
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.TaxReduction.TypeOfReduction).toBe('rut');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_taxreduction',
        arguments: {
          ReferenceNumber: '10',
          ReferenceDocumentType: 'INVOICE',
          TypeOfReduction: 'rut',
          CustomerName: 'Test',
          AskedAmount: 10000,
          dryRun: true,
        },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_taxreduction',
        arguments: {
          ReferenceNumber: '10',
          ReferenceDocumentType: 'INVOICE',
          TypeOfReduction: 'rut',
          CustomerName: 'Test',
          AskedAmount: 10000,
        },
      });

      expect(result.isError).toBe(true);
    });
  });
});
