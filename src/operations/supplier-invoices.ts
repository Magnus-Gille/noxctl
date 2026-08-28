import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface SupplierInvoiceResponse {
  SupplierInvoice: Record<string, unknown>;
}

export interface SupplierInvoicesResponse {
  SupplierInvoices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSupplierInvoicesParams {
  filter?: string;
  supplierNumber?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createSupplierInvoiceOperations(transport: FortnoxTransport) {
  async function listSupplierInvoices(
    params: ListSupplierInvoicesParams = {},
  ): Promise<SupplierInvoicesResponse> {
    const subpath = params.filter ? `?filter=${encodeURIComponent(params.filter)}` : '';
    const endpoint = `supplierinvoices${subpath}`;
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.supplierNumber ? { suppliernumber: params.supplierNumber } : {}),
      ...(params.fromDate ? { fromdate: params.fromDate } : {}),
      ...(params.toDate ? { todate: params.toDate } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        endpoint,
        'SupplierInvoices',
        queryParams,
      );
      return {
        SupplierInvoices: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<SupplierInvoicesResponse>(endpoint, {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getSupplierInvoice(givenNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>(
      `supplierinvoices/${encodeURIComponent(givenNumber)}`,
    );
    return data.SupplierInvoice;
  }

  async function createSupplierInvoice(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>('supplierinvoices', {
      method: 'POST',
      body: { SupplierInvoice: params },
    });
    return data.SupplierInvoice;
  }

  async function bookkeepSupplierInvoice(givenNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>(
      `supplierinvoices/${encodeURIComponent(givenNumber)}/bookkeep`,
      { method: 'PUT' },
    );
    return data.SupplierInvoice;
  }

  return {
    listSupplierInvoices,
    getSupplierInvoice,
    createSupplierInvoice,
    bookkeepSupplierInvoice,
  };
}

export const {
  listSupplierInvoices,
  getSupplierInvoice,
  createSupplierInvoice,
  bookkeepSupplierInvoice,
} = createSupplierInvoiceOperations(defaultFortnoxTransport);
