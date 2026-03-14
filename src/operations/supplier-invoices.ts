import { fortnoxRequest } from '../fortnox-client.js';

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
}

export async function listSupplierInvoices(
  params: ListSupplierInvoicesParams = {},
): Promise<SupplierInvoicesResponse> {
  const subpath = params.filter ? `?filter=${encodeURIComponent(params.filter)}` : '';
  return fortnoxRequest<SupplierInvoicesResponse>(`supplierinvoices${subpath}`, {
    params: {
      page: params.page || 1,
      limit: params.limit || 100,
      ...(params.supplierNumber ? { suppliernumber: params.supplierNumber } : {}),
      ...(params.fromDate ? { fromdate: params.fromDate } : {}),
      ...(params.toDate ? { todate: params.toDate } : {}),
    },
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
