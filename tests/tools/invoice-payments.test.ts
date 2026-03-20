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

describe('invoice payment tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_invoice_payments', () => {
    it('lists payments', async () => {
      mockFetch({
        InvoicePayments: [
          { Number: 1, InvoiceNumber: 1001, Amount: 5000, PaymentDate: '2026-03-20' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_invoice_payments',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('5000');
    });

    it('filters by invoice number', async () => {
      mockFetch({ InvoicePayments: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoice_payments',
        arguments: { invoiceNumber: '1001' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoicenumber=1001');
    });
  });

  describe('fortnox_get_invoice_payment', () => {
    it('fetches a single payment', async () => {
      mockFetch({
        InvoicePayment: { Number: 1, InvoiceNumber: 1001, Amount: 5000 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_invoice_payment',
        arguments: { paymentNumber: '1' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('5000');
    });
  });

  describe('fortnox_create_invoice_payment', () => {
    it('creates a payment with confirmation', async () => {
      mockFetch({
        InvoicePayment: { Number: 2, InvoiceNumber: 1001, Amount: 5000 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_invoice_payment',
        arguments: {
          InvoiceNumber: 1001,
          Amount: 5000,
          PaymentDate: '2026-03-20',
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.InvoicePayment.InvoiceNumber).toBe(1001);
      expect(body.InvoicePayment.Amount).toBe(5000);
    });

    it('requires confirmation', async () => {
      mockFetch({});

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_payment',
        arguments: {
          InvoiceNumber: 1001,
          Amount: 5000,
          PaymentDate: '2026-03-20',
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('supports dry-run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_payment',
        arguments: {
          InvoiceNumber: 1001,
          Amount: 5000,
          PaymentDate: '2026-03-20',
          dryRun: true,
        },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_delete_invoice_payment', () => {
    it('deletes a payment with confirmation', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_delete_invoice_payment',
        arguments: { paymentNumber: '1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('DELETE');
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('borttagen');
    });
  });
});
