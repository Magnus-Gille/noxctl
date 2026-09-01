import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface SalaryTransactionResponse {
  SalaryTransaction: Record<string, unknown>;
}

export interface SalaryTransactionsResponse {
  SalaryTransactions: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSalaryTransactionsParams {
  employeeId?: string;
  date?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createSalaryTransactionOperations(transport: FortnoxTransport) {
  async function listSalaryTransactions(
    params: ListSalaryTransactionsParams = {},
  ): Promise<SalaryTransactionsResponse> {
    const filters: Record<string, string> = {};
    if (params.employeeId !== undefined) filters.employeeId = params.employeeId;
    if (params.date !== undefined) filters.date = params.date;

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'salarytransactions',
        'SalaryTransactions',
        filters,
      );
      return {
        SalaryTransactions: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<SalaryTransactionsResponse>('salarytransactions', {
      params: { page: params.page || 1, limit: params.limit || 100, ...filters },
    });
  }

  async function getSalaryTransaction(salaryRow: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SalaryTransactionResponse>(
      `salarytransactions/${encodeURIComponent(String(salaryRow))}`,
    );
    return data.SalaryTransaction;
  }

  async function createSalaryTransaction(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SalaryTransactionResponse>('salarytransactions', {
      method: 'POST',
      body: { SalaryTransaction: params },
    });
    return data.SalaryTransaction;
  }

  async function deleteSalaryTransaction(salaryRow: string): Promise<void> {
    await transport.request(`salarytransactions/${encodeURIComponent(String(salaryRow))}`, {
      method: 'DELETE',
    });
  }

  async function updateSalaryTransaction(
    salaryRow: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SalaryTransactionResponse>(
      `salarytransactions/${encodeURIComponent(String(salaryRow))}`,
      { method: 'PUT', body: { SalaryTransaction: params } },
    );
    return data.SalaryTransaction;
  }

  return {
    listSalaryTransactions,
    getSalaryTransaction,
    createSalaryTransaction,
    updateSalaryTransaction,
    deleteSalaryTransaction,
  };
}

export const {
  listSalaryTransactions,
  getSalaryTransaction,
  createSalaryTransaction,
  updateSalaryTransaction,
  deleteSalaryTransaction,
} = createSalaryTransactionOperations(defaultFortnoxTransport);
