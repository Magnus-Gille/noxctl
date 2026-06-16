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

describe('financial year operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listFinancialYears', () => {
    it('fetches financialyears and returns the envelope', async () => {
      const response = {
        FinancialYears: [{ Id: 1, FromDate: '2025-01-01', ToDate: '2025-12-31' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listFinancialYears } = await import('../../src/operations/financial-years.js');

      const result = await listFinancialYears();
      expect(result.FinancialYears).toHaveLength(1);
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('financialyears');
    });

    it('passes Date filter to find the year containing a date', async () => {
      mockFetch({ FinancialYears: [] });
      const { listFinancialYears } = await import('../../src/operations/financial-years.js');

      await listFinancialYears({ date: '2026-03-15' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('Date=2026-03-15');
    });
  });

  describe('getFinancialYear', () => {
    it('unwraps the FinancialYear envelope', async () => {
      mockFetch({ FinancialYear: { Id: 2, FromDate: '2026-01-01' } });
      const { getFinancialYear } = await import('../../src/operations/financial-years.js');

      const result = await getFinancialYear(2);
      expect(result.Id).toBe(2);
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('financialyears/2');
    });
  });

  describe('getLockedPeriod', () => {
    it('unwraps the LockedPeriod envelope', async () => {
      mockFetch({ LockedPeriod: { EndDate: '2026-01-31' } });
      const { getLockedPeriod } = await import('../../src/operations/financial-years.js');

      const result = await getLockedPeriod();
      expect(result.EndDate).toBe('2026-01-31');
      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('settings/lockedperiod');
    });

    it('returns an empty object when no period is locked', async () => {
      mockFetch({ LockedPeriod: {} });
      const { getLockedPeriod } = await import('../../src/operations/financial-years.js');

      const result = await getLockedPeriod();
      expect(result).toEqual({});
    });
  });
});
