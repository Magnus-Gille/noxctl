import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface TaxReductionResponse {
  TaxReduction: Record<string, unknown>;
}

interface TaxReductionsResponse {
  TaxReductions: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListTaxReductionsParams {
  filter?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listTaxReductions(
  params: ListTaxReductionsParams = {},
): Promise<TaxReductionsResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    ...(params.filter ? { filter: params.filter } : {}),
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'taxreductions',
      'TaxReductions',
      queryParams,
    );
    return {
      TaxReductions: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<TaxReductionsResponse>('taxreductions', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getTaxReduction(id: number): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<TaxReductionResponse>(`taxreductions/${id}`);
  return data.TaxReduction;
}

export async function createTaxReduction(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<TaxReductionResponse>('taxreductions', {
    method: 'POST',
    body: { TaxReduction: params },
  });
  return data.TaxReduction;
}
