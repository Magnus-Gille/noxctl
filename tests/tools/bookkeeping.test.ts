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

describe('bookkeeping tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_vouchers', () => {
    it('lists vouchers with default params', async () => {
      mockFetch({
        Vouchers: [
          { VoucherNumber: 1, VoucherSeries: 'A', Description: 'Faktura 1001' },
          { VoucherNumber: 2, VoucherSeries: 'A', Description: 'Inbetalning' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_vouchers', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Faktura 1001');
      expect(text).toContain('Inbetalning');
    });

    it('filters by series', async () => {
      mockFetch({ Vouchers: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_vouchers',
        arguments: { series: 'B' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('vouchers/sublist/B');
    });

    it('filters by date range', async () => {
      mockFetch({ Vouchers: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_vouchers',
        arguments: { fromDate: '2025-01-01', toDate: '2025-03-31' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
    });
  });

  describe('fortnox_create_voucher', () => {
    it('creates a voucher with balanced rows', async () => {
      mockFetch({
        Voucher: {
          VoucherNumber: 10,
          VoucherSeries: 'A',
          Description: 'Kontorsmaterial',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_voucher',
        arguments: {
          Description: 'Kontorsmaterial',
          TransactionDate: '2025-03-12',
          VoucherRows: [
            { Account: 6110, Debit: 1000, Credit: 0, Description: 'Kontorsmaterial' },
            { Account: 2640, Debit: 250, Credit: 0, Description: 'Ingående moms' },
            { Account: 1930, Debit: 0, Credit: 1250, Description: 'Företagskonto' },
          ],
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Voucher.VoucherSeries).toBe('A');
      expect(body.Voucher.VoucherRows).toHaveLength(3);
    });

    it('uses custom voucher series', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1, VoucherSeries: 'B' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_voucher',
        arguments: {
          Description: 'Lön',
          VoucherSeries: 'B',
          TransactionDate: '2025-03-25',
          VoucherRows: [
            { Account: 7210, Debit: 50000, Credit: 0 },
            { Account: 1930, Debit: 0, Credit: 50000 },
          ],
          confirm: true,
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Voucher.VoucherSeries).toBe('B');
    });
  });

  describe('fortnox_list_accounts', () => {
    it('lists all accounts', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 3001, Description: 'Försäljning tjänster, 25% moms' },
          { Number: 6110, Description: 'Kontorsmaterial' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_accounts', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Företagskonto');
      expect(text).toContain('Kontorsmaterial');
    });

    it('filters accounts by search term', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 2610, Description: 'Utgående moms 25%' },
          { Number: 2640, Description: 'Ingående moms' },
          { Number: 3001, Description: 'Försäljning tjänster' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_accounts',
        arguments: { search: 'moms', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed).toHaveLength(2);
      expect(parsed[0].Description).toContain('moms');
    });

    it('filters accounts by account number', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 1931, Description: 'Sparkonto' },
          { Number: 3001, Description: 'Försäljning' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_accounts',
        arguments: { search: '193', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed).toHaveLength(2);
    });

    it('requires confirmation before creating a voucher', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1, VoucherSeries: 'A' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_voucher',
        arguments: {
          Description: 'Kontorsmaterial',
          TransactionDate: '2025-03-12',
          VoucherRows: [
            { Account: 6110, Debit: 1000, Credit: 0, Description: 'Kontorsmaterial' },
            { Account: 1930, Debit: 0, Credit: 1000, Description: 'Företagskonto' },
          ],
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
