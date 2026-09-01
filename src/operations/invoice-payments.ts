import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface InvoicePaymentResponse {
  InvoicePayment: Record<string, unknown>;
}

export interface InvoicePaymentsResponse {
  InvoicePayments: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListInvoicePaymentsParams {
  invoiceNumber?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createInvoicePaymentOperations(transport: FortnoxTransport) {
  async function listInvoicePayments(
    params: ListInvoicePaymentsParams = {},
  ): Promise<InvoicePaymentsResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      invoicenumber: params.invoiceNumber,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'invoicepayments',
        'InvoicePayments',
        queryParams,
      );
      return {
        InvoicePayments: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<InvoicePaymentsResponse>('invoicepayments', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getInvoicePayment(paymentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoicePaymentResponse>(
      `invoicepayments/${documentSegment(paymentNumber)}`,
    );
    return data.InvoicePayment;
  }

  async function createInvoicePayment(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoicePaymentResponse>('invoicepayments', {
      method: 'POST',
      body: { InvoicePayment: params },
    });
    return data.InvoicePayment;
  }

  async function deleteInvoicePayment(paymentNumber: string): Promise<void> {
    await transport.request(`invoicepayments/${documentSegment(paymentNumber)}`, {
      method: 'DELETE',
    });
  }

  async function updateInvoicePayment(
    paymentNumber: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoicePaymentResponse>(
      `invoicepayments/${documentSegment(paymentNumber)}`,
      { method: 'PUT', body: { InvoicePayment: params } },
    );
    return data.InvoicePayment;
  }

  async function bookkeepInvoicePayment(paymentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoicePaymentResponse>(
      `invoicepayments/${documentSegment(paymentNumber)}/bookkeep`,
      {
        method: 'PUT',
      },
    );
    return data?.InvoicePayment || {};
  }

  return {
    listInvoicePayments,
    getInvoicePayment,
    createInvoicePayment,
    updateInvoicePayment,
    deleteInvoicePayment,
    bookkeepInvoicePayment,
  };
}

export const {
  listInvoicePayments,
  getInvoicePayment,
  createInvoicePayment,
  updateInvoicePayment,
  deleteInvoicePayment,
  bookkeepInvoicePayment,
} = createInvoicePaymentOperations(defaultFortnoxTransport);
