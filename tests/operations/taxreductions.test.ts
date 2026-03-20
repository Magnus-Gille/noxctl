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

describe('tax reduction operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listTaxReductions', () => {
    it('passes page and limit params', async () => {
      mockFetch({ TaxReductions: [], MetaInformation: {} });
      const { listTaxReductions } = await import('../../src/operations/taxreductions.js');

      await listTaxReductions({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('maps filter to query param', async () => {
      mockFetch({ TaxReductions: [], MetaInformation: {} });
      const { listTaxReductions } = await import('../../src/operations/taxreductions.js');

      await listTaxReductions({ filter: 'invoices' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=invoices');
    });

    it('returns the full envelope', async () => {
      const response = {
        TaxReductions: [{ Id: 1, CustomerName: 'Kund AB', TypeOfReduction: 'rot' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listTaxReductions } = await import('../../src/operations/taxreductions.js');

      const result = await listTaxReductions();
      expect(result.TaxReductions).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getTaxReduction', () => {
    it('unwraps the TaxReduction envelope', async () => {
      mockFetch({
        TaxReduction: {
          Id: 1,
          CustomerName: 'Kund AB',
          TypeOfReduction: 'rot',
          AskedAmount: 50000,
        },
      });
      const { getTaxReduction } = await import('../../src/operations/taxreductions.js');

      const result = await getTaxReduction(1);
      expect(result.Id).toBe(1);
      expect(result.TypeOfReduction).toBe('rot');
    });
  });

  describe('createTaxReduction', () => {
    it('wraps params in TaxReduction envelope for POST', async () => {
      mockFetch({
        TaxReduction: { Id: 2, ReferenceNumber: '5', TypeOfReduction: 'rut' },
      });
      const { createTaxReduction } = await import('../../src/operations/taxreductions.js');

      await createTaxReduction({
        ReferenceNumber: '5',
        ReferenceDocumentType: 'INVOICE',
        TypeOfReduction: 'rut',
        CustomerName: 'Test Kund',
        AskedAmount: 25000,
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.TaxReduction.ReferenceNumber).toBe('5');
      expect(body.TaxReduction.TypeOfReduction).toBe('rut');
    });

    it('unwraps the response', async () => {
      mockFetch({ TaxReduction: { Id: 2, TypeOfReduction: 'rut' } });
      const { createTaxReduction } = await import('../../src/operations/taxreductions.js');

      const result = await createTaxReduction({
        ReferenceNumber: '5',
        ReferenceDocumentType: 'INVOICE',
        TypeOfReduction: 'rut',
      });
      expect(result.Id).toBe(2);
    });
  });
});
