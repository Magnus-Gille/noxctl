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

describe('invoice operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listInvoices', () => {
    it('maps camelCase params to Fortnox param names', async () => {
      mockFetch({ Invoices: [], MetaInformation: {} });
      const { listInvoices } = await import('../../src/operations/invoices.js');

      await listInvoices({
        customerNumber: '42',
        fromDate: '2025-01-01',
        toDate: '2025-03-31',
        page: 2,
        limit: 50,
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=50');
    });

    it('returns the full envelope (for pagination)', async () => {
      const response = {
        Invoices: [{ DocumentNumber: '1' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listInvoices } = await import('../../src/operations/invoices.js');

      const result = await listInvoices();
      expect(result.Invoices).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getInvoice', () => {
    it('unwraps the Invoice wrapper', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Total: 15000 } });
      const { getInvoice } = await import('../../src/operations/invoices.js');

      const result = await getInvoice('1001');
      expect(result.DocumentNumber).toBe('1001');
      expect(result.Total).toBe(15000);
    });
  });

  describe('createInvoice', () => {
    it('wraps params in Invoice envelope for POST', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002' } });
      const { createInvoice } = await import('../../src/operations/invoices.js');

      await createInvoice({ CustomerNumber: '42', InvoiceRows: [] });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Invoice.CustomerNumber).toBe('42');
    });

    it('unwraps the response', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', Total: 5000 } });
      const { createInvoice } = await import('../../src/operations/invoices.js');

      const result = await createInvoice({ CustomerNumber: '42', InvoiceRows: [] });
      expect(result.DocumentNumber).toBe('1002');
    });
  });

  describe('sendInvoice', () => {
    it('routes to email endpoint by default', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/email');
    });

    it('routes to print endpoint', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001', 'print');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/print');
    });

    it('routes to einvoice endpoint', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001', 'einvoice');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/einvoice');
    });
  });

  describe('bookkeepInvoice', () => {
    it('calls the bookkeep endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Booked: true } });
      const { bookkeepInvoice } = await import('../../src/operations/invoices.js');

      const result = await bookkeepInvoice('1001');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('invoices/1001/bookkeep');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.Booked).toBe(true);
    });
  });

  describe('creditInvoice', () => {
    it('calls the credit endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', CreditInvoiceReference: '1001' } });
      const { creditInvoice } = await import('../../src/operations/invoices.js');

      const result = await creditInvoice('1001');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('invoices/1001/credit');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.CreditInvoiceReference).toBe('1001');
    });
  });
});
