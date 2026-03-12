import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('customer tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_customers', () => {
    it('lists customers with default pagination', async () => {
      const mockData = {
        Customers: [
          { CustomerNumber: '1', Name: 'Acme AB' },
          { CustomerNumber: '2', Name: 'Globex Corp' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_customers', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.Customers).toHaveLength(2);
      expect(parsed.Customers[0].Name).toBe('Acme AB');
    });

    it('searches customers by name', async () => {
      mockFetch({ Customers: [{ CustomerNumber: '1', Name: 'Acme AB' }] });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_customers',
        arguments: { search: 'Acme' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('name=Acme');
    });

    it('supports pagination', async () => {
      mockFetch({ Customers: [], MetaInformation: { '@CurrentPage': 3 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_customers',
        arguments: { page: 3, limit: 50 },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=3');
      expect(calledUrl).toContain('limit=50');
    });
  });

  describe('fortnox_get_customer', () => {
    it('fetches a single customer', async () => {
      mockFetch({ Customer: { CustomerNumber: '42', Name: 'Test AB', Email: 'test@example.com' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_customer',
        arguments: { customerNumber: '42' },
      });

      const parsed = JSON.parse((result.content as { type: string; text: string }[])[0].text);
      expect(parsed.CustomerNumber).toBe('42');
      expect(parsed.Name).toBe('Test AB');
    });

    it('returns error for non-existent customer', async () => {
      mockFetch({ ErrorInformation: { message: 'Customer not found', code: 2000428 } }, false, 404);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_customer',
        arguments: { customerNumber: '999999' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_create_customer', () => {
    it('creates a customer with required fields', async () => {
      mockFetch({ Customer: { CustomerNumber: '100', Name: 'Ny Kund AB' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_customer',
        arguments: { Name: 'Ny Kund AB' },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Name).toBe('Ny Kund AB');
    });

    it('creates a customer with all optional fields', async () => {
      mockFetch({ Customer: { CustomerNumber: '101', Name: 'Full Kund AB' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_customer',
        arguments: {
          Name: 'Full Kund AB',
          OrganisationNumber: '556677-8899',
          Email: 'info@fullkund.se',
          Phone: '08-123456',
          Address1: 'Storgatan 1',
          ZipCode: '11122',
          City: 'Stockholm',
          Country: 'SE',
          VATNumber: 'SE556677889901',
          DeliveryType: 'EMAIL',
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Customer.OrganisationNumber).toBe('556677-8899');
      expect(body.Customer.City).toBe('Stockholm');
      expect(body.Customer.DeliveryType).toBe('EMAIL');
    });
  });

  describe('fortnox_update_customer', () => {
    it('updates specific fields', async () => {
      mockFetch({
        Customer: { CustomerNumber: '42', Name: 'Updated AB', Email: 'new@example.com' },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_customer',
        arguments: { customerNumber: '42', Email: 'new@example.com' },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('customers/42');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Email).toBe('new@example.com');
      expect(body.Customer.customerNumber).toBeUndefined(); // should not be in body
    });
  });
});
