import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

const fsMock = vi.hoisted(() => {
  const readFileSync = vi.fn(() => Buffer.from('fake-file-content'));
  const existsSync = vi.fn(() => true);
  return { readFileSync, existsSync };
});
vi.mock('node:fs', () => ({
  default: { readFileSync: fsMock.readFileSync, existsSync: fsMock.existsSync },
  readFileSync: fsMock.readFileSync,
  existsSync: fsMock.existsSync,
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

describe('voucher operations', () => {
  beforeEach(() => {
    // Re-establish fs defaults each test (restoreAllMocks below clears them).
    fsMock.readFileSync.mockReturnValue(Buffer.from('fake-file-content'));
    fsMock.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listVouchers', () => {
    it('routes to sublist/{series} when series is provided', async () => {
      mockFetch({ Vouchers: [], MetaInformation: {} });
      const { listVouchers } = await import('../../src/operations/vouchers.js');

      await listVouchers({ series: 'A' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('vouchers/sublist/A');
    });

    it('rejects invalid voucher series path segments', async () => {
      mockFetch({ Vouchers: [], MetaInformation: {} });
      const { listVouchers } = await import('../../src/operations/vouchers.js');

      await expect(listVouchers({ series: '../A' })).rejects.toThrow('Invalid voucher series');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('routes to vouchers/ when no series', async () => {
      mockFetch({ Vouchers: [], MetaInformation: {} });
      const { listVouchers } = await import('../../src/operations/vouchers.js');

      await listVouchers({});

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('vouchers/');
      expect(calledUrl).not.toContain('sublist');
    });

    it('passes financialYear, fromDate, toDate, page, limit params', async () => {
      mockFetch({ Vouchers: [], MetaInformation: {} });
      const { listVouchers } = await import('../../src/operations/vouchers.js');

      await listVouchers({
        financialYear: 2025,
        fromDate: '2025-01-01',
        toDate: '2025-06-30',
        page: 2,
        limit: 50,
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('financialyear=2025');
      expect(calledUrl).toContain('fromdate=2025-01-01');
      expect(calledUrl).toContain('todate=2025-06-30');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=50');
    });
  });

  describe('createVoucher', () => {
    it('wraps params in Voucher envelope for POST', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1 } });
      const { createVoucher } = await import('../../src/operations/vouchers.js');

      await createVoucher({
        Description: 'Test',
        TransactionDate: '2025-01-15',
        VoucherRows: [
          { Account: 1930, Debit: 100 },
          { Account: 2640, Credit: 100 },
        ],
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Voucher.Description).toBe('Test');
      expect(body.Voucher.VoucherRows).toHaveLength(2);
    });

    it('defaults VoucherSeries to "A" when not provided', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1, VoucherSeries: 'A' } });
      const { createVoucher } = await import('../../src/operations/vouchers.js');

      await createVoucher({ Description: 'Test', TransactionDate: '2025-01-15', VoucherRows: [] });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Voucher.VoucherSeries).toBe('A');
    });

    it('preserves provided VoucherSeries', async () => {
      mockFetch({ Voucher: { VoucherNumber: 1, VoucherSeries: 'B' } });
      const { createVoucher } = await import('../../src/operations/vouchers.js');

      await createVoucher({
        Description: 'Test',
        TransactionDate: '2025-01-15',
        VoucherRows: [],
        VoucherSeries: 'B',
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Voucher.VoucherSeries).toBe('B');
    });
  });

  describe('uploadInboxFile', () => {
    it('POSTs to inbox with a FormData body and returns File object', async () => {
      const { uploadInboxFile } = await import('../../src/operations/vouchers.js');
      mockFetch({ File: { Id: 'abc-123', Name: 'receipt.pdf', ArchiveFileId: 'arch-1' } });

      const result = await uploadInboxFile('/tmp/receipt.pdf');

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(fetchCalls).toHaveLength(1);
      const [url, init] = fetchCalls[0] as [string, RequestInit];
      expect(url).toContain('inbox');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      expect(result).toMatchObject({ Id: 'abc-123', Name: 'receipt.pdf' });
    });
  });

  describe('createVoucherFileConnection', () => {
    it('POSTs to voucherfileconnections with required fields', async () => {
      const { createVoucherFileConnection } = await import('../../src/operations/vouchers.js');
      const conn = { FileId: 'f1', VoucherSeries: 'A', VoucherNumber: '60' };
      mockFetch({ VoucherFileConnection: conn });

      const result = await createVoucherFileConnection('A', '60', 'f1');

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(fetchCalls).toHaveLength(1);
      const [url, init] = fetchCalls[0] as [string, RequestInit];
      expect(url).toContain('voucherfileconnections');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.VoucherFileConnection.FileId).toBe('f1');
      expect(body.VoucherFileConnection.VoucherSeries).toBe('A');
      expect(body.VoucherFileConnection.VoucherNumber).toBe('60');
      expect(body.VoucherFileConnection.VoucherYear).toBeUndefined();
      expect(result).toMatchObject(conn);
    });

    it('includes VoucherYear when provided', async () => {
      const { createVoucherFileConnection } = await import('../../src/operations/vouchers.js');
      mockFetch({ VoucherFileConnection: { FileId: 'f2', VoucherYear: 4 } });

      await createVoucherFileConnection('A', '61', 'f2', 4);

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(init.body as string);
      expect(body.VoucherFileConnection.VoucherYear).toBe(4);
    });

    it('omits VoucherYear when not provided', async () => {
      const { createVoucherFileConnection } = await import('../../src/operations/vouchers.js');
      mockFetch({ VoucherFileConnection: { FileId: 'f3' } });

      await createVoucherFileConnection('A', '62', 'f3');

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(init.body as string);
      expect('VoucherYear' in body.VoucherFileConnection).toBe(false);
    });
  });

  describe('attachVoucherFiles', () => {
    it('uploads and connects multiple files with explicit financialYear', async () => {
      const { attachVoucherFiles } = await import('../../src/operations/vouchers.js');

      const mockFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ File: { Id: 'id1', Name: 'a.pdf' } })),
          json: () => Promise.resolve({ File: { Id: 'id1', Name: 'a.pdf' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                VoucherFileConnection: { FileId: 'id1', VoucherYear: 4 },
              }),
            ),
          json: () => Promise.resolve({ VoucherFileConnection: { FileId: 'id1', VoucherYear: 4 } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ File: { Id: 'id2', Name: 'b.jpg' } })),
          json: () => Promise.resolve({ File: { Id: 'id2', Name: 'b.jpg' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                VoucherFileConnection: { FileId: 'id2', VoucherYear: 4 },
              }),
            ),
          json: () => Promise.resolve({ VoucherFileConnection: { FileId: 'id2', VoucherYear: 4 } }),
        });

      global.fetch = mockFn;

      const results = await attachVoucherFiles({
        series: 'A',
        voucherNumber: '60',
        filePaths: ['/tmp/a.pdf', '/tmp/b.jpg'],
        financialYear: 4,
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ fileName: 'a.pdf', fileId: 'id1', voucherYear: 4 });
      expect(results[1]).toMatchObject({ fileName: 'b.jpg', fileId: 'id2', voucherYear: 4 });
    });

    it('resolves financialYear from voucher when not provided', async () => {
      const { attachVoucherFiles } = await import('../../src/operations/vouchers.js');

      const mockFn = vi
        .fn()
        // getVoucher: GET vouchers/A/1
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                Voucher: { VoucherSeries: 'A', VoucherNumber: 1, TransactionDate: '2025-03-15' },
              }),
            ),
          json: () =>
            Promise.resolve({
              Voucher: { VoucherSeries: 'A', VoucherNumber: 1, TransactionDate: '2025-03-15' },
            }),
        })
        // listFinancialYears: GET financialyears
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                FinancialYears: [{ Id: 4, FromDate: '2025-01-01', ToDate: '2025-12-31' }],
              }),
            ),
          json: () =>
            Promise.resolve({
              FinancialYears: [{ Id: 4, FromDate: '2025-01-01', ToDate: '2025-12-31' }],
            }),
        })
        // uploadInboxFile: POST inbox
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(JSON.stringify({ File: { Id: 'id-resolved', Name: 'c.pdf' } })),
          json: () => Promise.resolve({ File: { Id: 'id-resolved', Name: 'c.pdf' } }),
        })
        // createVoucherFileConnection: POST voucherfileconnections
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                VoucherFileConnection: { FileId: 'id-resolved', VoucherYear: 4 },
              }),
            ),
          json: () =>
            Promise.resolve({
              VoucherFileConnection: { FileId: 'id-resolved', VoucherYear: 4 },
            }),
        });

      global.fetch = mockFn;

      const results = await attachVoucherFiles({
        series: 'A',
        voucherNumber: '1',
        filePaths: ['/tmp/c.pdf'],
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ fileName: 'c.pdf', fileId: 'id-resolved' });
      // Connection should carry VoucherYear 4
      expect((results[0]!.connection as Record<string, unknown>).VoucherYear).toBe(4);

      // Verify the connection call included VoucherYear 4
      const connectionCall = mockFn.mock.calls[3] as [string, RequestInit];
      const body = JSON.parse(connectionCall[1].body as string);
      expect(body.VoucherFileConnection.VoucherYear).toBe(4);
    });

    it('fails fast (before any upload) when a file path does not exist', async () => {
      const { attachVoucherFiles } = await import('../../src/operations/vouchers.js');
      fsMock.existsSync.mockReturnValue(false);
      mockFetch({}); // a fetch spy so we can assert it was never called

      await expect(
        attachVoucherFiles({
          series: 'A',
          voucherNumber: '60',
          filePaths: ['/tmp/missing.pdf'],
          financialYear: 4,
        }),
      ).rejects.toThrow(/File not found: \/tmp\/missing\.pdf/);

      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('throws (telling the user to pass --year) when the financial year cannot be resolved', async () => {
      const { attachVoucherFiles } = await import('../../src/operations/vouchers.js');
      const mockFn = vi
        .fn()
        // getVoucher
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(JSON.stringify({ Voucher: { TransactionDate: '2025-03-15' } })),
        })
        // listFinancialYears -> empty
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ FinancialYears: [] })),
        });
      global.fetch = mockFn;

      await expect(
        attachVoucherFiles({ series: 'A', voucherNumber: '60', filePaths: ['/tmp/c.pdf'] }),
      ).rejects.toThrow(/pass --year/i);
    });

    it('surfaces already-attached files when an upload fails mid-batch', async () => {
      const { attachVoucherFiles } = await import('../../src/operations/vouchers.js');
      const mockFn = vi
        .fn()
        // file 1 upload OK
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ File: { Id: 'id1', Name: 'a.pdf' } })),
        })
        // file 1 connection OK
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: () => Promise.resolve(JSON.stringify({ VoucherFileConnection: { FileId: 'id1' } })),
        })
        // file 2 upload FAILS
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve(JSON.stringify({ ErrorInformation: { message: 'boom' } })),
        });
      global.fetch = mockFn;

      await expect(
        attachVoucherFiles({
          series: 'A',
          voucherNumber: '60',
          filePaths: ['/tmp/a.pdf', '/tmp/b.jpg'],
          financialYear: 4,
        }),
      ).rejects.toThrow(/already attached this run: a\.pdf/);
    });
  });
});
