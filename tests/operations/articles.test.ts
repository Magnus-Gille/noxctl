import { describe, it, expect, vi, afterEach } from 'vitest';
import { DOCUMENT_API_ENV } from '../../src/document-api-version.js';

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

describe('article operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listArticles', () => {
    it('maps search to description query param', async () => {
      mockFetch({ Articles: [], MetaInformation: {} });
      const { listArticles } = await import('../../src/operations/articles.js');

      await listArticles({ search: 'Workshop' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('description=Workshop');
    });

    it('passes page and limit params', async () => {
      mockFetch({ Articles: [], MetaInformation: {} });
      const { listArticles } = await import('../../src/operations/articles.js');

      await listArticles({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        Articles: [{ ArticleNumber: '1', Description: 'Workshop' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listArticles } = await import('../../src/operations/articles.js');

      const result = await listArticles();
      expect(result.Articles).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getArticle', () => {
    it('unwraps the Article envelope', async () => {
      mockFetch({ Article: { ArticleNumber: '1', Description: 'Workshop' } });
      const { getArticle } = await import('../../src/operations/articles.js');

      const result = await getArticle('1');
      expect(result.ArticleNumber).toBe('1');
      expect(result.Description).toBe('Workshop');
    });

    it('encodes article number in URL', async () => {
      mockFetch({ Article: { ArticleNumber: 'A/B', Description: 'Test' } });
      const { getArticle } = await import('../../src/operations/articles.js');

      await getArticle('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('articles-v2/A%2FB');
    });
  });

  describe('createArticle', () => {
    it('wraps params in Article envelope for POST', async () => {
      mockFetch({ Article: { ArticleNumber: '4', Description: 'New Article' } });
      const { createArticle } = await import('../../src/operations/articles.js');

      await createArticle({ Description: 'New Article', SalesPrice: 1500 });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Article.Description).toBe('New Article');
      expect(body.Article.SalesPrice).toBe(1500);
    });

    it('unwraps the response', async () => {
      mockFetch({ Article: { ArticleNumber: '4', Description: 'New Article' } });
      const { createArticle } = await import('../../src/operations/articles.js');

      const result = await createArticle({ Description: 'New Article' });
      expect(result.ArticleNumber).toBe('4');
    });
  });

  describe('updateArticle', () => {
    it('uses PUT and excludes ArticleNumber from body', async () => {
      mockFetch({ Article: { ArticleNumber: '1', Description: 'Updated' } });
      const { updateArticle } = await import('../../src/operations/articles.js');

      await updateArticle('1', { ArticleNumber: '1', Description: 'Updated' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('articles-v2/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Article.Description).toBe('Updated');
      expect(body.Article.ArticleNumber).toBeUndefined();
    });
  });

  describe('deleteArticle', () => {
    it('uses DELETE and encodes the article number', async () => {
      mockFetch({});
      const { deleteArticle } = await import('../../src/operations/articles.js');

      await deleteArticle('A/B');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('articles-v2/A%2FB');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });

  describe('calculateBundlePrices', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const rows = [
      {
        Price: 1100,
        Quantity: 2,
        Bundle: {
          SubRows: [
            { Quantity: 4, BundleSubItem: { AmountInBundle: 2, SalesPriceInBundle: 200 } },
            {
              Quantity: 1,
              BundleSubItem: { AmountInBundle: 0, SalesPriceInBundle: 0, PriceAdjustment: true },
            },
          ],
        },
      },
    ];

    it('POSTs the rows in a BundlePriceCalculation envelope and unwraps the result', async () => {
      const calculated = { Rows: [{ ...rows[0], Bundle: { SubRows: [{ Price: 169.23 }] } }] };
      mockFetch({ BundlePriceCalculation: calculated });
      const { calculateBundlePrices } = await import('../../src/operations/articles.js');

      const result = await calculateBundlePrices(rows);

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('/3/articles-v2/calculatebundleprices');
      expect(fetchCall[1].method).toBe('POST');
      expect(JSON.parse(fetchCall[1].body)).toEqual({ BundlePriceCalculation: { Rows: rows } });
      expect(result).toEqual(calculated);
    });

    it('always uses the v2 endpoint, which has no classic counterpart', async () => {
      vi.stubEnv(DOCUMENT_API_ENV, 'classic');
      mockFetch({ BundlePriceCalculation: { Rows: [] } });
      const { calculateBundlePrices } = await import('../../src/operations/articles.js');

      await calculateBundlePrices(rows);

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/3/articles-v2/calculatebundleprices');
    });

    it('refuses an empty row list without calling Fortnox', async () => {
      mockFetch({});
      const { calculateBundlePrices } = await import('../../src/operations/articles.js');

      await expect(calculateBundlePrices([])).rejects.toThrow(/at least one/i);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
