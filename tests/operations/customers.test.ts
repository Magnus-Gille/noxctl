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

describe('customer operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listCustomers', () => {
    it('maps search to name query param', async () => {
      mockFetch({ Customers: [], MetaInformation: {} });
      const { listCustomers } = await import('../../src/operations/customers.js');

      await listCustomers({ search: 'Acme' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('name=Acme');
    });

    it('passes page and limit params', async () => {
      mockFetch({ Customers: [], MetaInformation: {} });
      const { listCustomers } = await import('../../src/operations/customers.js');

      await listCustomers({ page: 3, limit: 50 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=3');
      expect(calledUrl).toContain('limit=50');
    });

    it('returns the full envelope', async () => {
      const response = {
        Customers: [{ CustomerNumber: '1' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listCustomers } = await import('../../src/operations/customers.js');

      const result = await listCustomers();
      expect(result.Customers).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getCustomer', () => {
    it('unwraps the Customer envelope', async () => {
      mockFetch({ Customer: { CustomerNumber: '1', Name: 'Acme' } });
      const { getCustomer } = await import('../../src/operations/customers.js');

      const result = await getCustomer('1');
      expect(result.CustomerNumber).toBe('1');
      expect(result.Name).toBe('Acme');
    });

    it('rejects path traversal in customer numbers', async () => {
      mockFetch({ Customer: { CustomerNumber: '1', Name: 'Acme' } });
      const { getCustomer } = await import('../../src/operations/customers.js');

      await expect(getCustomer('../companyinformation')).rejects.toThrow('Invalid customer number');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('createCustomer', () => {
    it('wraps params in Customer envelope for POST', async () => {
      mockFetch({ Customer: { CustomerNumber: '2', Name: 'New Corp' } });
      const { createCustomer } = await import('../../src/operations/customers.js');

      await createCustomer({ Name: 'New Corp', Email: 'info@new.com' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Name).toBe('New Corp');
      expect(body.Customer.Email).toBe('info@new.com');
    });

    it('unwraps the response', async () => {
      mockFetch({ Customer: { CustomerNumber: '2', Name: 'New Corp' } });
      const { createCustomer } = await import('../../src/operations/customers.js');

      const result = await createCustomer({ Name: 'New Corp' });
      expect(result.CustomerNumber).toBe('2');
    });
  });

  describe('updateCustomer', () => {
    it('uses PUT and excludes customerNumber from body', async () => {
      mockFetch({ Customer: { CustomerNumber: '1', Name: 'Updated' } });
      const { updateCustomer } = await import('../../src/operations/customers.js');

      await updateCustomer('1', { customerNumber: '1', Name: 'Updated' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('customers/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Name).toBe('Updated');
      expect(body.Customer.customerNumber).toBeUndefined();
    });
  });
});
