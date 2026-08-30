import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  // Needed by FortnoxApiError, which prefixes messages with the active profile.
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

const fsMock = vi.hoisted(() => {
  const readFileSync = vi.fn(() => Buffer.from('fake-file-content'));
  const existsSync = vi.fn(() => true);
  const statSync = vi.fn(() => ({ isFile: () => true }));
  return { readFileSync, existsSync, statSync };
});
vi.mock('node:fs', () => ({
  default: {
    readFileSync: fsMock.readFileSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
  },
  readFileSync: fsMock.readFileSync,
  existsSync: fsMock.existsSync,
  statSync: fsMock.statSync,
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

const PDF_BYTES = Buffer.from('%PDF-1.4\ninvoice bytes\n%%EOF\n');

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
  beforeEach(() => {
    // Re-establish fs defaults each test (restoreAllMocks below clears them).
    fsMock.readFileSync.mockReturnValue(Buffer.from('fake-file-content'));
    fsMock.existsSync.mockReturnValue(true);
    fsMock.statSync.mockReturnValue({ isFile: () => true });
  });

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

    // A truncated PDF still starts with %PDF-, so the magic number alone is not
    // enough: offering it to the caller would let a good saved copy be replaced
    // by a broken one.
    it('withholds a truncated print PDF rather than letting it replace a good copy', async () => {
      const truncated = Buffer.from('%PDF-1.4\ninvoice bytes but cut off mid-str');
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(pdfResponse(truncated))
        .mockResolvedValue({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify({ Invoice: { DocumentNumber: '1001', Sent: true } })),
          json: () => Promise.resolve({ Invoice: { DocumentNumber: '1001', Sent: true } }),
        });
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      const result = await markInvoicePrinted('1001');

      expect(result.confirmed).toBe(true);
      expect(result.invoice.Sent).toBe(true);
      expect(result.pdf).toBeUndefined();
    });

    // Fortnox can answer 2xx with an error envelope. Unlike an unreadable body,
    // that is positive evidence the print did NOT happen — so it must not be
    // reported as a successful "marked as sent".
    it('raises when /print answers 200 with a Fortnox error envelope', async () => {
      const envelope = Buffer.from(
        JSON.stringify({ ErrorInformation: { message: 'Kan inte skriva ut', code: 2000999 } }),
      );
      global.fetch = vi.fn().mockResolvedValue(pdfResponse(envelope));
      const { markInvoicePrinted } = await import('../../src/operations/invoices.js');

      await expect(markInvoicePrinted('1001')).rejects.toThrow(/Kan inte skriva ut/);
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

      // The print was accepted, so this is not an error...
      expect(result.invoice.DocumentNumber).toBe('1001');
      // ...but the outcome was never confirmed, so it must NOT claim Sent.
      expect(result.confirmed).toBe(false);
      expect(result.invoice.Sent).toBeUndefined();
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

  describe('attachInvoiceFiles', () => {
    it('uploads to /3/archive?folderid=inbox_kf and attaches with ArchiveFileId (not Id)', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');

      const mockFn = vi
        .fn()
        // upload: POST /3/archive?folderid=inbox_kf
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                File: { Id: 'wrong-id', ArchiveFileId: 'arch-1', Name: 'underlag.pdf' },
              }),
            ),
          json: () =>
            Promise.resolve({
              File: { Id: 'wrong-id', ArchiveFileId: 'arch-1', Name: 'underlag.pdf' },
            }),
        })
        // attach: POST /api/fileattachments/attachments-v1
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                {
                  id: 'attach-1',
                  entityId: 91110646,
                  entityType: 'F',
                  fileId: 'arch-1',
                  includeOnSend: true,
                },
              ]),
            ),
          json: () =>
            Promise.resolve([
              {
                id: 'attach-1',
                entityId: 91110646,
                entityType: 'F',
                fileId: 'arch-1',
                includeOnSend: true,
              },
            ]),
        });
      global.fetch = mockFn;

      const results = await attachInvoiceFiles({
        documentNumber: '91110646',
        filePaths: ['/tmp/underlag.pdf'],
      });

      const [uploadUrl, uploadInit] = mockFn.mock.calls[0] as [string, RequestInit];
      expect(uploadUrl).toContain('/3/archive');
      expect(uploadUrl).toContain('folderid=inbox_kf');
      expect(uploadInit.method).toBe('POST');
      expect(uploadInit.body).toBeInstanceOf(FormData);

      const [attachUrl, attachInit] = mockFn.mock.calls[1] as [string, RequestInit];
      expect(attachUrl).toContain('/api/fileattachments/attachments-v1');
      const attachBody = JSON.parse(attachInit.body as string);
      // The critical, easy-to-regress detail: the ARCHIVE upload's `Id` must
      // never be used — only `ArchiveFileId`. Using `Id` here fails on the
      // real API with wrong_file_location.
      expect(attachBody[0].fileId).toBe('arch-1');
      expect(attachBody[0].fileId).not.toBe('wrong-id');
      expect(attachBody[0].entityType).toBe('F');
      expect(attachBody[0].entityId).toBe(91110646);

      expect(results).toEqual([
        {
          fileName: 'underlag.pdf',
          fileId: 'arch-1',
          attachmentId: 'attach-1',
          includeOnSend: true,
        },
      ]);
    });

    it('defaults includeOnSend to true when not specified', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(JSON.stringify({ File: { ArchiveFileId: 'a1', Name: 'x.pdf' } })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                { id: 'att1', entityId: 1, entityType: 'F', fileId: 'a1', includeOnSend: true },
              ]),
            ),
        });
      global.fetch = mockFn;

      await attachInvoiceFiles({ documentNumber: '1', filePaths: ['/tmp/x.pdf'] });

      const [, attachInit] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(attachInit.body as string);
      expect(body[0].includeOnSend).toBe(true);
    });

    it('honors an explicit includeOnSend: false', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(JSON.stringify({ File: { ArchiveFileId: 'a2', Name: 'y.pdf' } })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                { id: 'att2', entityId: 1, entityType: 'F', fileId: 'a2', includeOnSend: false },
              ]),
            ),
        });
      global.fetch = mockFn;

      await attachInvoiceFiles({
        documentNumber: '1',
        filePaths: ['/tmp/y.pdf'],
        includeOnSend: false,
      });

      const [, attachInit] = mockFn.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(attachInit.body as string);
      expect(body[0].includeOnSend).toBe(false);
    });

    it('fails fast (before any upload) when a file path does not exist', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      fsMock.existsSync.mockReturnValue(false);
      mockFetch({});

      await expect(
        attachInvoiceFiles({ documentNumber: '1', filePaths: ['/tmp/missing.pdf'] }),
      ).rejects.toThrow(/File not found: \/tmp\/missing\.pdf/);

      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('rejects a directory path before uploading', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      fsMock.statSync.mockReturnValue({ isFile: () => false });
      mockFetch({});

      await expect(
        attachInvoiceFiles({ documentNumber: '1', filePaths: ['/tmp/adir'] }),
      ).rejects.toThrow(/Not a file: \/tmp\/adir/);

      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('surfaces already-attached files when a later file fails mid-batch', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      const mockFn = vi
        .fn()
        // file 1 upload OK
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(JSON.stringify({ File: { ArchiveFileId: 'a1', Name: 'a.pdf' } })),
        })
        // file 1 attach OK
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                { id: 'att1', entityId: 1, entityType: 'F', fileId: 'a1', includeOnSend: true },
              ]),
            ),
        })
        // file 2 upload FAILS
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve(JSON.stringify({ ErrorInformation: { message: 'boom' } })),
        });
      global.fetch = mockFn;

      await expect(
        attachInvoiceFiles({ documentNumber: '1', filePaths: ['/tmp/a.pdf', '/tmp/b.pdf'] }),
      ).rejects.toThrow(/already attached this run: a\.pdf/);
    });

    it('throws when Fortnox returns no attachment record for the invoice', async () => {
      const { attachInvoiceFiles } = await import('../../src/operations/invoices.js');
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(JSON.stringify({ File: { ArchiveFileId: 'a1', Name: 'a.pdf' } })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify([])),
        });
      global.fetch = mockFn;

      await expect(
        attachInvoiceFiles({ documentNumber: '1', filePaths: ['/tmp/a.pdf'] }),
      ).rejects.toThrow(/did not return an attachment record/);
    });
  });

  describe('listInvoiceAttachments', () => {
    it('GETs the fileattachments product API filtered by entity id/type', async () => {
      const { listInvoiceAttachments } = await import('../../src/operations/invoices.js');
      mockFetch([
        { id: 'att1', entityId: 91110646, entityType: 'F', fileId: 'a1', includeOnSend: true },
      ]);

      const result = await listInvoiceAttachments('91110646');

      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/api/fileattachments/attachments-v1');
      expect(url).toContain('entityid=91110646');
      expect(url).toContain('entitytype=F');
      expect(result).toEqual([
        { id: 'att1', entityId: 91110646, entityType: 'F', fileId: 'a1', includeOnSend: true },
      ]);
    });
  });
});
