import { describe, it, expect, vi, afterEach } from 'vitest';

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

describe('price list operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listPriceLists', () => {
    it('passes page and limit params', async () => {
      mockFetch({ PriceLists: [], MetaInformation: {} });
      const { listPriceLists } = await import('../../src/operations/pricelists.js');

      await listPriceLists({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        PriceLists: [{ Code: 'A', Description: 'Standard' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listPriceLists } = await import('../../src/operations/pricelists.js');

      const result = await listPriceLists();
      expect(result.PriceLists).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getPriceList', () => {
    it('unwraps the PriceList envelope', async () => {
      mockFetch({ PriceList: { Code: 'A', Description: 'Standard' } });
      const { getPriceList } = await import('../../src/operations/pricelists.js');

      const result = await getPriceList('A');
      expect(result.Code).toBe('A');
      expect(result.Description).toBe('Standard');
    });
  });

  describe('createPriceList', () => {
    it('wraps params in PriceList envelope for POST', async () => {
      mockFetch({ PriceList: { Code: 'B', Description: 'Ny prislista' } });
      const { createPriceList } = await import('../../src/operations/pricelists.js');

      await createPriceList({ Code: 'B', Description: 'Ny prislista' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.PriceList.Code).toBe('B');
      expect(body.PriceList.Description).toBe('Ny prislista');
    });
  });

  describe('updatePriceList', () => {
    it('uses PUT and excludes Code from body', async () => {
      mockFetch({ PriceList: { Code: 'A', Description: 'Uppdaterad' } });
      const { updatePriceList } = await import('../../src/operations/pricelists.js');

      await updatePriceList('A', { Code: 'A', Description: 'Uppdaterad' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('pricelists/A');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.PriceList.Description).toBe('Uppdaterad');
      expect(body.PriceList.Code).toBeUndefined();
    });
  });
});

describe('price operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listPrices', () => {
    it('calls the correct sublist endpoint', async () => {
      mockFetch({ Prices: [], MetaInformation: {} });
      const { listPrices } = await import('../../src/operations/pricelists.js');

      await listPrices({ priceListCode: 'A', articleNumber: 'ART1' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('prices/sublist/A/ART1');
    });

    it('lists all prices for a price list', async () => {
      mockFetch({
        Prices: [{ ArticleNumber: 'ART1', PriceList: 'A', Price: 100, FromQuantity: 0 }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      });
      const { listPrices } = await import('../../src/operations/pricelists.js');

      const result = await listPrices({ priceListCode: 'A' });
      expect(result.Prices).toHaveLength(1);
    });
  });

  describe('getPrice', () => {
    it('unwraps the Price envelope', async () => {
      mockFetch({
        Price: { ArticleNumber: 'ART1', PriceList: 'A', Price: 150, FromQuantity: 0 },
      });
      const { getPrice } = await import('../../src/operations/pricelists.js');

      const result = await getPrice('A', 'ART1');
      expect(result.Price).toBe(150);
      expect(result.ArticleNumber).toBe('ART1');
    });

    it('includes fromQuantity in URL', async () => {
      mockFetch({ Price: { ArticleNumber: 'ART1', Price: 100, FromQuantity: 10 } });
      const { getPrice } = await import('../../src/operations/pricelists.js');

      await getPrice('A', 'ART1', 10);

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('prices/A/ART1/10');
    });
  });

  describe('updatePrice', () => {
    it('uses PUT with correct endpoint', async () => {
      mockFetch({ Price: { ArticleNumber: 'ART1', PriceList: 'A', Price: 200 } });
      const { updatePrice } = await import('../../src/operations/pricelists.js');

      await updatePrice('A', 'ART1', { Price: 200 });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('prices/A/ART1/0');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Price.Price).toBe(200);
    });
  });
});
