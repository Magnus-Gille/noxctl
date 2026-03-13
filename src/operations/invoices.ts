import { fortnoxRequest } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface InvoiceResponse {
  Invoice: Record<string, unknown>;
}

interface InvoicesResponse {
  Invoices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListInvoicesParams {
  filter?: string;
  customerNumber?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export async function listInvoices(params: ListInvoicesParams = {}): Promise<InvoicesResponse> {
  return fortnoxRequest<InvoicesResponse>('invoices', {
    params: {
      filter: params.filter,
      customernumber: params.customerNumber,
      fromdate: params.fromDate,
      todate: params.toDate,
      page: params.page || 1,
      limit: params.limit || 100,
    },
  });
}

export async function getInvoice(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentSegment(documentNumber)}`);
  return data.Invoice;
}

export async function createInvoice(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoiceResponse>('invoices', {
    method: 'POST',
    body: { Invoice: params },
  });
  return data.Invoice;
}

export async function updateInvoice(
  documentNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { documentNumber: _, ...body } = fields;
  const data = await fortnoxRequest<InvoiceResponse>(
    `invoices/${documentSegment(documentNumber)}`,
    {
      method: 'PUT',
      body: { Invoice: body },
    },
  );
  return data.Invoice;
}

export type SendMethod = 'email' | 'print' | 'einvoice';

export async function sendInvoice(
  documentNumber: string,
  method: SendMethod = 'email',
): Promise<Record<string, unknown>> {
  const documentId = documentSegment(documentNumber);
  const endpointSuffix =
    method === 'email' ? 'email' : method === 'einvoice' ? 'einvoice' : 'print';
  const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentId}/${endpointSuffix}`, {
    method: 'PUT',
  });
  return data?.Invoice || {};
}

export async function bookkeepInvoice(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoiceResponse>(
    `invoices/${documentSegment(documentNumber)}/bookkeep`,
    {
      method: 'PUT',
    },
  );
  return data?.Invoice || {};
}

export async function creditInvoice(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoiceResponse>(
    `invoices/${documentSegment(documentNumber)}/credit`,
    {
      method: 'PUT',
    },
  );
  return data?.Invoice || {};
}
