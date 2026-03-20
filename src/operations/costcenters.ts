import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface CostCenterResponse {
  CostCenter: Record<string, unknown>;
}

interface CostCentersResponse {
  CostCenters: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListCostCentersParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listCostCenters(
  params: ListCostCentersParams = {},
): Promise<CostCentersResponse> {
  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'costcenters',
      'CostCenters',
    );
    return {
      CostCenters: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<CostCentersResponse>('costcenters', {
    params: { page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getCostCenter(code: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CostCenterResponse>(`costcenters/${encodeURIComponent(code)}`);
  return data.CostCenter;
}

export async function createCostCenter(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CostCenterResponse>('costcenters', {
    method: 'POST',
    body: { CostCenter: params },
  });
  return data.CostCenter;
}

export async function updateCostCenter(
  code: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { Code: _, ...body } = fields;
  const data = await fortnoxRequest<CostCenterResponse>(`costcenters/${encodeURIComponent(code)}`, {
    method: 'PUT',
    body: { CostCenter: body },
  });
  return data.CostCenter;
}

export async function deleteCostCenter(code: string): Promise<void> {
  await fortnoxRequest(`costcenters/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}
