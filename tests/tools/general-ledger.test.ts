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

function mockSieFetch() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/octet-stream' }),
    arrayBuffer: () => {
      const bytes = Buffer.from(SAMPLE_SIE, 'latin1');
      return Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
    },
  });
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
    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('sie/4');
    expect(calledUrl).toContain('fromdate=2026-08-01');
    expect(calledUrl).toContain('todate=2026-08-31');
  });

  it('filters by account when given', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: {
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
        account: '1930',
        includeRaw: true,
      },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text.split('Raw JSON:\n')[1]);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r: { account: string }) => r.account === '1930')).toBe(true);
  });

  it('filters by voucher series when given', async () => {
    mockSieFetch();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_general_ledger',
      arguments: { fromDate: '2026-08-01', toDate: '2026-08-31', series: 'B', includeRaw: true },
    });

    const text = (result.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text.split('Raw JSON:\n')[1]);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r: { series: string }) => r.series === 'B')).toBe(true);
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
});
