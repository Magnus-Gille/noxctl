import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface SupplierInvoicePaymentResponse {
  SupplierInvoicePayment: Record<string, unknown>;
}

interface SupplierInvoicePaymentsResponse {
  SupplierInvoicePayments: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSupplierInvoicePaymentsParams {
  invoiceNumber?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listSupplierInvoicePayments(
  params: ListSupplierInvoicePaymentsParams = {},
): Promise<SupplierInvoicePaymentsResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    invoicenumber: params.invoiceNumber,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'supplierinvoicepayments',
      'SupplierInvoicePayments',
      queryParams,
    );
    return {
      SupplierInvoicePayments: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<SupplierInvoicePaymentsResponse>('supplierinvoicepayments', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getSupplierInvoicePayment(
  paymentNumber: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierInvoicePaymentResponse>(
    `supplierinvoicepayments/${documentSegment(paymentNumber)}`,
  );
  return data.SupplierInvoicePayment;
}

export async function createSupplierInvoicePayment(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<SupplierInvoicePaymentResponse>('supplierinvoicepayments', {
    method: 'POST',
    body: { SupplierInvoicePayment: params },
  });
  return data.SupplierInvoicePayment;
}

export async function deleteSupplierInvoicePayment(paymentNumber: string): Promise<void> {
  await fortnoxRequest(`supplierinvoicepayments/${documentSegment(paymentNumber)}`, {
    method: 'DELETE',
  });
}
