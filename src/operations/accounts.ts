import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

export interface AccountsResponse {
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

interface AccountResponse {
  Account: Record<string, unknown>;
}

export function createAccountOperations(transport: FortnoxTransport) {
  async function listAccounts(params: ListAccountsParams = {}): Promise<AccountsResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      financialyear: params.financialYear,
    };

    let data: AccountsResponse;

    // Fortnox has no server-side account search, so a search must filter the
    // whole chart of accounts; filtering one page silently misses matches.
    if (params.all || params.search) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'accounts',
        'Accounts',
        queryParams,
      );
      data = {
        Accounts: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    } else {
      data = await transport.request<AccountsResponse>('accounts', {
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
      data.MetaInformation = {
        '@TotalResources': data.Accounts.length,
        '@TotalPages': 1,
        '@CurrentPage': 1,
      };
    }

    return data;
  }

  async function getAccount(number: number): Promise<Record<string, unknown>> {
    const data = await transport.request<AccountResponse>(`accounts/${number}`);
    return data.Account;
  }

  async function createAccount(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<AccountResponse>('accounts', {
      method: 'POST',
      body: { Account: fields },
    });
    return data.Account;
  }

  async function updateAccount(
    number: number,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { Number: _, ...body } = fields;
    const data = await transport.request<AccountResponse>(`accounts/${number}`, {
      method: 'PUT',
      body: { Account: body },
    });
    return data.Account;
  }

  async function deleteAccount(number: number): Promise<void> {
    await transport.request(`accounts/${number}`, { method: 'DELETE' });
  }

  return { listAccounts, getAccount, createAccount, updateAccount, deleteAccount };
}

export const { listAccounts, getAccount, createAccount, updateAccount, deleteAccount } =
  createAccountOperations(defaultFortnoxTransport);
