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

describe('financial year tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_financialyears', () => {
    it('lists financial years', async () => {
      mockFetch({
        FinancialYears: [
          {
            Id: 1,
            FromDate: '2024-01-01',
            ToDate: '2024-12-31',
            AccountingMethod: 'ACCRUAL',
            AccountChartType: 'Aktiebolag',
          },
          {
            Id: 2,
            FromDate: '2025-01-01',
            ToDate: '2025-12-31',
            AccountingMethod: 'ACCRUAL',
            AccountChartType: 'Aktiebolag',
          },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_financialyears',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2024-01-01');
      expect(text).toContain('2025-12-31');
    });

    it('filters to the year containing a given date', async () => {
      mockFetch({
        FinancialYears: [
          { Id: 1, FromDate: '2024-01-01', ToDate: '2024-12-31', AccountingMethod: 'ACCRUAL' },
          { Id: 2, FromDate: '2025-01-01', ToDate: '2025-12-31', AccountingMethod: 'ACCRUAL' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_financialyears',
        arguments: { date: '2025-06-15' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2025-01-01');
      expect(text).not.toContain('2024-01-01');
    });
  });

  describe('fortnox_get_financialyear', () => {
    it('fetches a single financial year', async () => {
      mockFetch({
        FinancialYear: {
          Id: 2,
          FromDate: '2025-01-01',
          ToDate: '2025-12-31',
          AccountingMethod: 'ACCRUAL',
          AccountChartType: 'Aktiebolag',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_financialyear',
        arguments: { id: 2, includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Id).toBe(2);
      expect(parsed.FromDate).toBe('2025-01-01');
    });
  });

  describe('fortnox_get_lockedperiod', () => {
    it('fetches the locked period', async () => {
      mockFetch({ LockedPeriod: { EndDate: '2025-03-31' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_lockedperiod',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2025-03-31');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('settings/lockedperiod');
    });

    it('reports when no period is locked', async () => {
      mockFetch({ LockedPeriod: {} });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_lockedperiod',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Ingen period är låst.');
    });
  });
});
