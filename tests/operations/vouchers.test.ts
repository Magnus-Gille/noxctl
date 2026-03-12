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

describe('voucher operations', () => {
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
});
