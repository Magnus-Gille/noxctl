import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface FinancialYearResponse {
  FinancialYear: Record<string, unknown>;
}

export interface FinancialYearsResponse {
  FinancialYears: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

interface LockedPeriodResponse {
  LockedPeriod: Record<string, unknown>;
}

export interface ListFinancialYearsParams {
  // Filter to the financial year containing this date (YYYY-MM-DD).
  date?: string;
}

export function createFinancialYearOperations(transport: FortnoxTransport) {
  async function listFinancialYears(
    params: ListFinancialYearsParams = {},
  ): Promise<FinancialYearsResponse> {
    // Fortnox's /3/financialyears does NOT support a date query filter — passing
    // ?Date=... returns 400 "Ogiltig parameter" (error 2000588). So fetch all
    // years and, when a date is given, filter locally to the year whose
    // From/To-date range brackets it (YYYY-MM-DD compares lexicographically).
    const data = await transport.request<FinancialYearsResponse>('financialyears');
    if (!params.date) return data;
    const d = params.date;
    const matching = (data.FinancialYears ?? []).filter((fy) => {
      const from = String(fy.FromDate ?? '');
      const to = String(fy.ToDate ?? '');
      return from !== '' && to !== '' && from <= d && d <= to;
    });
    return { ...data, FinancialYears: matching };
  }

  async function getFinancialYear(id: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`Invalid financial year id: ${id}`);
    }
    const data = await transport.request<FinancialYearResponse>(`financialyears/${id}`);
    return data.FinancialYear;
  }

  async function createFinancialYear(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<FinancialYearResponse>('financialyears', {
      method: 'POST',
      body: { FinancialYear: params },
    });
    return data.FinancialYear;
  }

  // The locked period (bokföring låst t.o.m.). An empty object means no period
  // is locked. Useful as context before voucher/invoice writes to avoid
  // "period is locked" API errors.
  async function getLockedPeriod(): Promise<Record<string, unknown>> {
    const data = await transport.request<LockedPeriodResponse>('settings/lockedperiod');
    return data.LockedPeriod ?? {};
  }

  return { listFinancialYears, getFinancialYear, createFinancialYear, getLockedPeriod };
}

export const { listFinancialYears, getFinancialYear, createFinancialYear, getLockedPeriod } =
  createFinancialYearOperations(defaultFortnoxTransport);
