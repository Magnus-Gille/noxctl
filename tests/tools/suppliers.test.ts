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
          { SupplierNumber: '1', Name: 'Nordic Office AB' },
          { SupplierNumber: '2', Name: 'Sample Hosting AB' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_suppliers', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Nordic Office AB');
      expect(text).toContain('Sample Hosting AB');
    });
  });

  describe('fortnox_get_supplier', () => {
    it('fetches a single supplier', async () => {
      mockFetch({
        Supplier: {
          SupplierNumber: '1',
          Name: 'Nordic Office AB',
          Email: 'billing@nordic-office.example',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier',
        arguments: { supplierNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Name).toBe('Nordic Office AB');
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

  // Issue #96: the MCP SDK silently strips any argument the Zod schema does not
  // declare, so an undeclared field reaches neither Fortnox nor an error message.
  describe('supplier write schemas cover the real Supplier resource', () => {
    const extendedFields = {
      YourReference: 'Anna Andersson',
      OurReference: 'Magnus',
      Comments: 'Preferred supplier',
      Address2: 'Plan 4',
      CountryCode: 'SE',
      Currency: 'SEK',
      VATNumber: 'SE556677889901',
      VATType: 'SEVAT',
      CostCenter: 'CC1',
      Project: '12',
      TermsOfPayment: '30',
      Bank: 'Handelsbanken',
      BIC: 'HANDSESS',
      IBAN: 'SE4550000000058398257466',
      ClearingNumber: '6789',
      DisablePaymentFile: false,
      PreDefinedAccount: '2440',
      WorkPlace: 'Stockholm',
      Active: true,
    };

    it('forwards extended fields on create', async () => {
      mockFetch({ Supplier: { SupplierNumber: '3' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_supplier',
        arguments: { Name: 'New Supplier', confirm: true, ...extendedFields },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(fetchCall[1].body as string).Supplier;
      for (const [key, value] of Object.entries(extendedFields)) {
        expect(sent[key]).toEqual(value);
      }
    });

    it('forwards extended fields on update', async () => {
      mockFetch({ Supplier: { SupplierNumber: '3' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_supplier',
        arguments: { supplierNumber: '3', confirm: true, ...extendedFields },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(fetchCall[1].body as string).Supplier;
      for (const [key, value] of Object.entries(extendedFields)) {
        expect(sent[key]).toEqual(value);
      }
      expect(sent.supplierNumber).toBeUndefined();
    });
  });
});
