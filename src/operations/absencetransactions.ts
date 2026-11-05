import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { pathSegment } from '../identifiers.js';

interface AbsenceTransactionResponse {
  AbsenceTransaction: Record<string, unknown>;
}

export interface AbsenceTransactionsResponse {
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

export function createAbsenceTransactionOperations(transport: FortnoxTransport) {
  async function listAbsenceTransactions(
    params: ListAbsenceTransactionsParams = {},
  ): Promise<AbsenceTransactionsResponse> {
    // Note the lowercase query keys: Fortnox expects "employeeid" and "date".
    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'absencetransactions',
        'AbsenceTransactions',
        { employeeid: params.employeeId, date: params.date },
      );
      return {
        AbsenceTransactions: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<AbsenceTransactionsResponse>('absencetransactions', {
      params: {
        employeeid: params.employeeId,
        date: params.date,
        page: params.page || 1,
        limit: params.limit || 100,
      },
    });
  }

  async function getAbsenceTransaction(id: string): Promise<Record<string, unknown>> {
    const data = await transport.request<AbsenceTransactionResponse>(
      `absencetransactions/${pathSegment('absence transaction id', id)}`,
    );
    return data.AbsenceTransaction;
  }

  async function getAbsenceTransactionByDateCode(
    id: string,
    date: string,
    code: string,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AbsenceTransactionResponse>(
      `absencetransactions/${pathSegment('absence transaction id', id)}/${pathSegment('date', date)}/${pathSegment('absence code', code)}`,
    );
    return data.AbsenceTransaction;
  }

  async function createAbsenceTransaction(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AbsenceTransactionResponse>('absencetransactions', {
      method: 'POST',
      body: { AbsenceTransaction: params },
    });
    return data.AbsenceTransaction;
  }

  async function deleteAbsenceTransaction(id: string): Promise<void> {
    await transport.request(`absencetransactions/${pathSegment('absence transaction id', id)}`, {
      method: 'DELETE',
    });
  }

  async function updateAbsenceTransaction(
    id: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<AbsenceTransactionResponse>(
      `absencetransactions/${pathSegment('absence transaction id', id)}`,
      { method: 'PUT', body: { AbsenceTransaction: params } },
    );
    return data.AbsenceTransaction;
  }

  return {
    listAbsenceTransactions,
    getAbsenceTransaction,
    getAbsenceTransactionByDateCode,
    createAbsenceTransaction,
    updateAbsenceTransaction,
    deleteAbsenceTransaction,
  };
}

export const {
  listAbsenceTransactions,
  getAbsenceTransaction,
  getAbsenceTransactionByDateCode,
  createAbsenceTransaction,
  updateAbsenceTransaction,
  deleteAbsenceTransaction,
} = createAbsenceTransactionOperations(defaultFortnoxTransport);
