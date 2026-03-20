import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface InvoicePaymentResponse {
  InvoicePayment: Record<string, unknown>;
}

interface InvoicePaymentsResponse {
  InvoicePayments: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListInvoicePaymentsParams {
  invoiceNumber?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listInvoicePayments(
  params: ListInvoicePaymentsParams = {},
): Promise<InvoicePaymentsResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    invoicenumber: params.invoiceNumber,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'invoicepayments',
      'InvoicePayments',
      queryParams,
    );
    return {
      InvoicePayments: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<InvoicePaymentsResponse>('invoicepayments', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getInvoicePayment(paymentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoicePaymentResponse>(
    `invoicepayments/${documentSegment(paymentNumber)}`,
  );
  return data.InvoicePayment;
}

export async function createInvoicePayment(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoicePaymentResponse>('invoicepayments', {
    method: 'POST',
    body: { InvoicePayment: params },
  });
  return data.InvoicePayment;
}

export async function deleteInvoicePayment(paymentNumber: string): Promise<void> {
  await fortnoxRequest(`invoicepayments/${documentSegment(paymentNumber)}`, {
    method: 'DELETE',
  });
}
