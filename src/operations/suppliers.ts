import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface SupplierResponse {
  Supplier: Record<string, unknown>;
}

interface SuppliersResponse {
  Suppliers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSuppliersParams {
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listSuppliers(params: ListSuppliersParams = {}): Promise<SuppliersResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    ...(params.search ? { name: params.search } : {}),
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'suppliers',
      'Suppliers',
      queryParams,
    );
    return {
      Suppliers: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<SuppliersResponse>('suppliers', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getSupplier(supplierNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierResponse>(
    `suppliers/${encodeURIComponent(supplierNumber)}`,
  );
  return data.Supplier;
}

export async function createSupplier(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierResponse>('suppliers', {
    method: 'POST',
    body: { Supplier: params },
  });
  return data.Supplier;
}

export async function updateSupplier(
  supplierNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { SupplierNumber: _, ...body } = fields;
  const data = await fortnoxRequest<SupplierResponse>(
    `suppliers/${encodeURIComponent(supplierNumber)}`,
    {
      method: 'PUT',
      body: { Supplier: body },
    },
  );
  return data.Supplier;
}
