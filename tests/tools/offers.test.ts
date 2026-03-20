import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
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

describe('offer tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_offers', () => {
    it('lists offers', async () => {
      mockFetch({
        Offers: [
          { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
          { DocumentNumber: '2', CustomerName: 'Globex', Total: 5000 },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_offers', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Acme');
      expect(text).toContain('Globex');
    });

    it('filters by customer number', async () => {
      mockFetch({ Offers: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_offers',
        arguments: { customerNumber: '42' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
    });
  });

  describe('fortnox_get_offer', () => {
    it('fetches a single offer', async () => {
      mockFetch({
        Offer: { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_offer',
        arguments: { documentNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.DocumentNumber).toBe('1');
    });
  });

  describe('fortnox_create_offer', () => {
    it('creates an offer with confirmation', async () => {
      mockFetch({ Offer: { DocumentNumber: '2', CustomerNumber: '42', Total: 12500 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_offer',
        arguments: {
          CustomerNumber: '42',
          OfferRows: [{ Description: 'Konsulttimmar', DeliveredQuantity: 10, Price: 1000 }],
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Offer.CustomerNumber).toBe('42');
    });
  });

  describe('fortnox_create_invoice_from_offer', () => {
    it('converts offer to invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_from_offer',
        arguments: { documentNumber: '1', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('offers/1/createinvoice');
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('1001');
    });
  });

  describe('fortnox_create_order_from_offer', () => {
    it('converts offer to order', async () => {
      mockFetch({ Order: { DocumentNumber: '501' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_order_from_offer',
        arguments: { documentNumber: '1', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('offers/1/createorder');
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('501');
    });
  });
});
