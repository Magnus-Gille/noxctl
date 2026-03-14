import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface AccountsResponse {
  Accounts: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListAccountsParams {
  financialYear?: number;
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listAccounts(params: ListAccountsParams = {}): Promise<AccountsResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    financialyear: params.financialYear,
  };

  let data: AccountsResponse;

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'accounts',
      'Accounts',
      queryParams,
    );
    data = {
      Accounts: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  } else {
    data = await fortnoxRequest<AccountsResponse>('accounts', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  if (params.search) {
    const term = params.search.toLowerCase();
    data.Accounts = data.Accounts.filter(
      (a) =>
        String(a.Number || '').includes(term) ||
        String(a.Description || '')
          .toLowerCase()
          .includes(term),
    );
  }

  return data;
}
