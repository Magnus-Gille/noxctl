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
      expect(text).toContain('Acme AB');
      expect(text).toContain('Globex Corp');
    });

    it('searches customers by name', async () => {
      mockFetch({ Customers: [{ CustomerNumber: '1', Name: 'Acme AB' }] });

      const { client } = await setupClientServer();
      await client.callTool({
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
      mockFetch({
        Customer: {
          CustomerNumber: '42',
          Name: 'Example Customer AB',
          Email: 'billing@example-customer.example',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_customer',
        arguments: { customerNumber: '42', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.CustomerNumber).toBe('42');
      expect(parsed.Name).toBe('Example Customer AB');
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
      await client.callTool({
        name: 'fortnox_create_customer',
        arguments: { Name: 'Ny Kund AB', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Name).toBe('Ny Kund AB');
    });

    it('creates a customer with all optional fields', async () => {
      mockFetch({ Customer: { CustomerNumber: '101', Name: 'Full Example AB' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_customer',
        arguments: {
          Name: 'Full Example AB',
          OrganisationNumber: '556677-8899',
          Email: 'info@full-example.example',
          Phone1: '08-123456',
          Address1: 'Exempelgatan 1',
          ZipCode: '11122',
          City: 'Uppsala',
          VATNumber: 'SE556677889901',
          confirm: true,
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Customer.OrganisationNumber).toBe('556677-8899');
      expect(body.Customer.City).toBe('Uppsala');
      expect(body.Customer.Phone1).toBe('08-123456');
    });
  });

  describe('fortnox_update_customer', () => {
    it('updates specific fields', async () => {
      mockFetch({
        Customer: {
          CustomerNumber: '42',
          Name: 'Updated Example AB',
          Email: 'accounts.updated@example.test',
        },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_customer',
        arguments: { customerNumber: '42', Email: 'accounts.updated@example.test', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('customers/42');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Customer.Email).toBe('accounts.updated@example.test');
      expect(body.Customer.customerNumber).toBeUndefined(); // should not be in body
    });

    it('requires confirmation before updating a customer', async () => {
      mockFetch({
        Customer: {
          CustomerNumber: '42',
          Name: 'Updated Example AB',
          Email: 'accounts.updated@example.test',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_customer',
        arguments: { customerNumber: '42', Email: 'accounts.updated@example.test' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_delete_customer', () => {
    it('requires confirmation and supports dry run', async () => {
      mockFetch({});
      const { client } = await setupClientServer();

      const unconfirmed = await client.callTool({
        name: 'fortnox_delete_customer',
        arguments: { customerNumber: '42' },
      });
      const dryRun = await client.callTool({
        name: 'fortnox_delete_customer',
        arguments: { customerNumber: '42', dryRun: true },
      });

      expect(unconfirmed.isError).toBe(true);
      expect((dryRun.content as { type: string; text: string }[])[0].text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('deletes only after explicit confirmation', async () => {
      mockFetch({});
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_delete_customer',
        arguments: { customerNumber: '42', confirm: true },
      });

      expect(result.isError).toBeFalsy();
      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });

  // Same class of bug as #96 (Supplier field gap): the MCP SDK silently strips
  // any argument the Zod schema does not declare, so an undeclared field
  // reaches neither Fortnox nor an error message — it just vanishes. Type and
  // Phone1/Phone2 were missing entirely, and Phone was declared under a name
  // Fortnox's Customer resource doesn't have (only Phone1/Phone2 exist).
  describe('customer write schemas cover the real Customer resource', () => {
    const extendedFields = {
      Type: 'PRIVATE',
      Phone1: '08-123456',
      Phone2: '070-1234567',
      Fax: '08-654321',
      WWW: 'https://example.test',
      Address2: 'Plan 4',
      CountryCode: 'SE',
      DeliveryName: 'Lagret',
      DeliveryAddress1: 'Lagergatan 1',
      DeliveryZipCode: '11133',
      DeliveryCity: 'Uppsala',
      DeliveryCountryCode: 'SE',
      VisitingAddress: 'Besöksgatan 2',
      VisitingZipCode: '11144',
      VisitingCity: 'Uppsala',
      VisitingCountryCode: 'SE',
      GLN: '1234567890123',
      ExternalReference: 'ext-42',
      OurReference: 'Anna Andersson',
      YourReference: 'Erik Eriksson',
      Comments: 'VIP customer',
      Currency: 'SEK',
      CostCenter: 'CC1',
      Project: '12',
      PriceList: 'A',
      TermsOfDelivery: 'EXW',
      TermsOfPayment: '30',
      VATNumber: 'SE556677889901',
      VATType: 'SEVAT',
      SalesAccount: '3001',
      InvoiceRemark: 'Handle with care',
      ShowPriceVATIncluded: false,
      EmailInvoice: 'invoices@example.test',
      Active: true,
    };

    // The claim is full coverage of the Customer resource, so assert the
    // schema's property list itself — sending a subset of values cannot
    // detect a field quietly dropped from the schema.
    const writableCustomerFields = Object.keys(extendedFields);

    it('declares every writable Customer field on create', async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'fortnox_create_customer')!.inputSchema;
      const declared = Object.keys(schema.properties as Record<string, unknown>);
      for (const field of writableCustomerFields) {
        expect(declared).toContain(field);
      }
    });

    it('declares every writable Customer field on update', async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'fortnox_update_customer')!.inputSchema;
      const declared = Object.keys(schema.properties as Record<string, unknown>);
      for (const field of writableCustomerFields) {
        expect(declared).toContain(field);
      }
    });

    // Regression guard: Country/DeliveryCountry/VisitingCountry are genuinely
    // read-only on this resource (Fortnox rejects them with "Fältet Country är
    // endast läsbart") — they must stay off the writable schema, not just be
    // silently stripped a second time at the operations layer.
    it('does not declare the read-only *Country fields', async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'fortnox_update_customer')!.inputSchema;
      const declared = Object.keys(schema.properties as Record<string, unknown>);
      expect(declared).not.toContain('Country');
      expect(declared).not.toContain('DeliveryCountry');
      expect(declared).not.toContain('VisitingCountry');
    });

    it('forwards extended fields on create', async () => {
      mockFetch({ Customer: { CustomerNumber: '3' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_customer',
        arguments: { Name: 'New Customer', confirm: true, ...extendedFields },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(fetchCall[1].body as string).Customer;
      for (const [key, value] of Object.entries(extendedFields)) {
        expect(sent[key]).toEqual(value);
      }
    });

    it('forwards extended fields on update', async () => {
      mockFetch({ Customer: { CustomerNumber: '3' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_customer',
        arguments: { customerNumber: '3', confirm: true, ...extendedFields },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(fetchCall[1].body as string).Customer;
      for (const [key, value] of Object.entries(extendedFields)) {
        expect(sent[key]).toEqual(value);
      }
      expect(sent.customerNumber).toBeUndefined();
    });

    it('rejects an invalid Type value', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_customer',
        arguments: { Name: 'Bad Type', Type: 'INDIVIDUAL', confirm: true },
      });

      expect(result.isError).toBe(true);
    });
  });
});
