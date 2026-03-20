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

describe('supplier invoice payment tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_supplier_invoice_payments', () => {
    it('lists payments', async () => {
      mockFetch({
        SupplierInvoicePayments: [
          { Number: 1, InvoiceNumber: '501', Amount: 3000, PaymentDate: '2026-03-20' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoice_payments',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('3000');
    });
  });

  describe('fortnox_get_supplier_invoice_payment', () => {
    it('fetches a single payment', async () => {
      mockFetch({
        SupplierInvoicePayment: { Number: 1, InvoiceNumber: '501', Amount: 3000 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice_payment',
        arguments: { paymentNumber: '1' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('3000');
    });
  });

  describe('fortnox_create_supplier_invoice_payment', () => {
    it('creates a payment with confirmation', async () => {
      mockFetch({
        SupplierInvoicePayment: { Number: 2, InvoiceNumber: '501', Amount: 3000 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_supplier_invoice_payment',
        arguments: {
          InvoiceNumber: '501',
          Amount: 3000,
          PaymentDate: '2026-03-20',
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoicePayment.Amount).toBe(3000);
    });

    it('supports dry-run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice_payment',
        arguments: {
          InvoiceNumber: '501',
          Amount: 3000,
          PaymentDate: '2026-03-20',
          dryRun: true,
        },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });
  });

  describe('fortnox_delete_supplier_invoice_payment', () => {
    it('deletes a payment with confirmation', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_delete_supplier_invoice_payment',
        arguments: { paymentNumber: '1', confirm: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('borttagen');
    });
  });
});
