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

describe('order operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listOrders', () => {
    it('returns the full envelope', async () => {
      const response = {
        Orders: [{ DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listOrders } = await import('../../src/operations/orders.js');

      const result = await listOrders();
      expect(result.Orders).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });

    it('maps camelCase params to Fortnox param names', async () => {
      mockFetch({ Orders: [], MetaInformation: {} });
      const { listOrders } = await import('../../src/operations/orders.js');

      await listOrders({
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
      mockFetch({ Orders: [] });
      const { listOrders } = await import('../../src/operations/orders.js');

      await listOrders({ filter: 'cancelled' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=cancelled');
    });
  });

  describe('getOrder', () => {
    it('unwraps the Order wrapper', async () => {
      mockFetch({ Order: { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 } });
      const { getOrder } = await import('../../src/operations/orders.js');

      const result = await getOrder('1');
      expect(result.DocumentNumber).toBe('1');
      expect(result.Total).toBe(10000);
    });

    it('rejects path traversal', async () => {
      mockFetch({});
      const { getOrder } = await import('../../src/operations/orders.js');

      await expect(getOrder('../hack')).rejects.toThrow('Invalid document number');
    });
  });

  describe('createOrder', () => {
    it('wraps params in Order envelope for POST', async () => {
      mockFetch({ Order: { DocumentNumber: '2' } });
      const { createOrder } = await import('../../src/operations/orders.js');

      await createOrder({ CustomerNumber: '42', OrderRows: [] });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Order.CustomerNumber).toBe('42');
    });
  });

  describe('updateOrder', () => {
    it('wraps fields in Order envelope for PUT', async () => {
      mockFetch({ Order: { DocumentNumber: '1', DeliveryDate: '2026-04-30' } });
      const { updateOrder } = await import('../../src/operations/orders.js');

      await updateOrder('1', { DeliveryDate: '2026-04-30' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('orders/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Order.DeliveryDate).toBe('2026-04-30');
    });
  });

  describe('createInvoiceFromOrder', () => {
    it('calls the createinvoice endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { createInvoiceFromOrder } = await import('../../src/operations/orders.js');

      const result = await createInvoiceFromOrder('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('orders/1/createinvoice');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.DocumentNumber).toBe('1001');
    });
  });
});
