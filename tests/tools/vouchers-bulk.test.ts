import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

type Route = (url: URL) => { status?: number; body: unknown } | undefined;

// Routes by URL so one test can serve the list endpoint and the per-voucher detail
// endpoint (and a failing voucher) from the same mocked fetch.
function routeFetch(route: Route) {
  global.fetch = vi.fn().mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    const hit = route(url);
    if (!hit) throw new Error(`Unrouted request: ${url.pathname}${url.search}`);
    const status = hit.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify(hit.body)),
      json: () => Promise.resolve(hit.body),
    };
  });
}

const requestedPaths = () =>
  (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
    ([input]) => new URL(String(input)).pathname,
  );

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? '';

const voucher = (series: string, number: string, description: string) => ({
  Voucher: {
    VoucherSeries: series,
    VoucherNumber: Number(number),
    TransactionDate: '2026-10-03',
    Description: description,
    VoucherRows: [
      { Account: 5410, Debit: 125, Credit: 0, Description: 'Förbrukningsinventarier' },
      { Account: 1930, Debit: 0, Credit: 125, Description: 'Företagskonto' },
    ],
  },
});

const READ_ONLY_FORBIDDEN_FIELDS = ['confirm', 'dryRun', 'outputPath', 'overwrite'];

describe('bulk voucher read tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function inputFields(name: string) {
    const { client } = await setupClientServer();
    const tool = (await client.listTools()).tools.find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    return {
      tool: tool!,
      fields: Object.keys((tool!.inputSchema as { properties?: object }).properties ?? {}),
    };
  }

  describe('fortnox_get_vouchers', () => {
    it('declares exactly the documented read-only inputs', async () => {
      const { tool, fields } = await inputFields('fortnox_get_vouchers');

      expect([...fields].sort()).toEqual(
        ['financialYear', 'fromDate', 'includeRaw', 'limit', 'series', 'toDate', 'vouchers'].sort(),
      );
      for (const forbidden of READ_ONLY_FORBIDDEN_FIELDS) expect(fields).not.toContain(forbidden);
      expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(
        false,
      );
      expect(tool.description).toMatch(/Skrivskyddad|skrivskydd/i);
    });

    it('reads an explicit list with rows in one call, in request order', async () => {
      routeFetch((url) => {
        const match = /\/vouchers\/(\w+)\/(\d+)$/.exec(url.pathname);
        if (match)
          return { body: voucher(match[1]!, match[2]!, `Verifikation ${match[1]}${match[2]}`) };
        return undefined;
      });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: {
          vouchers: [
            { series: 'B', number: '4' },
            { series: 'A', number: '12' },
          ],
          financialYear: 4,
        },
      });

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain('B/4');
      expect(text).toContain('A/12');
      expect(text.indexOf('B/4')).toBeLessThan(text.indexOf('A/12'));
      expect(text).toContain('Verifikation A12');
      expect(text).toContain('Förbrukningsinventarier');
      expect(text).toContain('1930');
      expect(text).not.toContain('Errors');
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(String(calls[0]![0])).toContain('financialyear=4');
    });

    it('reports a failing voucher in the text without failing the call', async () => {
      routeFetch((url) => {
        if (url.pathname.endsWith('/vouchers/A/2')) {
          return {
            status: 404,
            body: { ErrorInformation: { error: 1, message: 'Verifikationen finns inte', code: 1 } },
          };
        }
        const match = /\/vouchers\/(\w+)\/(\d+)$/.exec(url.pathname);
        return match ? { body: voucher(match[1]!, match[2]!, 'Ok') } : undefined;
      });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: {
          vouchers: [
            { series: 'A', number: '1' },
            { series: 'A', number: '2' },
          ],
        },
      });

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toMatch(/1 fetched, 1 failed/);
      expect(text).toContain('Errors');
      expect(text).toContain('A/2');
      expect(text).toContain('Verifikationen finns inte');
    });

    it('lists a period, fetches rows per voucher and shows the truncation notice', async () => {
      routeFetch((url) => {
        if (url.pathname.endsWith('/vouchers/')) {
          return {
            body: {
              Vouchers: [
                { VoucherSeries: 'A', VoucherNumber: 1, Year: 4 },
                { VoucherSeries: 'A', VoucherNumber: 2, Year: 4 },
                { VoucherSeries: 'A', VoucherNumber: 3, Year: 4 },
              ],
              MetaInformation: { '@TotalResources': 3, '@TotalPages': 1, '@CurrentPage': 1 },
            },
          };
        }
        const match = /\/vouchers\/(\w+)\/(\d+)$/.exec(url.pathname);
        return match ? { body: voucher(match[1]!, match[2]!, `Period ${match[2]}`) } : undefined;
      });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: { fromDate: '2026-10-01', toDate: '2026-10-31', limit: 2 },
      });

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain('A/1');
      expect(text).toContain('A/2');
      expect(text).not.toContain('A/3');
      expect(text).toMatch(/Truncated/);
      expect(text).toContain('3 vouchers');
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
      expect(calls[0]).toContain('fromdate=2026-10-01');
      expect(calls[0]).toContain('todate=2026-10-31');
      // Detail requests reuse the list item's financial year.
      expect(calls[1]).toContain('financialyear=4');
      expect(calls).toHaveLength(3);
    });

    it('includes the raw JSON only on request', async () => {
      routeFetch(() => ({ body: voucher('A', '1', 'Raw') }));
      const { client } = await setupClientServer();
      const args = { vouchers: [{ series: 'A', number: '1' }] };

      const plain = await client.callTool({ name: 'fortnox_get_vouchers', arguments: args });
      const raw = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: { ...args, includeRaw: true },
      });

      expect(textOf(plain)).not.toContain('Raw JSON');
      expect(textOf(raw)).toContain('Raw JSON');
      expect(textOf(raw)).toContain('"VoucherRows"');
    });

    it('rejects unknown input before calling Fortnox', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: { vouchers: [{ series: 'A', number: '1' }], confirm: true },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('confirm');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects unknown fields inside a voucher reference', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: { vouchers: [{ series: 'A', number: '1', voucherNumber: '1' }] },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('voucherNumber');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('surfaces cross-field validation errors from the operation', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const both = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: {
          vouchers: [{ series: 'A', number: '1' }],
          fromDate: '2026-10-01',
          toDate: '2026-10-31',
        },
      });
      const neither = await client.callTool({ name: 'fortnox_get_vouchers', arguments: {} });
      const tooMany = await client.callTool({
        name: 'fortnox_get_vouchers',
        arguments: {
          vouchers: Array.from({ length: 51 }, (_, i) => ({ series: 'A', number: String(i + 1) })),
        },
      });

      expect(both.isError).toBe(true);
      expect(textOf(both)).toMatch(/mutually exclusive/);
      expect(neither.isError).toBe(true);
      expect(textOf(neither)).toMatch(/either "vouchers"/);
      expect(tooMany.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fortnox_get_voucher_attachment_overview', () => {
    const overviewRoute: Route = (url) => {
      if (url.pathname.endsWith('/voucherfileconnections')) {
        return {
          body: {
            VoucherFileConnections: [
              {
                FileId: 'f1',
                Name: 'kvitto.pdf',
                VoucherSeries: 'A',
                VoucherNumber: '1',
                VoucherYear: 4,
              },
              {
                FileId: 'f2',
                Name: 'faktura.pdf',
                VoucherSeries: 'A',
                VoucherNumber: '1',
                VoucherYear: 4,
              },
            ],
            MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
          },
        };
      }
      if (url.pathname.includes('/vouchers/')) {
        return {
          body: {
            Vouchers: [
              {
                VoucherSeries: 'A',
                VoucherNumber: 1,
                TransactionDate: '2026-10-01',
                Description: 'Med bilaga',
                Year: 4,
              },
              {
                VoucherSeries: 'A',
                VoucherNumber: 2,
                TransactionDate: '2026-10-02',
                Description: 'Utan bilaga',
                Year: 4,
              },
            ],
            MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
          },
        };
      }
      return undefined;
    };

    it('declares exactly the documented read-only inputs', async () => {
      const { tool, fields } = await inputFields('fortnox_get_voucher_attachment_overview');

      expect([...fields].sort()).toEqual(
        ['financialYear', 'fromDate', 'includeRaw', 'onlyMissing', 'series', 'toDate'].sort(),
      );
      for (const forbidden of READ_ONLY_FORBIDDEN_FIELDS) expect(fields).not.toContain(forbidden);
      expect(tool.description).toContain('archive');
      expect(tool.description).toMatch(/behörighetsfel/);
    });

    it('summarises counts and lists vouchers with their files, with two list calls only', async () => {
      routeFetch(overviewRoute);
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_voucher_attachment_overview',
        arguments: { fromDate: '2026-10-01', toDate: '2026-10-31', financialYear: 4 },
      });

      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toMatch(/2 vouchers, 1 with attachments, 1 without/);
      expect(text).toContain('Med bilaga');
      expect(text).toContain('Utan bilaga');
      expect(text).toContain('kvitto.pdf, faktura.pdf');
      expect(requestedPaths()).toEqual(['/3/vouchers/', '/3/voucherfileconnections']);
      const connectionUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]![0]);
      expect(connectionUrl).toContain('voucheryear=4');
    });

    it('lists only vouchers without attachments with onlyMissing', async () => {
      routeFetch(overviewRoute);
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_get_voucher_attachment_overview',
        arguments: { fromDate: '2026-10-01', toDate: '2026-10-31', onlyMissing: true },
      });

      const text = textOf(result);
      expect(text).toMatch(/2 vouchers, 1 with attachments, 1 without/);
      expect(text).toContain('Utan bilaga');
      expect(text).not.toContain('Med bilaga');
    });

    it('is read-only, rejects unknown input and validates the period', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const unknown = await client.callTool({
        name: 'fortnox_get_voucher_attachment_overview',
        arguments: { fromDate: '2026-10-01', toDate: '2026-10-31', confirm: true },
      });
      const missingDates = await client.callTool({
        name: 'fortnox_get_voucher_attachment_overview',
        arguments: {},
      });
      const badDate = await client.callTool({
        name: 'fortnox_get_voucher_attachment_overview',
        arguments: { fromDate: '2026-02-30', toDate: '2026-10-31' },
      });

      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain('confirm');
      expect(missingDates.isError).toBe(true);
      expect(badDate.isError).toBe(true);
      expect(textOf(badDate)).toContain('YYYY-MM-DD');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
