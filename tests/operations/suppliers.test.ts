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

describe('supplier operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSuppliers', () => {
    it('maps search to name query param', async () => {
      mockFetch({ Suppliers: [], MetaInformation: {} });
      const { listSuppliers } = await import('../../src/operations/suppliers.js');

      await listSuppliers({ search: 'Nordic' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('name=Nordic');
    });

    it('returns the full envelope', async () => {
      const response = {
        Suppliers: [{ SupplierNumber: '1', Name: 'Test AB' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listSuppliers } = await import('../../src/operations/suppliers.js');

      const result = await listSuppliers();
      expect(result.Suppliers).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getSupplier', () => {
    it('unwraps the Supplier envelope', async () => {
      mockFetch({ Supplier: { SupplierNumber: '1', Name: 'Test AB' } });
      const { getSupplier } = await import('../../src/operations/suppliers.js');

      const result = await getSupplier('1');
      expect(result.SupplierNumber).toBe('1');
      expect(result.Name).toBe('Test AB');
    });
  });

  describe('createSupplier', () => {
    it('wraps params in Supplier envelope for POST', async () => {
      mockFetch({ Supplier: { SupplierNumber: '2', Name: 'New Supplier' } });
      const { createSupplier } = await import('../../src/operations/suppliers.js');

      await createSupplier({ Name: 'New Supplier', BG: '123-4567' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Supplier.Name).toBe('New Supplier');
      expect(body.Supplier.BG).toBe('123-4567');
    });
  });

  describe('updateSupplier', () => {
    it('uses PUT and excludes SupplierNumber from body', async () => {
      mockFetch({ Supplier: { SupplierNumber: '1', Name: 'Updated' } });
      const { updateSupplier } = await import('../../src/operations/suppliers.js');

      await updateSupplier('1', { SupplierNumber: '1', Name: 'Updated' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('suppliers/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Supplier.Name).toBe('Updated');
      expect(body.Supplier.SupplierNumber).toBeUndefined();
    });
  });
});
