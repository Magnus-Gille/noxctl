import { fortnoxRequest } from '../fortnox-client.js';

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
}

export async function listSuppliers(params: ListSuppliersParams = {}): Promise<SuppliersResponse> {
  return fortnoxRequest<SuppliersResponse>('suppliers', {
    params: {
      page: params.page || 1,
      limit: params.limit || 100,
      ...(params.search ? { name: params.search } : {}),
    },
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
