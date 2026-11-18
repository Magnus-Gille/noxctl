import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createAccountOperations } from '../../src/operations/accounts.js';

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

    it('searches the whole chart of accounts, not just the first page (NOX-225)', async () => {
      const allAccounts = [
        ...Array.from({ length: 100 }, (_, i) => ({ Number: 1000 + i, Description: `Konto ${i}` })),
        { Number: 1930, Description: 'Företagskonto' },
      ];
      const transport = {
        request: vi.fn().mockResolvedValue({ Accounts: allAccounts.slice(0, 100) }),
        fetchAllPages: vi.fn().mockResolvedValue({ items: allAccounts, totalResources: 101 }),
      } as unknown as FortnoxTransport;
      const { listAccounts } = createAccountOperations(transport);

      const result = await listAccounts({ search: '1930' });

      expect(transport.fetchAllPages).toHaveBeenCalledWith('accounts', 'Accounts', {
        financialyear: undefined,
      });
      expect(transport.request).not.toHaveBeenCalled();
      expect(result.Accounts).toEqual([{ Number: 1930, Description: 'Företagskonto' }]);
      expect(result.MetaInformation?.['@TotalResources']).toBe(1);
    });

    it('passes financialYear to Fortnox', async () => {
      mockFetch({ Accounts: [] });
      const { listAccounts } = await import('../../src/operations/accounts.js');

      await listAccounts({ financialYear: 2 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('financialyear=2');
    });
  });

  it('gets one account by number', async () => {
    mockFetch({ Account: { Number: 1930, Description: 'Företagskonto' } });
    const { getAccount } = await import('../../src/operations/accounts.js');

    const account = await getAccount(1930);

    expect(account.Number).toBe(1930);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('accounts/1930');
  });

  it('creates an account with the Fortnox envelope', async () => {
    mockFetch({ Account: { Number: 2999, Description: 'Avräkning' } });
    const { createAccount } = await import('../../src/operations/accounts.js');

    await createAccount({ Number: 2999, Description: 'Avräkning' });

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body).Account).toEqual({ Number: 2999, Description: 'Avräkning' });
  });

  it('updates an account without duplicating its path identifier in the body', async () => {
    mockFetch({ Account: { Number: 2999, Description: 'Ny beskrivning' } });
    const { updateAccount } = await import('../../src/operations/accounts.js');

    await updateAccount(2999, { Number: 2999, Description: 'Ny beskrivning' });

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body).Account.Number).toBeUndefined();
  });

  it('deletes an account', async () => {
    mockFetch({});
    const { deleteAccount } = await import('../../src/operations/accounts.js');

    await deleteAccount(2999);

    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('accounts/2999');
    expect(call[1].method).toBe('DELETE');
  });
});
