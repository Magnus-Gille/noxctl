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

describe('supplier invoice payment operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSupplierInvoicePayments', () => {
    it('returns the full envelope', async () => {
      const response = {
        SupplierInvoicePayments: [{ Number: 1, InvoiceNumber: '501', Amount: 3000 }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listSupplierInvoicePayments } =
        await import('../../src/operations/supplier-invoice-payments.js');

      const result = await listSupplierInvoicePayments();
      expect(result.SupplierInvoicePayments).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });

    it('passes invoiceNumber filter as query param', async () => {
      mockFetch({ SupplierInvoicePayments: [], MetaInformation: {} });
      const { listSupplierInvoicePayments } =
        await import('../../src/operations/supplier-invoice-payments.js');

      await listSupplierInvoicePayments({ invoiceNumber: '501' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoicenumber=501');
    });
  });

  describe('getSupplierInvoicePayment', () => {
    it('unwraps the SupplierInvoicePayment wrapper', async () => {
      mockFetch({ SupplierInvoicePayment: { Number: 1, InvoiceNumber: '501', Amount: 3000 } });
      const { getSupplierInvoicePayment } =
        await import('../../src/operations/supplier-invoice-payments.js');

      const result = await getSupplierInvoicePayment('1');
      expect(result.Number).toBe(1);
      expect(result.Amount).toBe(3000);
    });

    it('rejects path traversal', async () => {
      mockFetch({});
      const { getSupplierInvoicePayment } =
        await import('../../src/operations/supplier-invoice-payments.js');

      await expect(getSupplierInvoicePayment('../hack')).rejects.toThrow('Invalid document number');
    });
  });

  describe('createSupplierInvoicePayment', () => {
    it('wraps params in SupplierInvoicePayment envelope for POST', async () => {
      mockFetch({ SupplierInvoicePayment: { Number: 2, InvoiceNumber: '501', Amount: 3000 } });
      const { createSupplierInvoicePayment } =
        await import('../../src/operations/supplier-invoice-payments.js');

      await createSupplierInvoicePayment({
        InvoiceNumber: '501',
        Amount: 3000,
        PaymentDate: '2026-03-20',
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoicePayment.InvoiceNumber).toBe('501');
      expect(body.SupplierInvoicePayment.Amount).toBe(3000);
    });
  });

  describe('deleteSupplierInvoicePayment', () => {
    it('calls DELETE on the payment endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteSupplierInvoicePayment } =
        await import('../../src/operations/supplier-invoice-payments.js');

      await deleteSupplierInvoicePayment('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('supplierinvoicepayments/1');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
