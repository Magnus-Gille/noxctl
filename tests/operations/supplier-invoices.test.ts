import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

function mockBinary(bytes: Buffer, contentType: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
}

describe('supplier invoice operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSupplierInvoices', () => {
    it('passes filter as query parameter', async () => {
      mockFetch({ SupplierInvoices: [], MetaInformation: {} });
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      await listSupplierInvoices({ filter: 'unpaid' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('filter=unpaid');
    });

    it('filters by supplier number', async () => {
      mockFetch({ SupplierInvoices: [], MetaInformation: {} });
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      await listSupplierInvoices({ supplierNumber: '5' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('suppliernumber=5');
    });

    it('returns the full envelope', async () => {
      const response = {
        SupplierInvoices: [{ GivenNumber: 1, SupplierName: 'Test' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listSupplierInvoices } = await import('../../src/operations/supplier-invoices.js');

      const result = await listSupplierInvoices();
      expect(result.SupplierInvoices).toHaveLength(1);
    });
  });

  describe('getSupplierInvoice', () => {
    it('unwraps the SupplierInvoice envelope', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 1, SupplierName: 'Test', Total: 5000 },
      });
      const { getSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      const result = await getSupplierInvoice('1');
      expect(result.GivenNumber).toBe(1);
      expect(result.Total).toBe(5000);
    });
  });

  describe('createSupplierInvoice', () => {
    it('wraps params in SupplierInvoice envelope for POST', async () => {
      mockFetch({
        SupplierInvoice: { GivenNumber: 10, SupplierNumber: '5' },
      });
      const { createSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      await createSupplierInvoice({
        SupplierNumber: '5',
        Total: 1250,
        SupplierInvoiceRows: [
          { Account: 5410, Debit: 1000 },
          { Account: 2641, Debit: 250 },
          { Account: 2440, Credit: 1250 },
        ],
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SupplierInvoice.SupplierNumber).toBe('5');
      expect(body.SupplierInvoice.SupplierInvoiceRows).toHaveLength(3);
    });
  });

  describe('bookkeepSupplierInvoice', () => {
    it('sends PUT to bookkeep endpoint', async () => {
      mockFetch({ SupplierInvoice: { GivenNumber: 1, Booked: true } });
      const { bookkeepSupplierInvoice } = await import('../../src/operations/supplier-invoices.js');

      await bookkeepSupplierInvoice('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('supplierinvoices/1/bookkeep');
      expect(fetchCall[1].method).toBe('PUT');
    });
  });

  describe('listSupplierInvoiceAttachments', () => {
    it('GETs supplierinvoicefileconnections filtered by supplierinvoicenumber and maps the response', async () => {
      const { listSupplierInvoiceAttachments } =
        await import('../../src/operations/supplier-invoices.js');
      mockFetch({
        SupplierInvoiceFileConnections: [
          { FileId: 'f1', Name: 'invoice-scan.pdf', SupplierInvoiceNumber: '1' },
        ],
      });

      const result = await listSupplierInvoiceAttachments('1');

      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('supplierinvoicefileconnections');
      expect(url).toContain('supplierinvoicenumber=1');
      expect(result).toEqual([
        { fileName: 'invoice-scan.pdf', fileId: 'f1', supplierInvoiceNumber: '1' },
      ]);
    });

    it('returns an empty array when the invoice has no attachments', async () => {
      const { listSupplierInvoiceAttachments } =
        await import('../../src/operations/supplier-invoices.js');
      mockFetch({ SupplierInvoiceFileConnections: [] });

      const result = await listSupplierInvoiceAttachments('2');

      expect(result).toEqual([]);
    });
  });

  describe('getSupplierInvoiceFile', () => {
    it('GETs inbox/{fileId} and returns the raw bytes with content-type', async () => {
      const { getSupplierInvoiceFile } = await import('../../src/operations/supplier-invoices.js');
      const bytes = Buffer.from('fake-pdf-bytes');
      mockBinary(bytes, 'application/pdf');

      const result = await getSupplierInvoiceFile('f1');

      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('inbox/f1');
      expect(result.fileId).toBe('f1');
      expect(result.contentType).toBe('application/pdf');
      expect(result.buffer.equals(bytes)).toBe(true);
    });

    it('throws when Fortnox answers 2xx with a JSON error envelope instead of file bytes', async () => {
      const { getSupplierInvoiceFile } = await import('../../src/operations/supplier-invoices.js');
      const bytes = Buffer.from(
        JSON.stringify({ ErrorInformation: { message: 'not found', code: 123 } }),
      );
      mockBinary(bytes, 'application/json');

      await expect(getSupplierInvoiceFile('missing')).rejects.toThrow(/not found/);
    });
  });

  describe('supplier invoice comment log', () => {
    it('lists comments from the commentlog path and unwraps the array', async () => {
      mockFetch({
        SupplierInvoiceCommentLog: [{ Id: 'c-1', Comment: 'Kontrollerad', UserId: 3 }],
      });
      const { listSupplierInvoiceComments } =
        await import('../../src/operations/supplier-invoices.js');

      const comments = await listSupplierInvoiceComments('7');

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { method?: string } | undefined,
      ];
      expect(url).toBe('https://api.fortnox.se/3/supplierinvoices/7/commentlog');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(comments).toEqual([{ Id: 'c-1', Comment: 'Kontrollerad', UserId: 3 }]);
    });

    it('creates a comment with only the Comment field in the body', async () => {
      mockFetch({ SupplierInvoiceCommentLog: { Id: 'c-2', Comment: 'Hej' } });
      const { createSupplierInvoiceComment } =
        await import('../../src/operations/supplier-invoices.js');

      const created = await createSupplierInvoiceComment('7', { Comment: 'Hej' });

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { method?: string; body?: string },
      ];
      expect(url).toBe('https://api.fortnox.se/3/supplierinvoices/7/commentlog');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body ?? 'null')).toEqual({
        SupplierInvoiceCommentLog: { Comment: 'Hej' },
      });
      expect(created).toEqual({ Id: 'c-2', Comment: 'Hej' });
    });

    it('deletes one comment by encoded id and accepts an empty 204 body', async () => {
      // Fortnox answers a comment delete with 204 and no body at all.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(''),
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      });
      const { deleteSupplierInvoiceComment } =
        await import('../../src/operations/supplier-invoices.js');

      await expect(deleteSupplierInvoiceComment('7', 'c 1/x')).resolves.toBeUndefined();

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { method?: string },
      ];
      expect(url).toBe('https://api.fortnox.se/3/supplierinvoices/7/commentlog/c%201%2Fx');
      expect(init.method).toBe('DELETE');
    });

    it('refuses dot-segment comment ids before calling Fortnox', async () => {
      mockFetch({});
      const { deleteSupplierInvoiceComment } =
        await import('../../src/operations/supplier-invoices.js');

      await expect(deleteSupplierInvoiceComment('7', '..')).rejects.toThrow(/comment ID/);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
