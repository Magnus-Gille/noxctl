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

describe('price list tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_pricelists', () => {
    it('lists price lists', async () => {
      const mockData = {
        PriceLists: [
          { Code: 'A', Description: 'Standard' },
          { Code: 'B', Description: 'Premium' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_pricelists', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Standard');
      expect(text).toContain('Premium');
    });
  });

  describe('fortnox_get_pricelist', () => {
    it('fetches a single price list', async () => {
      mockFetch({
        PriceList: { Code: 'A', Description: 'Standard', PreSelected: true },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_pricelist',
        arguments: { code: 'A', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Code).toBe('A');
    });
  });

  describe('fortnox_create_pricelist', () => {
    it('creates a price list', async () => {
      mockFetch({ PriceList: { Code: 'C', Description: 'Ny lista' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_pricelist',
        arguments: { Code: 'C', Description: 'Ny lista', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_pricelist',
        arguments: { Code: 'C', Description: 'Test' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_update_pricelist', () => {
    it('updates a price list', async () => {
      mockFetch({ PriceList: { Code: 'A', Description: 'Uppdaterad' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_pricelist',
        arguments: { code: 'A', Description: 'Uppdaterad', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('pricelists/A');
      expect(fetchCall[1].method).toBe('PUT');
    });
  });
});

describe('price tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_prices', () => {
    it('lists prices for a price list', async () => {
      mockFetch({
        Prices: [
          { ArticleNumber: 'ART1', Price: 100, FromQuantity: 0 },
          { ArticleNumber: 'ART2', Price: 200, FromQuantity: 0 },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_prices',
        arguments: { priceListCode: 'A' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('ART1');
      expect(text).toContain('ART2');
    });
  });

  describe('fortnox_get_price', () => {
    it('fetches a single price', async () => {
      mockFetch({
        Price: { ArticleNumber: 'ART1', PriceList: 'A', Price: 150, FromQuantity: 0 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_price',
        arguments: { priceListCode: 'A', articleNumber: 'ART1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Price).toBe(150);
    });
  });

  describe('fortnox_update_price', () => {
    it('updates a price', async () => {
      mockFetch({ Price: { ArticleNumber: 'ART1', PriceList: 'A', Price: 200 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_price',
        arguments: {
          priceListCode: 'A',
          articleNumber: 'ART1',
          Price: 200,
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('prices/A/ART1/0');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_price',
        arguments: { priceListCode: 'A', articleNumber: 'ART1', Price: 200 },
      });

      expect(result.isError).toBe(true);
    });
  });
});
