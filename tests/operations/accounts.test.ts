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

describe('accounts operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listAccounts', () => {
    it('returns all accounts when no search term', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 2610, Description: 'Utgående moms 25%' },
        ],
      });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      const result = await listAccounts();
      expect(result.Accounts).toHaveLength(2);
    });

    it('filters by description search term', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 2610, Description: 'Utgående moms 25%' },
          { Number: 2640, Description: 'Ingående moms' },
        ],
      });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      const result = await listAccounts({ search: 'moms' });
      expect(result.Accounts).toHaveLength(2);
    });

    it('filters by account number', async () => {
      mockFetch({
        Accounts: [
          { Number: 1930, Description: 'Företagskonto' },
          { Number: 1931, Description: 'Sparkonto' },
          { Number: 3001, Description: 'Försäljning' },
        ],
      });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      const result = await listAccounts({ search: '193' });
      expect(result.Accounts).toHaveLength(2);
    });

    it('search is case-insensitive', async () => {
      mockFetch({
        Accounts: [{ Number: 1930, Description: 'Företagskonto' }],
      });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      const result = await listAccounts({ search: 'FÖRETAG' });
      expect(result.Accounts).toHaveLength(1);
    });

    it('passes financialYear to Fortnox', async () => {
      mockFetch({ Accounts: [] });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      await listAccounts({ financialYear: 2 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('financialyear=2');
    });
  });
});
