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

describe('invoice tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_invoices', () => {
    it('lists invoices with default params', async () => {
      mockFetch({
        Invoices: [
          { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
          { DocumentNumber: '2', CustomerName: 'Globex', Total: 5000 },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_invoices', arguments: {} });

      const parsed = JSON.parse((result.content as { type: string; text: string }[])[0].text);
      expect(parsed.Invoices).toHaveLength(2);
    });

    it('filters by status', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { filter: 'unpaidoverdue' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaidoverdue');
    });

    it('filters by date range', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { fromDate: '2025-01-01', toDate: '2025-03-31' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
    });

    it('filters by customer number', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { customerNumber: '42' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
    });
  });

  describe('fortnox_get_invoice', () => {
    it('fetches a single invoice with rows', async () => {
      mockFetch({
        Invoice: {
          DocumentNumber: '1001',
          CustomerNumber: '42',
          InvoiceRows: [
            { Description: 'Konsulttjänst', DeliveredQuantity: 10, Price: 1200 },
          ],
          Total: 15000,
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_invoice',
        arguments: { documentNumber: '1001' },
      });

      const parsed = JSON.parse((result.content as { type: string; text: string }[])[0].text);
      expect(parsed.DocumentNumber).toBe('1001');
      expect(parsed.InvoiceRows).toHaveLength(1);
    });
  });

  describe('fortnox_create_invoice', () => {
    it('creates an invoice with rows', async () => {
      mockFetch({
        Invoice: { DocumentNumber: '1002', CustomerNumber: '42', Total: 12500 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: {
          CustomerNumber: '42',
          InvoiceRows: [
            { Description: 'Konsulttimmar', DeliveredQuantity: 10, Price: 1000 },
          ],
          OurReference: 'Casey Example',
          DueDate: '2025-04-30',
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Invoice.CustomerNumber).toBe('42');
      expect(body.Invoice.InvoiceRows).toHaveLength(1);
      expect(body.Invoice.OurReference).toBe('Casey Example');
    });

    it('creates invoice with multiple rows and VAT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1003', Total: 25000 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: {
          CustomerNumber: '42',
          InvoiceRows: [
            { Description: 'Utveckling', DeliveredQuantity: 8, Price: 1200, VAT: 25, Unit: 'tim' },
            { Description: 'Resekostnader', DeliveredQuantity: 1, Price: 500, VAT: 25 },
          ],
          Currency: 'SEK',
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Invoice.InvoiceRows).toHaveLength(2);
      expect(body.Invoice.InvoiceRows[0].VAT).toBe(25);
      expect(body.Invoice.InvoiceRows[0].Unit).toBe('tim');
    });
  });

  describe('fortnox_send_invoice', () => {
    it('sends invoice via email by default', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Sent: true } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/email');
      expect((result.content as { type: string; text: string }[])[0].text).toContain('email');
    });

    it('sends invoice via print', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', method: 'print' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/print');
    });

    it('sends invoice via e-invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', method: 'einvoice' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/einvoice');
    });
  });

  describe('fortnox_bookkeep_invoice', () => {
    it('bookkeeps an invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Booked: true } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_bookkeep_invoice',
        arguments: { documentNumber: '1001' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/bookkeep');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PUT');
      expect((result.content as { type: string; text: string }[])[0].text).toContain('bokförd');
    });
  });

  describe('fortnox_credit_invoice', () => {
    it('credits an invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', CreditInvoiceReference: '1001' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_credit_invoice',
        arguments: { documentNumber: '1001' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/credit');
      expect((result.content as { type: string; text: string }[])[0].text).toContain('Kreditfaktura');
    });
  });
});
