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

describe('invoice payment operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listInvoicePayments', () => {
    it('returns the full envelope', async () => {
      const response = {
        InvoicePayments: [{ Number: 1, InvoiceNumber: 1001, Amount: 5000 }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listInvoicePayments } = await import('../../src/operations/invoice-payments.js');

      const result = await listInvoicePayments();
      expect(result.InvoicePayments).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });

    it('passes invoiceNumber filter as query param', async () => {
      mockFetch({ InvoicePayments: [], MetaInformation: {} });
      const { listInvoicePayments } = await import('../../src/operations/invoice-payments.js');

      await listInvoicePayments({ invoiceNumber: '1001' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoicenumber=1001');
    });
  });

  describe('getInvoicePayment', () => {
    it('unwraps the InvoicePayment wrapper', async () => {
      mockFetch({ InvoicePayment: { Number: 1, InvoiceNumber: 1001, Amount: 5000 } });
      const { getInvoicePayment } = await import('../../src/operations/invoice-payments.js');

      const result = await getInvoicePayment('1');
      expect(result.Number).toBe(1);
      expect(result.Amount).toBe(5000);
    });

    it('rejects path traversal', async () => {
      mockFetch({});
      const { getInvoicePayment } = await import('../../src/operations/invoice-payments.js');

      await expect(getInvoicePayment('../hack')).rejects.toThrow('Invalid document number');
    });
  });

  describe('createInvoicePayment', () => {
    it('wraps params in InvoicePayment envelope for POST', async () => {
      mockFetch({ InvoicePayment: { Number: 2, InvoiceNumber: 1001, Amount: 5000 } });
      const { createInvoicePayment } = await import('../../src/operations/invoice-payments.js');

      await createInvoicePayment({ InvoiceNumber: 1001, Amount: 5000, PaymentDate: '2026-03-20' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.InvoicePayment.InvoiceNumber).toBe(1001);
      expect(body.InvoicePayment.Amount).toBe(5000);
    });

    it('unwraps the response', async () => {
      mockFetch({ InvoicePayment: { Number: 2, Amount: 5000 } });
      const { createInvoicePayment } = await import('../../src/operations/invoice-payments.js');

      const result = await createInvoicePayment({ InvoiceNumber: 1001, Amount: 5000 });
      expect(result.Number).toBe(2);
    });
  });

  describe('deleteInvoicePayment', () => {
    it('calls DELETE on the payment endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteInvoicePayment } = await import('../../src/operations/invoice-payments.js');

      await deleteInvoicePayment('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('invoicepayments/1');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
