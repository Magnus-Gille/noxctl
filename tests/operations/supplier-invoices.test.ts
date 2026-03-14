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

describe('supplier invoice operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSupplierInvoices', () => {
    it('passes filter as query parameter', async () => {
      mockFetch({ SupplierInvoices: [], MetaInformation: {} });
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      await listSupplierInvoices({ filter: 'unpaid' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaid');
    });

    it('filters by supplier number', async () => {
      mockFetch({ SupplierInvoices: [], MetaInformation: {} });
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      await listSupplierInvoices({ supplierNumber: '5' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('suppliernumber=5');
    });

    it('returns the full envelope', async () => {
      const response = {
        SupplierInvoices: [{ GivenNumber: 1, SupplierName: 'Test' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      const result = await listSupplierInvoices();
      expect(result.SupplierInvoices).toHaveLength(1);
    });
  });

  describe('getSupplierInvoice', () => {
    it('unwraps the SupplierInvoice envelope', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 1, SupplierName: 'Test', Total: 5000 },
      });
      const { getSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      const result = await getSupplierInvoice('1');
      expect(result.GivenNumber).toBe(1);
      expect(result.Total).toBe(5000);
    });
  });

  describe('createSupplierInvoice', () => {
    it('wraps params in SupplierInvoice envelope for POST', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 10, SupplierNumber: '5' },
      });
      const { createSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      await createSupplierInvoice({
        SupplierNumber: '5',
        Total: 1250,
        SupplierInvoiceRows: [
          { Account: 5410, Debit: 1000 },
          { Account: 2641, Debit: 250 },
          { Account: 2440, Credit: 1250 },
        ],
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoice.SupplierNumber).toBe('5');
      expect(body.SupplierInvoice.SupplierInvoiceRows).toHaveLength(3);
    });
  });

  describe('bookkeepSupplierInvoice', () => {
    it('sends PUT to bookkeep endpoint', async () => {
      mockFetch({ SupplierInvoice: { GivenNumber: 1, Booked: true } });
      const { bookkeepSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      await bookkeepSupplierInvoice('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('supplierinvoices/1/bookkeep');
      expect(fetchCall[1].method).toBe('PUT');
    });
  });
});
