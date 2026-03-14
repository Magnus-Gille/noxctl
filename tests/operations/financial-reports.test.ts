import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

// Helper: mock fetch to return different responses for sequential calls
function mockFetchSequence(responses: unknown[]) {
  let callCount = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    const response = responses[callCount] ?? { Accounts: [], Vouchers: [] };
    callCount++;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    });
  });
}

describe('financial reports operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getIncomeStatement', () => {
    it('groups revenue and expense accounts correctly', async () => {
      // Call 1: accounts page 1 (with meta saying 1 page)
      // Call 2: vouchers list (returns 2 vouchers)
      // Call 3-4: individual voucher fetches
      mockFetchSequence([
        {
          Accounts: [
            { Number: 3001, Description: 'Försäljning', BalanceBroughtForward: 0 },
            { Number: 5410, Description: 'Förbrukningsinventarier', BalanceBroughtForward: 0 },
            { Number: 6570, Description: 'Bankkostnader', BalanceBroughtForward: 0 },
          ],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [
            { VoucherSeries: 'A', VoucherNumber: 1 },
            { VoucherSeries: 'A', VoucherNumber: 2 },
          ],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Voucher: {
            VoucherRows: [
              { Account: 3001, Debit: 0, Credit: 50000 },
              { Account: 1930, Debit: 50000, Credit: 0 },
            ],
          },
        },
        {
          Voucher: {
            VoucherRows: [
              { Account: 5410, Debit: 3000, Credit: 0 },
              { Account: 6570, Debit: 500, Credit: 0 },
              { Account: 1930, Debit: 0, Credit: 3500 },
            ],
          },
        },
      ]);

      const { getIncomeStatement } = await import('../../src/operations/financial-reports.js');
      const report = await getIncomeStatement();

      expect(report.type).toBe('income-statement');
      expect(report.sections).toHaveLength(2); // Revenue + Other external costs
      expect(report.sections[0].label).toContain('Nettoomsättning');
      expect(report.sections[0].total).toBe(-50000); // Credit = negative in BAS
      expect(report.sections[1].label).toContain('Övriga externa kostnader');
      expect(report.sections[1].total).toBe(3500); // Debit = positive
      expect(report.netResult).toBe(-46500); // Negative = profit in BAS
    });

    it('returns empty sections when no transactions', async () => {
      mockFetchSequence([
        {
          Accounts: [{ Number: 3001, Description: 'Försäljning', BalanceBroughtForward: 0 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
      ]);

      const { getIncomeStatement } = await import('../../src/operations/financial-reports.js');
      const report = await getIncomeStatement();

      expect(report.sections).toHaveLength(0);
      expect(report.netResult).toBe(0);
    });

    it('includes period when fromDate/toDate provided', async () => {
      mockFetchSequence([
        {
          Accounts: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
      ]);

      const { getIncomeStatement } = await import('../../src/operations/financial-reports.js');
      const report = await getIncomeStatement({
        fromDate: '2026-01-01',
        toDate: '2026-03-31',
      });

      expect(report.period).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    });

    it('excludes BBF when fromDate is set (period-scoped)', async () => {
      mockFetchSequence([
        {
          Accounts: [{ Number: 3001, Description: 'Försäljning', BalanceBroughtForward: -10000 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Voucher: {
            VoucherRows: [{ Account: 3001, Debit: 0, Credit: 5000 }],
          },
        },
      ]);

      const { getIncomeStatement } = await import('../../src/operations/financial-reports.js');
      const report = await getIncomeStatement({ fromDate: '2026-02-01' });

      // Should only include the 5000 movement, not the 10000 BBF
      expect(report.sections[0].total).toBe(-5000);
    });
  });

  describe('getBalanceSheet', () => {
    it('separates assets from liabilities and equity', async () => {
      mockFetchSequence([
        {
          Accounts: [
            { Number: 1930, Description: 'Bank', BalanceBroughtForward: 100000 },
            { Number: 2081, Description: 'Aktiekapital', BalanceBroughtForward: -25000 },
            { Number: 2440, Description: 'Leverantörsskulder', BalanceBroughtForward: -5000 },
          ],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [{ VoucherSeries: 'A', VoucherNumber: 1 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Voucher: {
            VoucherRows: [
              { Account: 1930, Debit: 10000, Credit: 0 },
              { Account: 2440, Debit: 0, Credit: 10000 },
            ],
          },
        },
      ]);

      const { getBalanceSheet } = await import('../../src/operations/financial-reports.js');
      const report = await getBalanceSheet();

      expect(report.type).toBe('balance-sheet');
      expect(report.assets).toHaveLength(1); // Cash and bank
      expect(report.assets[0].total).toBe(110000); // 100000 + 10000
      expect(report.liabilitiesAndEquity).toHaveLength(2); // Equity + Accounts payable
      expect(report.totalAssets).toBe(110000);
    });

    it('always includes BBF even with toDate', async () => {
      mockFetchSequence([
        {
          Accounts: [{ Number: 1930, Description: 'Bank', BalanceBroughtForward: 50000 }],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
        {
          Vouchers: [],
          MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1 },
        },
      ]);

      const { getBalanceSheet } = await import('../../src/operations/financial-reports.js');
      const report = await getBalanceSheet({ toDate: '2026-01-31' });

      expect(report.asOfDate).toBe('2026-01-31');
      expect(report.totalAssets).toBe(50000); // BBF included
    });
  });
});
