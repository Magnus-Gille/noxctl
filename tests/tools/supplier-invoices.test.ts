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

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('supplier invoice tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_supplier_invoices', () => {
    it('lists supplier invoices', async () => {
      mockFetch({
        SupplierInvoices: [
          { GivenNumber: 1, SupplierName: 'Sample Hosting AB', Total: 1299 },
          { GivenNumber: 2, SupplierName: 'Nordic Office AB', Total: 2490 },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoices',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Sample Hosting AB');
      expect(text).toContain('Nordic Office AB');
    });

    it('passes filter parameter', async () => {
      mockFetch({ SupplierInvoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_supplier_invoices',
        arguments: { filter: 'unpaid' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaid');
    });

    it('accepts every filter value the Fortnox spec allows', async () => {
      const filters = [
        'cancelled',
        'fullypaid',
        'unpaid',
        'unpaidoverdue',
        'unbooked',
        'pendingpayment',
        'authorizepending',
      ];

      for (const filter of filters) {
        mockFetch({ SupplierInvoices: [] });

        const { client } = await setupClientServer();
        await client.callTool({
          name: 'fortnox_list_supplier_invoices',
          arguments: { filter },
        });

        const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toContain(`filter=${filter}`);
      }
    });
  });

  describe('fortnox_get_supplier_invoice', () => {
    it('fetches a single supplier invoice', async () => {
      mockFetch({
        SupplierInvoice: {
          GivenNumber: 1,
          SupplierName: 'Sample Hosting AB',
          Total: 1299,
          InvoiceNumber: 'SUP-2025-001',
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice',
        arguments: { givenNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.InvoiceNumber).toBe('SUP-2025-001');
    });
  });

  describe('fortnox_create_supplier_invoice', () => {
    it('creates a supplier invoice with confirmation', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 10, SupplierNumber: '5', Total: 1250 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: {
          SupplierNumber: '5',
          Total: 1250,
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoice.SupplierNumber).toBe('5');
    });

    it('advertises and preserves the complete supplier invoice row payload', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 10, SupplierNumber: '5', Total: 1000 },
      });
      const { client } = await setupClientServer();
      const { tools } = await client.listTools();
      const createTool = tools.find((tool) => tool.name === 'fortnox_create_supplier_invoice');
      const input = createTool?.inputSchema as {
        properties: {
          SupplierInvoiceRows: {
            items: { properties: Record<string, { enum?: string[] }> };
          };
        };
      };
      const rowProperties = input.properties.SupplierInvoiceRows.items.properties;

      expect(Object.keys(rowProperties)).toHaveLength(19);
      expect(rowProperties.Code?.enum).toHaveLength(14);
      expect(rowProperties.Code?.enum).toContain('TOT');
      expect(rowProperties.Code?.enum).toContain('ACC');

      const row = {
        Account: 5410,
        AccountDescription: 'Förbrukningsinventarier',
        ArticleNumber: 'LAPTOP',
        Code: 'ACC',
        CostCenter: null,
        Credit: 0,
        CreditCurrency: 0,
        Debit: 1000,
        DebitCurrency: 1000,
        Description: 'Bakåtkompatibel beskrivning',
        ItemDescription: 'Laptop',
        Price: 1000,
        Project: 'P1',
        Quantity: 1,
        StockLocationCode: 'STH',
        StockPointCode: 'A1',
        Total: null,
        TransactionInformation: 'Laptopinköp',
        Unit: 'st',
      };

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: {
          SupplierNumber: '5',
          SupplierInvoiceRows: [row],
          confirm: true,
        },
      });

      expect(result.isError).not.toBe(true);
      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoice.SupplierInvoiceRows[0]).toEqual(row);
    });

    it.each([
      ['an unknown row code', { Account: 5410, Code: 'UNKNOWN' }],
      ['an out-of-range account', { Account: 999 }],
      ['a fractional quantity', { Account: 5410, Quantity: 1.5 }],
      [
        'overlong transaction information',
        { Account: 5410, TransactionInformation: 'x'.repeat(101) },
      ],
    ])('rejects %s before making a Fortnox request', async (_case, row) => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: {
          SupplierNumber: '5',
          SupplierInvoiceRows: [row],
          confirm: true,
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('requires confirmation', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: { SupplierNumber: '5' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('supports dry run', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice',
        arguments: { SupplierNumber: '5', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_bookkeep_supplier_invoice', () => {
    it('bookkeeps with confirmation', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 1, Booked: true },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_bookkeep_supplier_invoice',
        arguments: { givenNumber: '1', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('supplierinvoices/1/bookkeep');
    });

    it('requires confirmation', async () => {
      mockFetch({ SupplierInvoice: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_bookkeep_supplier_invoice',
        arguments: { givenNumber: '1' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_list_supplier_invoice_attachments', () => {
    it('lists attached files for a supplier invoice, even an unbooked one', async () => {
      mockFetch({
        SupplierInvoiceFileConnections: [
          { FileId: 'f1', Name: 'invoice-scan.pdf', SupplierInvoiceNumber: '1' },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoice_attachments',
        arguments: { givenNumber: '1' },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('invoice-scan.pdf');
      expect(text).toContain('f1');
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('supplierinvoicenumber=1');
    });

    it('is read-only — no confirmation required', async () => {
      mockFetch({ SupplierInvoiceFileConnections: [] });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoice_attachments',
        arguments: { givenNumber: '1' },
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe('fortnox_get_supplier_invoice_file', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('downloads the file and saves it to a temp path, returning that path', async () => {
      const bytes = Buffer.from('%PDF-1.4 fake supplier invoice scan');
      mockBinaryFetch(bytes, 'application/pdf');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice_file',
        arguments: { fileId: 'f1' },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0].text;
      const match = text.match(/till (.+supplier-invoice-file-f1\.pdf)/);
      expect(match).not.toBeNull();
      const savedPath = match![1]!;
      expect(readFileSync(savedPath).equals(bytes)).toBe(true);
      rmSync(savedPath, { force: true });
    });

    it('writes to an explicit outputPath when given', async () => {
      const bytes = Buffer.from('image-bytes');
      mockBinaryFetch(bytes, 'image/jpeg');
      const target = `${tmpdir()}/noxctl-test-supplier-invoice-file.jpg`;
      rmSync(target, { force: true });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice_file',
        arguments: { fileId: 'f2', outputPath: target },
      });

      expect(result.isError).toBeFalsy();
      expect(readFileSync(target).equals(bytes)).toBe(true);
      rmSync(target, { force: true });
    });

    it('refuses to overwrite an existing file without overwrite: true', async () => {
      const target = `${tmpdir()}/noxctl-test-supplier-invoice-file-exists.pdf`;
      writeFileSync(target, 'already here');
      mockBinaryFetch(Buffer.from('new-bytes'), 'application/pdf');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_supplier_invoice_file',
        arguments: { fileId: 'f3', outputPath: target },
      });

      expect(result.isError).toBe(true);
      rmSync(target, { force: true });
    });
  });

  describe('supplier invoice comment log tools', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('discovers the comment tools', async () => {
      const { client } = await setupClientServer();
      const names = (await client.listTools()).tools.map(({ name }) => name);
      for (const name of [
        'fortnox_list_supplier_invoice_comments',
        'fortnox_create_supplier_invoice_comment',
        'fortnox_delete_supplier_invoice_comment',
      ])
        expect(names).toContain(name);
    });

    it('lists comments as a table without confirmation', async () => {
      mockFetch({
        SupplierInvoiceCommentLog: [
          { Id: 'c-1', Comment: 'Kontrollerad av Anna', UserName: 'Anna', CreatedAt: '2026-03-01' },
        ],
      });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoice_comments',
        arguments: { givenNumber: '7' },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Kontrollerad av Anna');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
        '/supplierinvoices/7/commentlog',
      );
    });

    it('rejects confirm and dryRun on the read-only list tool', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_list_supplier_invoice_comments',
        arguments: { givenNumber: '7', dryRun: true },
      });

      expect(result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses to create a comment without confirm', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice_comment',
        arguments: { givenNumber: '7', Comment: 'Hej' },
      });

      expect(result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('previews a comment create on dryRun without calling Fortnox', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice_comment',
        arguments: { givenNumber: '7', Comment: 'Hej', dryRun: true },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Dry run');
      expect(textOf(result)).toContain('"Comment": "Hej"');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('creates a comment with confirm and posts only the Comment field', async () => {
      mockFetch({ SupplierInvoiceCommentLog: { Id: 'c-2', Comment: 'Hej' } });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice_comment',
        arguments: { givenNumber: '7', Comment: 'Hej', confirm: true },
      });

      expect(result.isError).toBeFalsy();
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
        method?: string;
        body?: string;
      };
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body ?? 'null')).toEqual({
        SupplierInvoiceCommentLog: { Comment: 'Hej' },
      });
    });

    it('rejects unknown fields on the comment create tool before calling Fortnox', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_create_supplier_invoice_comment',
        arguments: { givenNumber: '7', Comment: 'Hej', PersistToInvoice: true, dryRun: true },
      });

      expect(result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses to delete a comment without confirm', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_delete_supplier_invoice_comment',
        arguments: { givenNumber: '7', commentId: 'c-1' },
      });

      expect(result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('previews a comment delete on dryRun without calling Fortnox', async () => {
      global.fetch = vi.fn();
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_delete_supplier_invoice_comment',
        arguments: { givenNumber: '7', commentId: 'c-1', dryRun: true },
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Dry run');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('deletes a comment with confirm and accepts an empty 204 body', async () => {
      // Fortnox answers a comment delete with 204 and no body at all.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(''),
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      });
      const { client } = await setupClientServer();

      const result = await client.callTool({
        name: 'fortnox_delete_supplier_invoice_comment',
        arguments: { givenNumber: '7', commentId: 'c-1', confirm: true },
      });

      expect(result.isError).toBeFalsy();
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
        '/supplierinvoices/7/commentlog/c-1',
      );
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('DELETE');
    });
  });
});
