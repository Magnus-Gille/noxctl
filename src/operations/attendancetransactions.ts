import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface AttendanceTransactionResponse {
  AttendanceTransaction: Record<string, unknown>;
}

export interface AttendanceTransactionsResponse {
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

export function createAttendanceTransactionOperations(transport: FortnoxTransport) {
  async function listAttendanceTransactions(
    params: ListAttendanceTransactionsParams = {},
  ): Promise<AttendanceTransactionsResponse> {
    if (params.all) {
      // The Fortnox attendance list endpoint names its filter params "employeeid"
      // (all lowercase) and "date" — the filters must survive pagination, so pass
      // them through to fetchAllPages too (not just the single-page branch below).
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
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
    return transport.request<AttendanceTransactionsResponse>('attendancetransactions', {
      params: {
        employeeid: params.employeeId,
        date: params.date,
        page: params.page || 1,
        limit: params.limit || 100,
      },
    });
  }

  async function getAttendanceTransaction(id: string): Promise<Record<string, unknown>> {
    const data = await transport.request<AttendanceTransactionResponse>(
      `attendancetransactions/${encodeURIComponent(id)}`,
    );
    return data.AttendanceTransaction;
  }

  async function getAttendanceTransactionByDateCode(
    id: string,
    date: string,
    code: string,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AttendanceTransactionResponse>(
      `attendancetransactions/${encodeURIComponent(id)}/${encodeURIComponent(date)}/${encodeURIComponent(code)}`,
    );
    return data.AttendanceTransaction;
  }

  async function createAttendanceTransaction(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AttendanceTransactionResponse>('attendancetransactions', {
      method: 'POST',
      body: { AttendanceTransaction: params },
    });
    return data.AttendanceTransaction;
  }

  async function deleteAttendanceTransaction(id: string): Promise<void> {
    await transport.request(`attendancetransactions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async function updateAttendanceTransaction(
    id: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AttendanceTransactionResponse>(
      `attendancetransactions/${encodeURIComponent(id)}`,
      { method: 'PUT', body: { AttendanceTransaction: params } },
    );
    return data.AttendanceTransaction;
  }

  return {
    listAttendanceTransactions,
    getAttendanceTransaction,
    getAttendanceTransactionByDateCode,
    createAttendanceTransaction,
    updateAttendanceTransaction,
    deleteAttendanceTransaction,
  };
}

export const {
  listAttendanceTransactions,
  getAttendanceTransaction,
  getAttendanceTransactionByDateCode,
  createAttendanceTransaction,
  updateAttendanceTransaction,
  deleteAttendanceTransaction,
} = createAttendanceTransactionOperations(defaultFortnoxTransport);
