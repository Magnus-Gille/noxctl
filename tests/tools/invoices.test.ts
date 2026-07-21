import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const PDF_BYTES = Buffer.from('%PDF-1.4\ninvoice bytes\n%%EOF\n');

function pdfResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/pdf' }),
    arrayBuffer: () =>
      Promise.resolve(
        PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset, PDF_BYTES.byteOffset + PDF_BYTES.byteLength),
      ),
    text: () => Promise.resolve(PDF_BYTES.toString('utf-8')),
  };
}

// The print/preview endpoints answer with application/pdf, not JSON.
function mockPdf() {
  global.fetch = vi.fn().mockResolvedValue(pdfResponse());
}

// /print returns the PDF; the follow-up GET reports the post-print invoice.
function mockPdfThenInvoice(invoice: Record<string, unknown>) {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce(pdfResponse())
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ Invoice: invoice })),
      json: () => Promise.resolve({ Invoice: invoice }),
    });
}

// Saving a PDF *and* marking it sent is three calls: /preview for the bytes,
// /print for the mutation, then a read-back of the invoice.
function mockPreviewPrintThenInvoice(invoice: Record<string, unknown>) {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce(pdfResponse())
    .mockResolvedValueOnce(pdfResponse())
    .mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ Invoice: invoice })),
      json: () => Promise.resolve({ Invoice: invoice }),
    });
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('invoice tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_invoices', () => {
    it('lists invoices with default params', async () => {
      mockFetch({
        Invoices: [
          { DocumentNumber: '1', CustomerName: 'Acme', Total: 10000 },
          { DocumentNumber: '2', CustomerName: 'Globex', Total: 5000 },
        ],
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_invoices', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Acme');
      expect(text).toContain('Globex');
    });

    it('filters by status', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { filter: 'unpaidoverdue' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaidoverdue');
    });

    it('filters by date range', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { fromDate: '2025-01-01', toDate: '2025-03-31' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
    });

    it('filters by customer number', async () => {
      mockFetch({ Invoices: [] });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_invoices',
        arguments: { customerNumber: '42' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
    });
  });

  describe('fortnox_get_invoice', () => {
    it('fetches a single invoice with rows', async () => {
      mockFetch({
        Invoice: {
          DocumentNumber: '1001',
          CustomerNumber: '42',
          InvoiceRows: [{ Description: 'Konsulttjänst', DeliveredQuantity: 10, Price: 1200 }],
          Total: 15000,
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_invoice',
        arguments: { documentNumber: '1001', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.DocumentNumber).toBe('1001');
      expect(parsed.InvoiceRows).toHaveLength(1);
    });
  });

  describe('fortnox_create_invoice', () => {
    it('creates an invoice with rows', async () => {
      mockFetch({
        Invoice: { DocumentNumber: '1002', CustomerNumber: '42', Total: 12500 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: {
          CustomerNumber: '42',
          InvoiceRows: [{ Description: 'Konsulttimmar', DeliveredQuantity: 10, Price: 1000 }],
          OurReference: 'Casey Example',
          DueDate: '2025-04-30',
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Invoice.CustomerNumber).toBe('42');
      expect(body.Invoice.InvoiceRows).toHaveLength(1);
      expect(body.Invoice.OurReference).toBe('Casey Example');
    });

    it('creates invoice with multiple rows and VAT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1003', Total: 25000 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: {
          CustomerNumber: '42',
          InvoiceRows: [
            { Description: 'Utveckling', DeliveredQuantity: 8, Price: 1200, VAT: 25, Unit: 'tim' },
            { Description: 'Resekostnader', DeliveredQuantity: 1, Price: 500, VAT: 25 },
          ],
          Currency: 'SEK',
          confirm: true,
        },
      });

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.Invoice.InvoiceRows).toHaveLength(2);
      expect(body.Invoice.InvoiceRows[0].VAT).toBe(25);
      expect(body.Invoice.InvoiceRows[0].Unit).toBe('tim');
    });
  });

  describe('fortnox_send_invoice', () => {
    it('sends invoice via email by default', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Sent: true } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/email');
      expect((result.content as { type: string; text: string }[])[0].text).toContain('email');
    });

    it('sends invoice via print', async () => {
      mockPdfThenInvoice({ DocumentNumber: '1001', Sent: true });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', method: 'print', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/print');
      // The PDF body must not surface as an error to the caller.
      expect(result.isError).toBeFalsy();
    });

    it('sends invoice via e-invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', method: 'einvoice', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/einvoice');
    });
  });

  describe('fortnox_invoice_pdf', () => {
    it('saves the PDF and returns the path rather than the bytes', async () => {
      mockPdf();
      const target = join(tmpdir(), `noxctl-test-${process.pid}.pdf`);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: target },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain(target);
      expect(readFileSync(target).equals(PDF_BYTES)).toBe(true);
      // The PDF itself must never be inlined into the tool response.
      expect(text).not.toContain('%PDF');
      rmSync(target, { force: true });
    });

    it('uses /preview so a plain download needs no confirmation and does not mark the invoice sent', async () => {
      mockPdf();
      const target = join(tmpdir(), `noxctl-test-preview-${process.pid}.pdf`);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: target },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/preview');
      expect(result.isError).toBeFalsy();
      rmSync(target, { force: true });
    });

    // Tool arguments are agent-generated and can be prompt-injection influenced,
    // so a stray path must not silently truncate an existing file.
    it('refuses to clobber an existing file unless overwrite is set', async () => {
      mockPdf();
      const target = join(tmpdir(), `noxctl-test-existing-${process.pid}.pdf`);
      writeFileSync(target, 'important pre-existing content');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: target },
      });

      expect(result.isError).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe('important pre-existing content');
      rmSync(target, { force: true });
    });

    // `w` follows symlinks, so an agent-supplied path pointing at a symlink
    // could truncate whatever it targets. overwrite must not enable that.
    it('refuses to write through a symlink even with overwrite set', async () => {
      mockPdf();
      const dir = mkdtempSync(join(tmpdir(), 'noxctl-symlink-test-'));
      const realFile = join(dir, 'real.txt');
      const link = join(dir, 'link.pdf');
      writeFileSync(realFile, 'SECRET ORIGINAL');
      symlinkSync(realFile, link);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: link, overwrite: true },
      });

      expect(result.isError).toBe(true);
      expect(readFileSync(realFile, 'utf-8')).toBe('SECRET ORIGINAL');
      rmSync(dir, { recursive: true, force: true });
    });

    it('replaces an existing file when overwrite is explicitly set', async () => {
      mockPdf();
      const target = join(tmpdir(), `noxctl-test-overwrite-${process.pid}.pdf`);
      writeFileSync(target, 'stale');

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: target, overwrite: true },
      });

      expect(result.isError).toBeFalsy();
      expect(readFileSync(target).equals(PDF_BYTES)).toBe(true);
      rmSync(target, { force: true });
    });

    // Asking for markSent is not evidence that it took effect. If Fortnox
    // reports the invoice as still unsent, say so rather than confirming.
    it('does not claim the invoice is sent when Fortnox reports otherwise', async () => {
      // The markSent flow is three calls: /preview, /print, then the read-back.
      mockPreviewPrintThenInvoice({ DocumentNumber: '1001', Sent: false });
      const target = join(tmpdir(), `noxctl-test-unsent-${process.pid}.pdf`);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', outputPath: target, markSent: true, confirm: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).not.toContain('är nu markerad som skickad');
      expect(text).toMatch(/Varning/);
      rmSync(target, { force: true });
    });

    it('requires confirmation for markSent because it mutates the invoice', async () => {
      mockPdf();

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', markSent: true },
      });

      expect(result.isError).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not call Fortnox on dryRun', async () => {
      mockPdf();

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_invoice_pdf',
        arguments: { documentNumber: '1001', dryRun: true },
      });

      expect((result.content as { type: string; text: string }[])[0].text).toContain('Dry run');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fortnox_bookkeep_invoice', () => {
    it('bookkeeps an invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Booked: true } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_bookkeep_invoice',
        arguments: { documentNumber: '1001', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/bookkeep');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PUT');
      expect((result.content as { type: string; text: string }[])[0].text).toContain('bokförd');
    });
  });

  describe('fortnox_credit_invoice', () => {
    it('credits an invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', CreditInvoiceReference: '1001' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_credit_invoice',
        arguments: { documentNumber: '1001', confirm: true },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/credit');
      expect((result.content as { type: string; text: string }[])[0].text).toContain(
        'Kreditfaktura',
      );
    });

    it('supports dry-run for invoice send without side effects', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '1001', dryRun: true },
      });

      expect(result.isError).toBeFalsy();
      expect((result.content as { type: string; text: string }[])[0].text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
