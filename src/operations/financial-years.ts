import { fortnoxRequest } from '../fortnox-client.js';

interface FinancialYearResponse {
  FinancialYear: Record<string, unknown>;
}

interface FinancialYearsResponse {
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

export async function listFinancialYears(
  params: ListFinancialYearsParams = {},
): Promise<FinancialYearsResponse> {
  return fortnoxRequest<FinancialYearsResponse>('financialyears', {
    params: { Date: params.date },
  });
}

export async function getFinancialYear(id: number): Promise<Record<string, unknown>> {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid financial year id: ${id}`);
  }
  const data = await fortnoxRequest<FinancialYearResponse>(`financialyears/${id}`);
  return data.FinancialYear;
}

// The locked period (bokföring låst t.o.m.). An empty object means no period
// is locked. Useful as context before voucher/invoice writes to avoid
// "period is locked" API errors.
export async function getLockedPeriod(): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<LockedPeriodResponse>('settings/lockedperiod');
  return data.LockedPeriod ?? {};
}
