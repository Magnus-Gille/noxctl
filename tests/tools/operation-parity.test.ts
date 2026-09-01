import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'parity-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const dryRuns = [
  ['fortnox_update_absencetransaction', { id: '1', Hours: 4, dryRun: true }],
  ['fortnox_update_attendancetransaction', { id: '1', Hours: '8', dryRun: true }],
  ['fortnox_update_salarytransaction', { salaryRow: '1', Amount: '10', dryRun: true }],
  ['fortnox_update_invoice_payment', { paymentNumber: '1', Amount: 10, dryRun: true }],
  ['fortnox_bookkeep_invoice_payment', { paymentNumber: '1', dryRun: true }],
  ['fortnox_update_supplier_invoice_payment', { paymentNumber: '1', Amount: 10, dryRun: true }],
  ['fortnox_bookkeep_supplier_invoice_payment', { paymentNumber: '1', dryRun: true }],
  ['fortnox_update_taxreduction', { id: 1, AskedAmount: 10, dryRun: true }],
  ['fortnox_delete_taxreduction', { id: 1, dryRun: true }],
  ['fortnox_delete_project', { projectNumber: '1', dryRun: true }],
  ['fortnox_create_financialyear', { FromDate: '2026-01-01', ToDate: '2026-12-31', dryRun: true }],
  ['fortnox_update_supplier_invoice', { givenNumber: '1', Comments: 'ok', dryRun: true }],
  ['fortnox_approval_bookkeep_supplier_invoice', { givenNumber: '1', dryRun: true }],
  ['fortnox_approval_payment_supplier_invoice', { givenNumber: '1', dryRun: true }],
  ['fortnox_cancel_supplier_invoice', { givenNumber: '1', dryRun: true }],
  ['fortnox_credit_supplier_invoice', { givenNumber: '1', dryRun: true }],
  ['fortnox_cancel_invoice', { documentNumber: '1', dryRun: true }],
  ['fortnox_eprint_invoice', { documentNumber: '1', dryRun: true }],
  ['fortnox_external_print_invoice', { documentNumber: '1', dryRun: true }],
  ['fortnox_invoice_reminder_pdf', { documentNumber: '1', dryRun: true }],
  ['fortnox_cancel_offer', { documentNumber: '1', dryRun: true }],
  ['fortnox_email_offer', { documentNumber: '1', dryRun: true }],
  ['fortnox_external_print_offer', { documentNumber: '1', dryRun: true }],
  ['fortnox_offer_pdf', { documentNumber: '1', dryRun: true }],
  ['fortnox_cancel_order', { documentNumber: '1', dryRun: true }],
  ['fortnox_email_order', { documentNumber: '1', dryRun: true }],
  ['fortnox_external_print_order', { documentNumber: '1', dryRun: true }],
  ['fortnox_order_pdf', { documentNumber: '1', dryRun: true }],
  ['fortnox_create_price', { PriceList: 'A', ArticleNumber: '1', Price: 10, dryRun: true }],
  [
    'fortnox_delete_price',
    { priceListCode: 'A', articleNumber: '1', fromQuantity: 0, dryRun: true },
  ],
] as const;

describe('MCP operation parity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('discovers every newly completed existing-family operation', async () => {
    const { client } = await setupClientServer();
    const names = (await client.listTools()).tools.map(({ name }) => name);
    for (const [name] of dryRuns) expect(names).toContain(name);
  });

  it('requires no network access for exact dry-run previews', async () => {
    global.fetch = vi.fn();
    const { client } = await setupClientServer();
    for (const [name, args] of dryRuns) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBeFalsy();
      expect((result.content as { type: string; text: string }[])[0]?.text, name).toContain(
        'Dry run',
      );
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
