import { fortnoxRequest, fortnoxRequestPdf, fetchAllPages } from '../fortnox-client.js';
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
    return markInvoicePrinted(documentNumber);
  }

  // Exhaustive on purpose: no silent fallback. 'email' and 'einvoice' both send
  // the invoice to the customer, so an unrecognised method must fail loudly
  // rather than pick one of them.
  if (method !== 'email' && method !== 'einvoice') {
    throw new Error(`Unsupported send method: ${String(method)}`);
  }

  const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentId}/${method}`);
  return data?.Invoice || {};
}

/**
 * Fetch an invoice as a PDF. Always uses /preview, which returns the same
 * document as /print but leaves the invoice untouched.
 *
 * Marking the invoice as sent is deliberately NOT folded in here: callers that
 * want both run this first, write the bytes out, and only then call
 * `markInvoicePrinted`. Doing it the other way round means a full disk or a bad
 * path leaves an invoice flagged as sent with no PDF to show for it.
 */
export async function getInvoicePdf(documentNumber: string): Promise<Buffer> {
  return fortnoxRequestPdf(`invoices/${documentSegment(documentNumber)}/preview`);
}

/**
 * Mark an invoice as sent via Fortnox's /print action, and report its resulting
 * state. /print is a GET that changes data, so it is flagged as a mutation to
 * keep it out of the automatic retry path.
 */
export async function markInvoicePrinted(documentNumber: string): Promise<Record<string, unknown>> {
  const documentId = documentSegment(documentNumber);

  // The response body is the PDF, not JSON. It is discarded here — this action
  // means "mark as printed"; use getInvoicePdf to keep the file.
  await fortnoxRequestPdf(`invoices/${documentId}/print`, { mutation: true });

  try {
    return await getInvoice(documentNumber);
  } catch (err) {
    // Fortnox has already flagged the invoice; only reading it back failed.
    // Report the action as the success it was, but keep the read error visible
    // rather than pretending nothing went wrong.
    return {
      DocumentNumber: documentNumber,
      Sent: true,
      Note: `Invoice was marked as sent, but reading it back failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
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
