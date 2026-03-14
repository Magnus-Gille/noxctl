import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface SupplierInvoiceResponse {
  SupplierInvoice: Record<string, unknown>;
}

interface SupplierInvoicesResponse {
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

export async function listSupplierInvoices(
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
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      endpoint,
      'SupplierInvoices',
      queryParams,
    );
    return {
      SupplierInvoices: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<SupplierInvoicesResponse>(endpoint, {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getSupplierInvoice(givenNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierInvoiceResponse>(
    `supplierinvoices/${encodeURIComponent(givenNumber)}`,
  );
  return data.SupplierInvoice;
}

export async function createSupplierInvoice(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierInvoiceResponse>('supplierinvoices', {
    method: 'POST',
    body: { SupplierInvoice: params },
  });
  return data.SupplierInvoice;
}

export async function bookkeepSupplierInvoice(
  givenNumber: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierInvoiceResponse>(
    `supplierinvoices/${encodeURIComponent(givenNumber)}/bookkeep`,
    { method: 'PUT' },
  );
  return data.SupplierInvoice;
}
