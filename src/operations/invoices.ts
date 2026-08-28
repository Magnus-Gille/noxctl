import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface InvoiceResponse {
  Invoice: Record<string, unknown>;
}

export interface InvoicesResponse {
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

export type SendMethod = 'email' | 'print' | 'einvoice';

export interface SendEmailOptions {
  subject?: string;
  body?: string;
  bcc?: string;
}

export interface MarkInvoicePrintedResult {
  /** The invoice's state after printing. */
  invoice: Record<string, unknown>;
  /**
   * Whether that state was actually read back from Fortnox. When false, the
   * print request was accepted but its effect could not be confirmed — callers
   * must report the outcome as unknown rather than as sent.
   */
  confirmed: boolean;
  /**
   * The document Fortnox generated for this print action, when it came back
   * intact. Callers saving a copy should prefer these bytes over a separately
   * fetched /preview: the two are distinct requests, so a concurrent edit could
   * otherwise leave the saved file a version behind the one marked as sent.
   */
  pdf?: Buffer;
}

export function createInvoiceOperations(transport: FortnoxTransport) {
  async function listInvoices(params: ListInvoicesParams = {}): Promise<InvoicesResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      filter: params.filter,
      customernumber: params.customerNumber,
      fromdate: params.fromDate,
      todate: params.toDate,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'invoices',
        'Invoices',
        queryParams,
      );
      return {
        Invoices: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<InvoicesResponse>('invoices', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getInvoice(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoiceResponse>(
      `invoices/${documentSegment(documentNumber)}`,
    );
    return data.Invoice;
  }

  async function createInvoice(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoiceResponse>('invoices', {
      method: 'POST',
      body: { Invoice: params },
    });
    return data.Invoice;
  }

  async function updateInvoice(
    documentNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { documentNumber: _, ...body } = fields;
    const data = await transport.request<InvoiceResponse>(
      `invoices/${documentSegment(documentNumber)}`,
      {
        method: 'PUT',
        body: { Invoice: body },
      },
    );
    return data.Invoice;
  }

  async function sendInvoice(
    documentNumber: string,
    method: SendMethod = 'email',
    emailOptions?: SendEmailOptions,
  ): Promise<Record<string, unknown>> {
    const documentId = documentSegment(documentNumber);

    // Update EmailInformation before sending if any email options are provided
    if (emailOptions && (emailOptions.subject || emailOptions.body || emailOptions.bcc)) {
      const current = await transport.request<InvoiceResponse>(`invoices/${documentId}`);
      const existing = (current.Invoice?.EmailInformation as Record<string, unknown>) || {};
      const emailInfo: Record<string, unknown> = { ...existing };
      if (emailOptions.subject) emailInfo.EmailSubject = emailOptions.subject;
      if (emailOptions.body) emailInfo.EmailBody = emailOptions.body;
      if (emailOptions.bcc) emailInfo.EmailAddressBCC = emailOptions.bcc;
      await transport.request<InvoiceResponse>(`invoices/${documentId}`, {
        method: 'PUT',
        body: { Invoice: { EmailInformation: emailInfo } },
      });
    }

    if (method === 'print') {
      return (await markInvoicePrinted(documentNumber)).invoice;
    }

    // Exhaustive on purpose: no silent fallback. 'email' and 'einvoice' both send
    // the invoice to the customer, so an unrecognised method must fail loudly
    // rather than pick one of them.
    if (method !== 'email' && method !== 'einvoice') {
      throw new Error(`Unsupported send method: ${String(method)}`);
    }

    const data = await transport.request<InvoiceResponse>(`invoices/${documentId}/${method}`, {
      // Fortnox models these delivery actions as GET, but they send an invoice
      // to a customer. Never retry them automatically after an ambiguous error.
      mutation: true,
    });
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
  async function getInvoicePdf(documentNumber: string): Promise<Buffer> {
    return transport.requestPdf(`invoices/${documentSegment(documentNumber)}/preview`);
  }

  /**
   * Mark an invoice as sent via Fortnox's /print action, and report its resulting
   * state. /print is a GET that changes data, so it is flagged as a mutation to
   * keep it out of the automatic retry path.
   *
   * Once the /print request succeeds the invoice has been changed, so from that
   * point on this function does not throw: neither a malformed PDF body nor a
   * failed read-back may turn a completed accounting change into a reported
   * failure.
   */
  async function markInvoicePrinted(documentNumber: string): Promise<MarkInvoicePrintedResult> {
    const documentId = documentSegment(documentNumber);

    const pdf = await transport.requestPdfFromMutation(`invoices/${documentId}/print`);

    try {
      return { invoice: await getInvoice(documentNumber), confirmed: true, pdf };
    } catch (err) {
      // Fortnox accepted the print request, so the change has most likely been
      // applied — but "most likely" is not "confirmed". Deliberately no
      // `Sent: true` here: synthesizing it would present an unverified outcome as
      // established fact about someone's accounting records.
      return {
        invoice: {
          DocumentNumber: documentNumber,
          Note: `Fortnox accepted the print request, but reading the invoice back failed, so its sent status could not be confirmed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        confirmed: false,
        pdf,
      };
    }
  }

  async function bookkeepInvoice(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoiceResponse>(
      `invoices/${documentSegment(documentNumber)}/bookkeep`,
      {
        method: 'PUT',
      },
    );
    return data?.Invoice || {};
  }

  async function creditInvoice(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoiceResponse>(
      `invoices/${documentSegment(documentNumber)}/credit`,
      {
        method: 'PUT',
      },
    );
    return data?.Invoice || {};
  }

  return {
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    sendInvoice,
    getInvoicePdf,
    markInvoicePrinted,
    bookkeepInvoice,
    creditInvoice,
  };
}

export const {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  sendInvoice,
  getInvoicePdf,
  markInvoicePrinted,
  bookkeepInvoice,
  creditInvoice,
} = createInvoiceOperations(defaultFortnoxTransport);
