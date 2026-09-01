import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface TaxReductionResponse {
  TaxReduction: Record<string, unknown>;
}

export interface TaxReductionsResponse {
  TaxReductions: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListTaxReductionsParams {
  filter?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createTaxReductionOperations(transport: FortnoxTransport) {
  async function listTaxReductions(
    params: ListTaxReductionsParams = {},
  ): Promise<TaxReductionsResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.filter ? { filter: params.filter } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'taxreductions',
        'TaxReductions',
        queryParams,
      );
      return {
        TaxReductions: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<TaxReductionsResponse>('taxreductions', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getTaxReduction(id: number): Promise<Record<string, unknown>> {
    const data = await transport.request<TaxReductionResponse>(`taxreductions/${id}`);
    return data.TaxReduction;
  }

  async function createTaxReduction(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<TaxReductionResponse>('taxreductions', {
      method: 'POST',
      body: { TaxReduction: params },
    });
    return data.TaxReduction;
  }

  async function updateTaxReduction(
    id: number,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<TaxReductionResponse>(`taxreductions/${id}`, {
      method: 'PUT',
      body: { TaxReduction: params },
    });
    return data.TaxReduction;
  }

  async function deleteTaxReduction(id: number): Promise<void> {
    await transport.request(`taxreductions/${id}`, { method: 'DELETE' });
  }

  return {
    listTaxReductions,
    getTaxReduction,
    createTaxReduction,
    updateTaxReduction,
    deleteTaxReduction,
  };
}

export const {
  listTaxReductions,
  getTaxReduction,
  createTaxReduction,
  updateTaxReduction,
  deleteTaxReduction,
} = createTaxReductionOperations(defaultFortnoxTransport);
