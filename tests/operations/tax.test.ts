import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

describe('tax operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateTaxReport', () => {
    it('aggregates VAT from voucher rows', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const response =
          callCount === 1
            ? {
                Accounts: [
                  {
                    Number: 2610,
                    Description: 'Utgående moms 25%',
                    SRU: 0,
                    BalanceBroughtForward: 0,
                    BalanceCarriedForward: -12500,
                  },
                  {
                    Number: 2640,
                    Description: 'Ingående moms',
                    SRU: 0,
                    BalanceBroughtForward: 0,
                    BalanceCarriedForward: 3200,
                  },
                ],
              }
            : {
                Vouchers: [
                  {
                    VoucherRows: [
                      { Account: 2610, Debit: 0, Credit: 12500 },
                      { Account: 2640, Debit: 3200, Credit: 0 },
                      { Account: 3001, Debit: 0, Credit: 50000 },
                    ],
                  },
                ],
              };
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
          json: () => Promise.resolve(response),
        });
      });

      const { generateTaxReport } = await import('../../src/operations/tax.js');
      const report = await generateTaxReport({ fromDate: '2025-01-01', toDate: '2025-03-31' });

      expect(report.period.from).toBe('2025-01-01');
      expect(report.vatAccounts[2610].credit).toBe(12500);
      expect(report.vatAccounts[2640].debit).toBe(3200);
      // Non-VAT accounts should not appear
      expect(report.vatAccounts[3001]).toBeUndefined();
    });

    it('filters only VAT accounts from the account list', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const response =
          callCount === 1
            ? {
                Accounts: [
                  {
                    Number: 1930,
                    Description: 'Bank',
                    SRU: 0,
                    BalanceBroughtForward: 0,
                    BalanceCarriedForward: 100000,
                  },
                  {
                    Number: 2610,
                    Description: 'Utgående moms 25%',
                    SRU: 0,
                    BalanceBroughtForward: 0,
                    BalanceCarriedForward: -5000,
                  },
                ],
              }
            : { Vouchers: [] };
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
          json: () => Promise.resolve(response),
        });
      });

      const { generateTaxReport } = await import('../../src/operations/tax.js');
      const report = await generateTaxReport({ fromDate: '2025-01-01', toDate: '2025-03-31' });

      expect(report.accountBalances).toHaveLength(1);
      expect(report.accountBalances[0].account).toBe(2610);
    });

    it('handles empty period with no transactions', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ Accounts: [] })),
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ Vouchers: [] })),
          json: () => Promise.resolve({}),
        });

      const { generateTaxReport } = await import('../../src/operations/tax.js');
      const report = await generateTaxReport({ fromDate: '2025-07-01', toDate: '2025-09-30' });

      expect(Object.keys(report.vatAccounts)).toHaveLength(0);
      expect(report.accountBalances).toHaveLength(0);
      expect(report.summary.note).toContain('Kontrollera');
    });
  });
});
