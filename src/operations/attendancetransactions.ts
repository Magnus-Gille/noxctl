import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface AttendanceTransactionResponse {
  AttendanceTransaction: Record<string, unknown>;
}

interface AttendanceTransactionsResponse {
  AttendanceTransactions: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListAttendanceTransactionsParams {
  employeeId?: string;
  date?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listAttendanceTransactions(
  params: ListAttendanceTransactionsParams = {},
): Promise<AttendanceTransactionsResponse> {
  if (params.all) {
    // The Fortnox attendance list endpoint names its filter params "employeeid"
    // (all lowercase) and "date" — the filters must survive pagination, so pass
    // them through to fetchAllPages too (not just the single-page branch below).
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'attendancetransactions',
      'AttendanceTransactions',
      { employeeid: params.employeeId, date: params.date },
    );
    return {
      AttendanceTransactions: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  // The Fortnox attendance list endpoint names its filter params "employeeid"
  // (all lowercase) and "date" — map employeeId onto the lowercase key.
  return fortnoxRequest<AttendanceTransactionsResponse>('attendancetransactions', {
    params: {
      employeeid: params.employeeId,
      date: params.date,
      page: params.page || 1,
      limit: params.limit || 100,
    },
  });
}

export async function getAttendanceTransaction(id: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<AttendanceTransactionResponse>(
    `attendancetransactions/${encodeURIComponent(id)}`,
  );
  return data.AttendanceTransaction;
}

export async function createAttendanceTransaction(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<AttendanceTransactionResponse>('attendancetransactions', {
    method: 'POST',
    body: { AttendanceTransaction: params },
  });
  return data.AttendanceTransaction;
}

export async function deleteAttendanceTransaction(id: string): Promise<void> {
  await fortnoxRequest(`attendancetransactions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
