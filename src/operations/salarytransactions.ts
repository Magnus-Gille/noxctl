import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface SalaryTransactionResponse {
  SalaryTransaction: Record<string, unknown>;
}

interface SalaryTransactionsResponse {
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

export async function listSalaryTransactions(
  params: ListSalaryTransactionsParams = {},
): Promise<SalaryTransactionsResponse> {
  const filters: Record<string, string> = {};
  if (params.employeeId !== undefined) filters.employeeId = params.employeeId;
  if (params.date !== undefined) filters.date = params.date;

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'salarytransactions',
      'SalaryTransactions',
      filters,
    );
    return {
      SalaryTransactions: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<SalaryTransactionsResponse>('salarytransactions', {
    params: { page: params.page || 1, limit: params.limit || 100, ...filters },
  });
}

export async function getSalaryTransaction(salaryRow: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SalaryTransactionResponse>(
    `salarytransactions/${encodeURIComponent(String(salaryRow))}`,
  );
  return data.SalaryTransaction;
}

export async function createSalaryTransaction(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SalaryTransactionResponse>('salarytransactions', {
    method: 'POST',
    body: { SalaryTransaction: params },
  });
  return data.SalaryTransaction;
}

export async function deleteSalaryTransaction(salaryRow: string): Promise<void> {
  await fortnoxRequest(`salarytransactions/${encodeURIComponent(String(salaryRow))}`, {
    method: 'DELETE',
  });
}
