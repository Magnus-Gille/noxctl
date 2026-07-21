import { fortnoxRequest, fortnoxRequestBinary, fetchAllPages } from '../fortnox-client.js';
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
  all?: boolean;
}

export async function listInvoices(params: ListInvoicesParams = {}): Promise<InvoicesResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    filter: params.filter,
    customernumber: params.customerNumber,
    fromdate: params.fromDate,
    todate: params.toDate,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'invoices',
      'Invoices',
      queryParams,
    );
    return {
      Invoices: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<InvoicesResponse>('invoices', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
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

export interface SendEmailOptions {
  subject?: string;
  body?: string;
  bcc?: string;
}

export async function sendInvoice(
  documentNumber: string,
  method: SendMethod = 'email',
  emailOptions?: SendEmailOptions,
): Promise<Record<string, unknown>> {
  const documentId = documentSegment(documentNumber);

  // Update EmailInformation before sending if any email options are provided
  if (emailOptions && (emailOptions.subject || emailOptions.body || emailOptions.bcc)) {
    const current = await fortnoxRequest<InvoiceResponse>(`invoices/${documentId}`);
    const existing = (current.Invoice?.EmailInformation as Record<string, unknown>) || {};
    const emailInfo: Record<string, unknown> = { ...existing };
    if (emailOptions.subject) emailInfo.EmailSubject = emailOptions.subject;
    if (emailOptions.body) emailInfo.EmailBody = emailOptions.body;
    if (emailOptions.bcc) emailInfo.EmailAddressBCC = emailOptions.bcc;
    await fortnoxRequest<InvoiceResponse>(`invoices/${documentId}`, {
      method: 'PUT',
      body: { Invoice: { EmailInformation: emailInfo } },
    });
  }

  if (method === 'print') {
    // /print answers with the PDF itself rather than JSON, so it cannot go
    // through fortnoxRequest. The bytes are discarded here — this action means
    // "mark as printed"; use getInvoicePdf to keep the file — and the invoice is
    // re-read so the caller sees its real post-print state (Sent = true).
    await fortnoxRequestBinary(`invoices/${documentId}/print`);
    return getInvoice(documentNumber);
  }

  const endpointSuffix = method === 'einvoice' ? 'einvoice' : 'email';
  const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentId}/${endpointSuffix}`);
  return data?.Invoice || {};
}

export interface InvoicePdfOptions {
  /**
   * Use /print instead of /preview. Both return the same PDF, but /print also
   * sets the invoice's `Sent` flag — a side effect you rarely want when you are
   * just downloading a copy to attach to an email.
   */
  markSent?: boolean;
}

export async function getInvoicePdf(
  documentNumber: string,
  options: InvoicePdfOptions = {},
): Promise<Buffer> {
  const action = options.markSent ? 'print' : 'preview';
  return fortnoxRequestBinary(`invoices/${documentSegment(documentNumber)}/${action}`);
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
