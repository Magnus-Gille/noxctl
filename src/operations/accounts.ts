import { fortnoxRequest } from '../fortnox-client.js';

interface AccountsResponse {
  Accounts: Record<string, unknown>[];
}

export interface ListAccountsParams {
  financialYear?: number;
  search?: string;
}

export async function listAccounts(
  params: ListAccountsParams = {},
): Promise<Record<string, unknown>[]> {
  const data = await fortnoxRequest<AccountsResponse>('accounts', {
    params: {
      financialyear: params.financialYear,
    },
  });

  let accounts = data.Accounts;
  if (params.search) {
    const term = params.search.toLowerCase();
    accounts = accounts.filter(
      (a) =>
        String(a.Number || '').includes(term) ||
        String(a.Description || '')
          .toLowerCase()
          .includes(term),
    );
  }

  return accounts;
}
