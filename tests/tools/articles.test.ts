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

describe('article tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_articles', () => {
    it('lists articles with default pagination', async () => {
      const mockData = {
        Articles: [
          { ArticleNumber: '1', Description: 'Workshop' },
          { ArticleNumber: '2', Description: 'Resa' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_articles', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Workshop');
      expect(text).toContain('Resa');
    });

    it('searches articles by description', async () => {
      mockFetch({ Articles: [{ ArticleNumber: '1', Description: 'Workshop' }] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_articles',
        arguments: { search: 'Workshop' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('description=Workshop');
    });

    it('supports pagination', async () => {
      mockFetch({ Articles: [], MetaInformation: { '@CurrentPage': 2 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_articles',
        arguments: { page: 2, limit: 25 },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });
  });

  describe('fortnox_get_article', () => {
    it('fetches a single article', async () => {
      mockFetch({
        Article: { ArticleNumber: '1', Description: 'Workshop', SalesPrice: 15000 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_article',
        arguments: { articleNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.ArticleNumber).toBe('1');
      expect(parsed.Description).toBe('Workshop');
    });

    it('returns error for non-existent article', async () => {
      mockFetch({ ErrorInformation: { message: 'Article not found', code: 2000428 } }, false, 404);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_article',
        arguments: { articleNumber: '999999' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_create_article', () => {
    it('creates an article with required fields', async () => {
      mockFetch({ Article: { ArticleNumber: '4', Description: 'Ny Artikel' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_article',
        arguments: { Description: 'Ny Artikel', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Article.Description).toBe('Ny Artikel');
    });

    it('creates an article with all optional fields', async () => {
      mockFetch({ Article: { ArticleNumber: '5', Description: 'Full Artikel' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_article',
        arguments: {
          Description: 'Full Artikel',
          ArticleNumber: 'ART-005',
          SalesPrice: 2500,
          PurchasePrice: 1000,
          Unit: 'tim',
          SalesAccount: 3001,
          VAT: 25,
          confirm: true,
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Article.SalesPrice).toBe(2500);
      expect(body.Article.Unit).toBe('tim');
      expect(body.Article.SalesAccount).toBe(3001);
    });

    it('supports dry run', async () => {
      mockFetch({ Article: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_article',
        arguments: { Description: 'Test', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('requires confirmation', async () => {
      mockFetch({ Article: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_article',
        arguments: { Description: 'Test' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_update_article', () => {
    it('updates specific fields', async () => {
      mockFetch({
        Article: { ArticleNumber: '1', Description: 'Updated Workshop', SalesPrice: 20000 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_article',
        arguments: { articleNumber: '1', SalesPrice: 20000, confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('articles/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Article.SalesPrice).toBe(20000);
    });

    it('requires confirmation before updating', async () => {
      mockFetch({ Article: { ArticleNumber: '1' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_article',
        arguments: { articleNumber: '1', SalesPrice: 20000 },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
