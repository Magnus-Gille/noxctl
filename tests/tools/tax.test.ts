import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

let fetchCallCount = 0;

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('tax tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fetchCallCount = 0;
  });

  describe('fortnox_tax_report', () => {
    it('generates a VAT report for a quarter', async () => {
      const accountsResponse = {
        Accounts: [
          {
            Number: 2610,
            Description: 'Utgående moms 25%',
            SRU: 0,
            BalanceBroughtForward: 0,
            BalanceCarriedForward: -12500,
          },
          {
            Number: 2640,
            Description: 'Ingående moms',
            SRU: 0,
            BalanceBroughtForward: 0,
            BalanceCarriedForward: 3200,
          },
          {
            Number: 3001,
            Description: 'Försäljning',
            SRU: 0,
            BalanceBroughtForward: 0,
            BalanceCarriedForward: 0,
          },
        ],
      };

      const vouchersResponse = {
        Vouchers: [
          {
            VoucherNumber: 1,
            VoucherRows: [
              { Account: 2610, Debit: 0, Credit: 12500, Description: 'Utgående moms' },
              { Account: 2640, Debit: 3200, Credit: 0, Description: 'Ingående moms' },
              { Account: 3001, Debit: 0, Credit: 50000, Description: 'Försäljning' },
            ],
          },
        ],
      };

      fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        const response = fetchCallCount === 1 ? accountsResponse : vouchersResponse;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
          json: () => Promise.resolve(response),
        });
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_tax_report',
        arguments: {
          fromDate: '2025-01-01',
          toDate: '2025-03-31',
        },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2025-01-01');
      expect(text).toContain('2025-03-31');
      expect(text).toContain('2610');
      expect(text).toContain('12500.00');
      expect(text).toContain('2640');
      expect(text).toContain('3200.00');
      expect(text).toContain('Kontrollera');
    });

    it('handles period with no VAT transactions', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                Accounts: [
                  {
                    Number: 1930,
                    Description: 'Bank',
                    SRU: 0,
                    BalanceBroughtForward: 0,
                    BalanceCarriedForward: 100000,
                  },
                ],
              }),
            ),
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ Vouchers: [] })),
          json: () => Promise.resolve({}),
        });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_tax_report',
        arguments: { fromDate: '2025-01-01', toDate: '2025-03-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Period: 2025-01-01');
      expect(text).not.toContain('2610');
    });
  });
});
