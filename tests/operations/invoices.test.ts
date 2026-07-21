import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  // Needed by FortnoxApiError, which prefixes messages with the active profile.
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

const PDF_BYTES = Buffer.from('%PDF-1.4\ninvoice bytes');

function pdfResponse(bytes: Buffer = PDF_BYTES) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/pdf' }),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    // Faithful to a real fetch Response: .text() is available and yields the
    // PDF bytes decoded as text, which is what used to reach JSON.parse.
    text: () => Promise.resolve(bytes.toString('utf-8')),
  };
}

function mockPdf(bytes: Buffer = PDF_BYTES) {
  global.fetch = vi.fn().mockResolvedValue(pdfResponse(bytes));
}

// /print returns the PDF; the follow-up GET reports the invoice's post-print state.
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

describe('invoice operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listInvoices', () => {
    it('maps camelCase params to Fortnox param names', async () => {
      mockFetch({ Invoices: [], MetaInformation: {} });
      const { listInvoices } = await import('../../src/operations/invoices.js');

      await listInvoices({
        customerNumber: '42',
        fromDate: '2025-01-01',
        toDate: '2025-03-31',
        page: 2,
        limit: 50,
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('customernumber=42');
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-03-31');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=50');
    });

    it('returns the full envelope (for pagination)', async () => {
      const response = {
        Invoices: [{ DocumentNumber: '1' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listInvoices } = await import('../../src/operations/invoices.js');

      const result = await listInvoices();
      expect(result.Invoices).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getInvoice', () => {
    it('unwraps the Invoice wrapper', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Total: 15000 } });
      const { getInvoice } = await import('../../src/operations/invoices.js');

      const result = await getInvoice('1001');
      expect(result.DocumentNumber).toBe('1001');
      expect(result.Total).toBe(15000);
    });

    it('rejects path traversal in document numbers', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Total: 15000 } });
      const { getInvoice } = await import('../../src/operations/invoices.js');

      await expect(getInvoice('../companyinformation')).rejects.toThrow('Invalid document number');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('createInvoice', () => {
    it('wraps params in Invoice envelope for POST', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002' } });
      const { createInvoice } = await import('../../src/operations/invoices.js');

      await createInvoice({ CustomerNumber: '42', InvoiceRows: [] });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Invoice.CustomerNumber).toBe('42');
    });

    it('unwraps the response', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', Total: 5000 } });
      const { createInvoice } = await import('../../src/operations/invoices.js');

      const result = await createInvoice({ CustomerNumber: '42', InvoiceRows: [] });
      expect(result.DocumentNumber).toBe('1002');
    });
  });

  describe('sendInvoice', () => {
    it('routes to email endpoint by default', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/email');
    });

    it('routes to print endpoint', async () => {
      mockPdfThenInvoice({ DocumentNumber: '1001', Sent: true });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001', 'print');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/print');
    });

    // Regression: /print answers with application/pdf, not JSON. Parsing the PDF
    // bytes as JSON threw a bare SyntaxError *after* Fortnox had already flagged
    // the invoice as sent, so the caller saw a crash for an action that succeeded.
    it('does not choke on the PDF body that /print returns, and reports the sent invoice', async () => {
      mockPdfThenInvoice({ DocumentNumber: '1001', Sent: true });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      const result = await sendInvoice('1001', 'print');

      expect(result.Sent).toBe(true);
      expect(result.DocumentNumber).toBe('1001');
    });

    // 'email' and 'einvoice' both deliver the invoice to the customer, so an
    // unrecognised method must not quietly fall through to one of them.
    it('refuses an unrecognised send method instead of defaulting to one', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await expect(
        sendInvoice('1001', 'sms' as unknown as Parameters<typeof sendInvoice>[1]),
      ).rejects.toThrow(/Unsupported send method/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('routes to einvoice endpoint', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001' } });
      const { sendInvoice } = await import('../../src/operations/invoices.js');

      await sendInvoice('1001', 'einvoice');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/einvoice');
    });
  });

  describe('getInvoicePdf', () => {
    it('uses /preview by default so downloading a PDF does not flag the invoice as sent', async () => {
      mockPdf();
      const { getInvoicePdf } = await import('../../src/operations/invoices.js');

      const bytes = await getInvoicePdf('1001');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/preview');
      expect(calledUrl).not.toContain('/print');
      expect(bytes.equals(PDF_BYTES)).toBe(true);
    });

    // Downloading must never mutate. Marking the invoice as sent is a separate
    // step (markInvoicePrinted) that callers run *after* the bytes are on disk.
    it('never touches /print, even indirectly', async () => {
      mockPdf();
      const { getInvoicePdf } = await import('../../src/operations/invoices.js');

      await getInvoicePdf('1001');

      const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/print'))).toBe(false);
    });

    it('rejects a non-numeric document number before calling Fortnox', async () => {
      mockPdf();
      const { getInvoicePdf } = await import('../../src/operations/invoices.js');

      await expect(getInvoicePdf('../../customers/1')).rejects.toThrow();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('markInvoicePrinted', () => {
    it('calls /print and flags it as a mutation so it is never auto-retried', async () => {
      mockPdfThenInvoice({ DocumentNumber: '1001', Sent: true });
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      const result = await markInvoicePrinted('1001');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('invoices/1001/print');
      expect(result.invoice.Sent).toBe(true);
    });

    // Once /print answers 2xx, Fortnox has set Sent. Nothing after that point
    // may throw on the caller's behalf — including validation of the PDF body,
    // which this action does not even need.
    it('still reports success when the printed body is not a readable PDF', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/pdf' }),
          arrayBuffer: () => Promise.resolve(Buffer.from('truncated garbage').buffer),
        })
        .mockResolvedValue({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify({ Invoice: { DocumentNumber: '1001', Sent: true } })),
          json: () => Promise.resolve({ Invoice: { DocumentNumber: '1001', Sent: true } }),
        });
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      const result = await markInvoicePrinted('1001');

      expect(result.invoice.Sent).toBe(true);
      // No usable PDF came back, so none is offered to the caller.
      expect(result.pdf).toBeUndefined();
    });

    it('returns the printed PDF so callers can save the version that was marked sent', async () => {
      mockPdfThenInvoice({ DocumentNumber: '1001', Sent: true });
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      const result = await markInvoicePrinted('1001');

      expect(result.pdf?.equals(PDF_BYTES)).toBe(true);
    });

    // The print already succeeded at this point; failing the whole call would
    // recreate exactly the "successful action reported as a failure" ambiguity
    // this code path exists to remove.
    it('still reports success when the confirmation read-back fails', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(pdfResponse())
        .mockResolvedValue({
          ok: false,
          status: 500,
          headers: new Headers(),
          json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
        });
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      const result = await markInvoicePrinted('1001');

      expect(result.invoice.Sent).toBe(true);
      expect(result.invoice.DocumentNumber).toBe('1001');
      // The read-back failure must remain visible, not be silently swallowed.
      expect(String(result.invoice.Note)).toMatch(/Boom/);
    });
  });

  describe('bookkeepInvoice', () => {
    it('calls the bookkeep endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1001', Booked: true } });
      const { bookkeepInvoice } = await import('../../src/operations/invoices.js');

      const result = await bookkeepInvoice('1001');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('invoices/1001/bookkeep');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.Booked).toBe(true);
    });
  });

  describe('creditInvoice', () => {
    it('calls the credit endpoint with PUT', async () => {
      mockFetch({ Invoice: { DocumentNumber: '1002', CreditInvoiceReference: '1001' } });
      const { creditInvoice } = await import('../../src/operations/invoices.js');

      const result = await creditInvoice('1001');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('invoices/1001/credit');
      expect(fetchCall[1].method).toBe('PUT');
      expect(result.CreditInvoiceReference).toBe('1001');
    });
  });
});
