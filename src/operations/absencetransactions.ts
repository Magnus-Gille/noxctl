import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface AbsenceTransactionResponse {
  AbsenceTransaction: Record<string, unknown>;
}

interface AbsenceTransactionsResponse {
  AbsenceTransactions: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListAbsenceTransactionsParams {
  employeeId?: string;
  date?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listAbsenceTransactions(
  params: ListAbsenceTransactionsParams = {},
): Promise<AbsenceTransactionsResponse> {
  // Note the lowercase query keys: Fortnox expects "employeeid" and "date".
  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'absencetransactions',
      'AbsenceTransactions',
      { employeeid: params.employeeId, date: params.date },
    );
    return {
      AbsenceTransactions: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<AbsenceTransactionsResponse>('absencetransactions', {
    params: {
      employeeid: params.employeeId,
      date: params.date,
      page: params.page || 1,
      limit: params.limit || 100,
    },
  });
}

export async function getAbsenceTransaction(id: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<AbsenceTransactionResponse>(
    `absencetransactions/${encodeURIComponent(id)}`,
  );
  return data.AbsenceTransaction;
}

export async function createAbsenceTransaction(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<AbsenceTransactionResponse>('absencetransactions', {
    method: 'POST',
    body: { AbsenceTransaction: params },
  });
  return data.AbsenceTransaction;
}

export async function deleteAbsenceTransaction(id: string): Promise<void> {
  await fortnoxRequest(`absencetransactions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
