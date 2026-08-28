import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface SupplierResponse {
  Supplier: Record<string, unknown>;
}

export interface SuppliersResponse {
  Suppliers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSuppliersParams {
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createSupplierOperations(transport: FortnoxTransport) {
  async function listSuppliers(params: ListSuppliersParams = {}): Promise<SuppliersResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.search ? { name: params.search } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'suppliers',
        'Suppliers',
        queryParams,
      );
      return {
        Suppliers: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<SuppliersResponse>('suppliers', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getSupplier(supplierNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierResponse>(
      `suppliers/${encodeURIComponent(supplierNumber)}`,
    );
    return data.Supplier;
  }

  async function createSupplier(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierResponse>('suppliers', {
      method: 'POST',
      body: { Supplier: params },
    });
    return data.Supplier;
  }

  async function updateSupplier(
    supplierNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { SupplierNumber: _, ...body } = fields;
    const data = await transport.request<SupplierResponse>(
      `suppliers/${encodeURIComponent(supplierNumber)}`,
      {
        method: 'PUT',
        body: { Supplier: body },
      },
    );
    return data.Supplier;
  }

  return { listSuppliers, getSupplier, createSupplier, updateSupplier };
}

export const { listSuppliers, getSupplier, createSupplier, updateSupplier } =
  createSupplierOperations(defaultFortnoxTransport);
