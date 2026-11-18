import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

/**
 * The financial reports are built from one financial-year lookup plus one SIE 4
 * export. Route the fetch mock by URL; the SIE body is CP437 bytes.
 */
function mockFortnox(sieLines: string[]) {
  const years = {
    FinancialYears: [{ Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' }],
  };
  const sie = Buffer.from(['#FORMAT PC8', '#SIETYP 4', ...sieLines].join('\r\n'), 'latin1');
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/3/sie/4')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: () =>
          Promise.resolve(sie.buffer.slice(sie.byteOffset, sie.byteOffset + sie.byteLength)),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(years)),
      json: () => Promise.resolve(years),
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
      mockFortnox([
        '#KONTO 3001 "F\x94rs\x84ljning"',
        '#KONTO 5410 "F\x94rbrukningsinventarier"',
        '#KONTO 1930 "Bank"',
        '#VER A 1 20260115 "Sale"',
        '{',
        '#TRANS 3001 {} -50000.00',
        '#TRANS 5410 {} 3000.00',
        '#TRANS 1930 {} 47000.00',
        '}',
      ]);

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
      mockFortnox([]);

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
      mockFortnox([
        '#KONTO 3001 "F\x94rs\x84ljning"',
        '#VER A 1 20260115 "Sale"',
        '{',
        '#TRANS 3001 {} -12000.00',
        '#TRANS 1930 {} 12000.00',
        '}',
      ]);

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
      mockFortnox([
        '#KONTO 1930 "Bank"',
        '#KONTO 2081 "Aktiekapital"',
        '#KONTO 2440 "Leverant\x94rsskulder"',
        '#IB 0 1930 100000.00',
        '#IB 0 2081 -25000.00',
        '#IB 0 2440 -75000.00',
      ]);

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
      mockFortnox(['#KONTO 1930 "Bank"', '#IB 0 1930 50000.00']);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_balance_sheet',
        arguments: { toDate: '2026-01-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('2026-01-31');
    });

    it('includes raw JSON when includeRaw is set', async () => {
      mockFortnox(['#KONTO 1930 "Bank"', '#IB 0 1930 50000.00']);

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
