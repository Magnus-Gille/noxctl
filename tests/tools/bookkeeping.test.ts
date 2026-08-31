import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function mockBinaryFetch(bytes: Buffer, contentType: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
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
      await client.callTool({
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

  // Issue #101: the MCP SDK strips any key the schema does not declare, so a
  // per-line note passed as TransactionInformation vanished silently — the
  // voucher booked fine with the data simply missing. Same root cause as the
  // Supplier gap in #96, so assert the declared property list, not just a
  // forwarded subset.
  describe('voucher row schema covers the real row shape', () => {
    const rowFields = [
      'Account',
      'Debit',
      'Credit',
      'Description',
      'TransactionInformation',
      'CostCenter',
      'Project',
      'Quantity',
      'Removed',
    ];

    it('declares every writable VoucherRow field', async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'fortnox_create_voucher')!.inputSchema as {
        properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
      };
      const declared = Object.keys(schema.properties.VoucherRows?.items?.properties ?? {});
      for (const field of rowFields) {
        expect(declared).toContain(field);
      }
    });

    it('forwards per-row fields to Fortnox instead of dropping them', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1, VoucherSeries: 'A' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_voucher',
        arguments: {
          Description: 'Test',
          TransactionDate: '2026-03-01',
          confirm: true,
          VoucherRows: [
            {
              Account: 5460,
              Debit: 194.32,
              TransactionInformation: 'Kaffe till kontoret, faktura 1234',
              CostCenter: '9050',
              Project: '1002',
              Quantity: 2,
            },
            { Account: 1930, Credit: 194.32 },
          ],
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(fetchCall[1].body as string).Voucher.VoucherRows[0];
      expect(sent.TransactionInformation).toBe('Kaffe till kontoret, faktura 1234');
      expect(sent.CostCenter).toBe('9050');
      expect(sent.Project).toBe('1002');
      expect(sent.Quantity).toBe(2);
    });

    it('steers callers to TransactionInformation for per-line free text', async () => {
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === 'fortnox_create_voucher')!.inputSchema as {
        properties: Record<
          string,
          { items?: { properties?: Record<string, { description?: string }> } }
        >;
      };
      const rowProps = schema.properties.VoucherRows?.items?.properties ?? {};
      expect(rowProps.Description?.description).toMatch(/TransactionInformation/);
    });
  });

  describe('fortnox_attach_voucher_files', () => {
    it('returns isError when confirm is missing', async () => {
      mockFetch({});

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_attach_voucher_files',
        arguments: {
          series: 'A',
          voucherNumber: '60',
          files: ['/tmp/receipt.pdf'],
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('returns dryRun preview without uploading', async () => {
      mockFetch({});

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_attach_voucher_files',
        arguments: {
          series: 'A',
          voucherNumber: '61',
          files: ['/tmp/ica.pdf'],
          dryRun: true,
        },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_list_voucher_attachments', () => {
    it('lists attached files for a voucher', async () => {
      mockFetch({
        VoucherFileConnections: [
          {
            FileId: 'f1',
            Name: 'receipt.pdf',
            VoucherSeries: 'A',
            VoucherNumber: '60',
            VoucherYear: 4,
          },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_voucher_attachments',
        arguments: { series: 'A', voucherNumber: '60', financialYear: 4 },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('receipt.pdf');
      expect(text).toContain('f1');
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('voucherseries=A');
      expect(calledUrl).toContain('vouchernumber=60');
      expect(calledUrl).toContain('voucheryear=4');
    });

    it('is read-only — no confirmation required', async () => {
      mockFetch({ VoucherFileConnections: [] });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_voucher_attachments',
        arguments: { series: 'A', voucherNumber: '60' },
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe('fortnox_get_voucher_file', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('downloads the file and saves it to a temp path, returning that path', async () => {
      const bytes = Buffer.from('%PDF-1.4 fake receipt bytes');
      mockBinaryFetch(bytes, 'application/pdf');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_voucher_file',
        arguments: { fileId: 'f1' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0].text;
      const match = text.match(/till (.+voucher-file-f1\.pdf)/);
      expect(match).not.toBeNull();
      const savedPath = match![1]!;
      expect(readFileSync(savedPath).equals(bytes)).toBe(true);
      rmSync(savedPath, { force: true });
    });

    it('writes to an explicit outputPath when given', async () => {
      const bytes = Buffer.from('image-bytes');
      mockBinaryFetch(bytes, 'image/jpeg');
      const target = `${tmpdir()}/noxctl-test-voucher-file.jpg`;
      rmSync(target, { force: true });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_voucher_file',
        arguments: { fileId: 'f2', outputPath: target },
      });

      expect(result.isError).toBeFalsy();
      expect(readFileSync(target).equals(bytes)).toBe(true);
      rmSync(target, { force: true });
    });

    it('refuses to overwrite an existing file without overwrite: true', async () => {
      const target = `${tmpdir()}/noxctl-test-voucher-file-exists.pdf`;
      writeFileSync(target, 'already here');
      mockBinaryFetch(Buffer.from('new-bytes'), 'application/pdf');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_voucher_file',
        arguments: { fileId: 'f3', outputPath: target },
      });

      expect(result.isError).toBe(true);
      rmSync(target, { force: true });
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
      expect(parsed.Accounts).toHaveLength(2);
      expect(parsed.Accounts[0].Description).toContain('moms');
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
      expect(parsed.Accounts).toHaveLength(2);
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
