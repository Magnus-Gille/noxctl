import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

const SAMPLE_SIE = [
  '#FORMAT PC8',
  '#SIETYP 4',
  '#KONTO 3000 "Sales, Sweden"',
  '#KONTO 1930 "Bank"',
  '#VER A 1 20260805 "Sale"',
  '{',
  '#TRANS 3000 {} -1000 "" "Sale to customer" 0',
  '#TRANS 1930 {} 1000 "" "" 0',
  '}',
  '#VER B 5 20260806 "Other sale"',
  '{',
  '#TRANS 3000 {} -50 "" "" 0',
  '#TRANS 1930 {} 50 "" "" 0',
  '}',
].join('\r\n');

// getGeneralLedger now resolves the financial year itself when the caller
// doesn't pass one (see operations/general-ledger.ts), which means every call
// here makes a preceding GET financialyears before the sie/4 fetch. Branch on
// the URL so both are served correctly regardless of call order.
function mockSieFetch(text: string = SAMPLE_SIE) {
  global.fetch = vi.fn().mockImplementation((url: unknown) => {
    if (String(url).includes('financialyears')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              FinancialYears: [{ Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' }],
            }),
          ),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: () => {
        const bytes = Buffer.from(text, 'latin1');
        return Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
      },
    });
  });
}

// One voucher (one #TRANS line) per posting, so `count` postings unambiguously
// means `count` general-ledger rows.
function generateLargeSie(count: number): string {
  const lines = ['#FORMAT PC8', '#SIETYP 4', '#KONTO 3000 "Sales, Sweden"'];
  for (let i = 1; i <= count; i++) {
    lines.push(`#VER A ${i} 20260805 "Row ${i}"`, '{', `#TRANS 3000 {} -${i} "" "" 0`, '}');
  }
  return lines.join('\r\n');
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('fortnox_general_ledger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['1234567890.12', '90071992547409.00'])(
    'keeps large debit and credit %s complete in the MCP table',
    async (amount) => {
      mockSieFetch(SAMPLE_SIE.replaceAll('1000', amount));
      const { client, server } = await setupClientServer();
      try {
        const result = await client.callTool({
          name: 'fortnox_general_ledger',
          arguments: { fromDate: '2026-08-01', toDate: '2026-08-31' },
        });
        const text = (result.content as { text: string }[])[0].text;
        expect(result.isError).not.toBe(true);
        expect(text.split(amount)).toHaveLength(3);
        expect(text).not.toContain('…');
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each([0, -1, 4.5, 9007199254740992])(
    'rejects invalid financialYear %s before fetching',
    async (financialYear) => {
      mockSieFetch();
      const { client, server } = await setupClientServer();
      try {
        const result = await client.callTool({
          name: 'fortnox_general_ledger',
          arguments: { fromDate: '2026-08-01', toDate: '2026-08-31', financialYear },
        });
        expect(result.isError).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it('lists all transaction rows for the date range', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31' },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('2026-08-05');
    expect(text).toContain('2026-08-06');
    expect(text).toContain('Sale to customer');
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string][];
    const sieCall = calls.map(([url]) => url).find((url) => url.includes('sie/4'));
    expect(sieCall).toContain('fromdate=2026-08-01');
    expect(sieCall).toContain('todate=2026-08-31');
    // financialYear was not given, so it must have been resolved rather than
    // omitted (letting Fortnox infer it, which is not reliable — see the
    // operations-layer fix).
    expect(sieCall).toContain('financialyear=4');
  });

  it('filters by account when given', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31', account: '1930' },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    // Both #TRANS lines against account 1930 (one per voucher) should survive
    // the filter; the account-3000 lines should not appear.
    expect(text).toContain('1930');
    expect(text).not.toContain('3000');
    expect(text).toContain('(2 total)');
  });

  it('filters by voucher series when given', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31', series: 'B' },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('B5');
    expect(text).not.toContain('A1');
    expect(text).toContain('(2 total)');
  });

  // Review #161: includeRaw claimed to return raw Fortnox JSON, but this tool
  // has no such thing — the data is parsed from a SIE text export, not a
  // Fortnox JSON response. The option no longer exists; a caller passing it
  // gets the strict-schema rejection every other unknown argument gets.
  it('no longer accepts includeRaw', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31', includeRaw: true },
    });

    expect(result.isError).toBe(true);
  });

  it('is read-only — no confirmation required', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31' },
    });

    expect(result.isError).toBeFalsy();
  });

  // Review #161: an unbounded response for a real full-year, high-volume
  // company (~20k postings, ~1.78 MB formatted) can exceed MCP/client/model
  // limits. The tool must impose a deterministic bound and report enough for
  // a caller to page through the rest.
  describe('pagination bounds a large result', () => {
    it('caps the response at the default page size and reports the true total', async () => {
      mockSieFetch(generateLargeSie(1200));
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_general_ledger',
        arguments: { fromDate: '2026-01-01', toDate: '2026-12-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      // 500 is the documented default page size. The text column isn't the
      // last one (debit/credit follow it, padded), so match on the trailing
      // padding space rather than a line end — and to disambiguate "Row 1"
      // from "Row 10"/"Row 100", which would otherwise also satisfy a bare
      // substring check.
      expect(text).toContain('Row 1 ');
      expect(text).toContain('Row 500');
      expect(text).not.toContain('Row 501');
      expect(text).toContain('Page 1/3 (1200 total)');
    });

    it('returns the next page of rows when asked', async () => {
      mockSieFetch(generateLargeSie(1200));
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_general_ledger',
        arguments: { fromDate: '2026-01-01', toDate: '2026-12-31', page: 2 },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Row 501');
      expect(text).toContain('Row 1000');
      expect(text).not.toContain('Row 500 ');
      expect(text).toContain('Page 2/3 (1200 total)');
    });

    it('honors a smaller explicit limit', async () => {
      mockSieFetch(generateLargeSie(30));
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_general_ledger',
        arguments: { fromDate: '2026-01-01', toDate: '2026-12-31', limit: 10 },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Row 1 ');
      expect(text).toContain('Row 10');
      expect(text).not.toContain('Row 11');
      expect(text).toContain('Page 1/3 (30 total)');
    });

    it('rejects a limit above the documented maximum', async () => {
      mockSieFetch(generateLargeSie(5));
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_general_ledger',
        arguments: { fromDate: '2026-01-01', toDate: '2026-12-31', limit: 100000 },
      });

      expect(result.isError).toBe(true);
    });

    it('reports a single full page when everything fits', async () => {
      mockSieFetch();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_general_ledger',
        arguments: { fromDate: '2026-08-01', toDate: '2026-08-31' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Page 1/1 (4 total)');
    });
  });
});
