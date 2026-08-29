import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('order tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_orders', () => {
    it('lists orders', async () => {
      mockFetch({
        Orders: [
          { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
          { DocumentNumber: '2', CustomerName: 'Globex', Total: 5000 },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_orders', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Acme');
      expect(text).toContain('Globex');
    });

    it('filters by customer number', async () => {
      mockFetch({ Orders: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_orders',
        arguments: { customerNumber: '42' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
    });
  });

  describe('fortnox_get_order', () => {
    it('fetches a single order', async () => {
      mockFetch({
        Order: { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_order',
        arguments: { documentNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.DocumentNumber).toBe('1');
    });
  });

  describe('fortnox_create_order', () => {
    it('creates an order with confirmation', async () => {
      mockFetch({ Order: { DocumentNumber: '2', CustomerNumber: '42', Total: 12500 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_order',
        arguments: {
          CustomerNumber: '42',
          OrderRows: [{ Description: 'Konsulttimmar', DeliveredQuantity: 10, Price: 1000 }],
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Order.CustomerNumber).toBe('42');
    });

    it('advertises and preserves complete order rows for create and update', async () => {
      mockFetch({ Order: { DocumentNumber: '2', CustomerNumber: '42' } });
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const createTool = tools.find((tool) => tool.name === 'fortnox_create_order');
      const updateTool = tools.find((tool) => tool.name === 'fortnox_update_order');
      type RowProperties = Record<string, { enum?: string[] }>;
      type OrderToolInput = {
        properties: {
          OrderRows: {
            items: {
              properties: RowProperties;
              additionalProperties?: boolean;
              required?: string[];
            };
          };
        };
      };
      const createRows = (createTool?.inputSchema as OrderToolInput).properties.OrderRows.items;
      const updateRows = (updateTool?.inputSchema as OrderToolInput).properties.OrderRows.items;

      expect(Object.keys(createRows.properties)).toHaveLength(19);
      expect(Object.keys(updateRows.properties)).toHaveLength(19);
      expect(createRows.additionalProperties).toBe(false);
      expect(updateRows.additionalProperties).toBe(false);
      expect(createRows.required).toEqual(
        expect.arrayContaining(['Description', 'DeliveredQuantity', 'Price']),
      );
      expect(updateRows.required ?? []).toEqual([]);
      expect(createRows.properties.DiscountType?.enum).toEqual(['AMOUNT', 'PERCENT']);
      expect(createRows.properties.HouseWorkType?.enum).toHaveLength(24);
      expect(createRows.properties.HouseWorkType?.enum).toContain('CONSTRUCTION');
      expect(createRows.properties.HouseWorkType?.enum).toContain('ITSERVICES');
      expect(createRows.properties.HouseWorkType?.enum).toContain('WASHINGANDCAREOFCLOTHING');

      const row = {
        AccountNumber: 3001,
        ArticleNumber: 'CONSULTING',
        Cost: null,
        CostCenter: null,
        DeliveredQuantity: '2.5',
        Description: 'Teknisk rådgivning',
        Discount: 10,
        DiscountType: 'PERCENT',
        HouseWork: true,
        HouseWorkHoursToReport: null,
        HouseWorkType: 'ITSERVICES',
        OrderedQuantity: '3.0',
        Price: 1200,
        Project: 'P1',
        StockPointCode: 'STH',
        StockPointId: '12',
        Unit: 'tim',
        VAT: 25.5,
        VATCode: 'SE25',
      };

      const created = await client.callTool({
        name: 'fortnox_create_order',
        arguments: { CustomerNumber: '42', OrderRows: [row], confirm: true },
      });
      const updated = await client.callTool({
        name: 'fortnox_update_order',
        arguments: { documentNumber: '2', OrderRows: [row], confirm: true },
      });

      expect(created.isError).not.toBe(true);
      expect(updated.isError).not.toBe(true);
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(JSON.parse(calls[0][1].body).Order.OrderRows[0]).toEqual(row);
      expect(JSON.parse(calls[1][1].body).Order.OrderRows[0]).toEqual(row);
    });

    it.each([
      ['a fractional account number', { AccountNumber: 3001.5 }],
      ['an out-of-range cost', { Cost: 10_000_000_000 }],
      ['an overlong description', { Description: 'x'.repeat(256) }],
      ['an unknown discount type', { DiscountType: 'UNKNOWN' }],
      ['too many house-work hours', { HouseWorkHoursToReport: 1000 }],
      ['an unknown house-work type', { HouseWorkType: 'UNKNOWN' }],
      ['a numeric ordered quantity', { OrderedQuantity: 3 }],
      ['a numeric stock-point id', { StockPointId: 12 }],
      ['an overlong unit', { Unit: 'x'.repeat(21) }],
    ])('rejects %s before making an order request', async (_case, invalidFields) => {
      mockFetch({ Order: {} });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_order',
        arguments: {
          CustomerNumber: '42',
          OrderRows: [
            {
              Description: 'Test',
              DeliveredQuantity: 1,
              Price: 100,
              ...invalidFields,
            },
          ],
          confirm: true,
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_create_invoice_from_order', () => {
    it('converts order to invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_from_order',
        arguments: { documentNumber: '1', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('orders/1/createinvoice');
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('1001');
    });
  });
});
