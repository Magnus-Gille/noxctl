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

describe('offer operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listOffers', () => {
    it('returns the full envelope', async () => {
      const response = {
        Offers: [{ DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listOffers } = await import('../../src/operations/offers.js');

      const result = await listOffers();
      expect(result.Offers).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });

    it('maps camelCase params to Fortnox param names', async () => {
      mockFetch({ Offers: [], MetaInformation: {} });
      const { listOffers } = await import('../../src/operations/offers.js');

      await listOffers({
        customerNumber: '42',
        fromDate: '2025-01-01',
        toDate: '2025-03-31',
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
    });

    it('passes filter param', async () => {
      mockFetch({ Offers: [] });
      const { listOffers } = await import('../../src/operations/offers.js');

      await listOffers({ filter: 'expired' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=expired');
    });
  });

  describe('getOffer', () => {
    it('unwraps the Offer wrapper', async () => {
      mockFetch({ Offer: { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 } });
      const { getOffer } = await import('../../src/operations/offers.js');

      const result = await getOffer('1');
      expect(result.DocumentNumber).toBe('1');
      expect(result.Total).toBe(10000);
    });

    it('rejects path traversal', async () => {
      mockFetch({});
      const { getOffer } = await import('../../src/operations/offers.js');

      await expect(getOffer('../hack')).rejects.toThrow('Invalid document number');
    });
  });

  describe('createOffer', () => {
    it('wraps params in Offer envelope for POST', async () => {
      mockFetch({ Offer: { DocumentNumber: '2' } });
      const { createOffer } = await import('../../src/operations/offers.js');

      await createOffer({ CustomerNumber: '42', OfferRows: [] });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Offer.CustomerNumber).toBe('42');
    });
  });

  describe('updateOffer', () => {
    it('wraps fields in Offer envelope for PUT', async () => {
      mockFetch({ Offer: { DocumentNumber: '1', DueDate: '2026-04-30' } });
      const { updateOffer } = await import('../../src/operations/offers.js');

      await updateOffer('1', { DueDate: '2026-04-30' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('offers/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Offer.DueDate).toBe('2026-04-30');
    });
  });

  describe('createInvoiceFromOffer', () => {
    it('calls the createinvoice endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { createInvoiceFromOffer } = await import('../../src/operations/offers.js');

      const result = await createInvoiceFromOffer('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('offers/1/createinvoice');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.DocumentNumber).toBe('1001');
    });
  });

  describe('createOrderFromOffer', () => {
    it('calls the createorder endpoint with PUT', async () => {
      mockFetch({ Order: { DocumentNumber: '501' } });
      const { createOrderFromOffer } = await import('../../src/operations/offers.js');

      const result = await createOrderFromOffer('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('offers/1/createorder');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.DocumentNumber).toBe('501');
    });
  });
});
