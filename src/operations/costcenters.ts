import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface CostCenterResponse {
  CostCenter: Record<string, unknown>;
}

export interface CostCentersResponse {
  CostCenters: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListCostCentersParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createCostCenterOperations(transport: FortnoxTransport) {
  async function listCostCenters(params: ListCostCentersParams = {}): Promise<CostCentersResponse> {
    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'costcenters',
        'CostCenters',
      );
      return {
        CostCenters: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<CostCentersResponse>('costcenters', {
      params: { page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getCostCenter(code: string): Promise<Record<string, unknown>> {
    const data = await transport.request<CostCenterResponse>(
      `costcenters/${encodeURIComponent(code)}`,
    );
    return data.CostCenter;
  }

  async function createCostCenter(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<CostCenterResponse>('costcenters', {
      method: 'POST',
      body: { CostCenter: params },
    });
    return data.CostCenter;
  }

  async function updateCostCenter(
    code: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { Code: _, ...body } = fields;
    const data = await transport.request<CostCenterResponse>(
      `costcenters/${encodeURIComponent(code)}`,
      {
        method: 'PUT',
        body: { CostCenter: body },
      },
    );
    return data.CostCenter;
  }

  async function deleteCostCenter(code: string): Promise<void> {
    await transport.request(`costcenters/${encodeURIComponent(code)}`, {
      method: 'DELETE',
    });
  }

  return { listCostCenters, getCostCenter, createCostCenter, updateCostCenter, deleteCostCenter };
}

export const {
  listCostCenters,
  getCostCenter,
  createCostCenter,
  updateCostCenter,
  deleteCostCenter,
} = createCostCenterOperations(defaultFortnoxTransport);
