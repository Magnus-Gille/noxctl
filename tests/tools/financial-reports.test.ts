import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

/**
 * The financial-reports operations fetch several endpoints — accounts (paginated),
 * the vouchers list, and each voucher's detail. Order isn't deterministic because
 * accounts + vouchers are fetched in parallel, so route the mock by URL instead of
 * by call sequence.
 */
function mockFetchByUrl(routes: { accounts: unknown; vouchers: unknown; voucherDetail: unknown }) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    let response: unknown;
    if (/\/vouchers\/[^/]+\/\d+/.test(url)) {
      // individual voucher detail: /vouchers/A/1
      response = routes.voucherDetail;
    } else if (/\/vouchers(\?|$)/.test(url)) {
      // vouchers list
      response = routes.vouchers;
    } else {
      // accounts list
      response = routes.accounts;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    });
  });
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('financial report tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_income_statement', () => {
    it('renders a resultaträkning with grouped revenue and costs', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [
            { Number: 3001, Description: 'Försäljning', BalanceBroughtForward: 0 },
            { Number: 5410, Description: 'Förbrukningsinventarier', BalanceBroughtForward: 0 },
          ],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: {
          Voucher: {
            VoucherRows: [
              { Account: 3001, Debit: 0, Credit: 50000 },
              { Account: 5410, Debit: 3000, Credit: 0 },
              { Account: 1930, Debit: 47000, Credit: 0 },
            ],
          },
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_income_statement',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('RESULTATRÄKNING');
      expect(text).toContain('Nettoomsättning');
      expect(text).toContain('Försäljning');
      expect(text).toContain('Övriga externa kostnader');
      expect(text).toContain('RESULTAT');
      // Revenue 50000 (credit -> shown positive), cost 3000 -> net result shown positive 47000
      expect(text).toContain('50000.00');
      expect(text).toContain('47000.00');
    });

    it('shows the period in the heading when fromDate/toDate are provided', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: { Voucher: { VoucherRows: [] } },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_income_statement',
        arguments: { fromDate: '2026-01-01', toDate: '2026-03-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2026-01-01');
      expect(text).toContain('2026-03-31');
    });

    it('includes raw JSON when includeRaw is set', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [{ Number: 3001, Description: 'Försäljning', BalanceBroughtForward: 0 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: {
          Voucher: { VoucherRows: [{ Account: 3001, Debit: 0, Credit: 12000 }] },
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_income_statement',
        arguments: { includeRaw: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      const parsed = JSON.parse(text.split('Raw JSON:\n')[1]);
      expect(parsed.type).toBe('income-statement');
      expect(parsed.netResult).toBe(-12000);
    });
  });

  describe('fortnox_balance_sheet', () => {
    it('renders a balansräkning split into assets and liabilities/equity', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [
            { Number: 1930, Description: 'Bank', BalanceBroughtForward: 100000 },
            { Number: 2081, Description: 'Aktiekapital', BalanceBroughtForward: -25000 },
            { Number: 2440, Description: 'Leverantörsskulder', BalanceBroughtForward: -75000 },
          ],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: { Voucher: { VoucherRows: [] } },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_balance_sheet',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('BALANSRÄKNING');
      expect(text).toContain('TILLGÅNGAR');
      expect(text).toContain('SKULDER OCH EGET KAPITAL');
      expect(text).toContain('Kassa och bank');
      expect(text).toContain('Eget kapital');
      expect(text).toContain('Bank');
      expect(text).toContain('SUMMA TILLGÅNGAR');
      expect(text).toContain('100000.00');
    });

    it('shows the as-of date in the heading when toDate is provided', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [{ Number: 1930, Description: 'Bank', BalanceBroughtForward: 50000 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: { Voucher: { VoucherRows: [] } },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_balance_sheet',
        arguments: { toDate: '2026-01-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2026-01-31');
    });

    it('includes raw JSON when includeRaw is set', async () => {
      mockFetchByUrl({
        accounts: {
          Accounts: [{ Number: 1930, Description: 'Bank', BalanceBroughtForward: 50000 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        vouchers: {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        voucherDetail: { Voucher: { VoucherRows: [] } },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_balance_sheet',
        arguments: { includeRaw: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      const parsed = JSON.parse(text.split('Raw JSON:\n')[1]);
      expect(parsed.type).toBe('balance-sheet');
      expect(parsed.totalAssets).toBe(50000);
    });
  });
});
