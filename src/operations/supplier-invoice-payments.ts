import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface SupplierInvoicePaymentResponse {
  SupplierInvoicePayment: Record<string, unknown>;
}

export interface SupplierInvoicePaymentsResponse {
  SupplierInvoicePayments: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSupplierInvoicePaymentsParams {
  invoiceNumber?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createSupplierInvoicePaymentOperations(transport: FortnoxTransport) {
  async function listSupplierInvoicePayments(
    params: ListSupplierInvoicePaymentsParams = {},
  ): Promise<SupplierInvoicePaymentsResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      invoicenumber: params.invoiceNumber,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'supplierinvoicepayments',
        'SupplierInvoicePayments',
        queryParams,
      );
      return {
        SupplierInvoicePayments: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<SupplierInvoicePaymentsResponse>('supplierinvoicepayments', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getSupplierInvoicePayment(
    paymentNumber: string,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoicePaymentResponse>(
      `supplierinvoicepayments/${documentSegment(paymentNumber)}`,
    );
    return data.SupplierInvoicePayment;
  }

  async function createSupplierInvoicePayment(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoicePaymentResponse>(
      'supplierinvoicepayments',
      {
        method: 'POST',
        body: { SupplierInvoicePayment: params },
      },
    );
    return data.SupplierInvoicePayment;
  }

  async function deleteSupplierInvoicePayment(paymentNumber: string): Promise<void> {
    await transport.request(`supplierinvoicepayments/${documentSegment(paymentNumber)}`, {
      method: 'DELETE',
    });
  }

  return {
    listSupplierInvoicePayments,
    getSupplierInvoicePayment,
    createSupplierInvoicePayment,
    deleteSupplierInvoicePayment,
  };
}

export const {
  listSupplierInvoicePayments,
  getSupplierInvoicePayment,
  createSupplierInvoicePayment,
  deleteSupplierInvoicePayment,
} = createSupplierInvoicePaymentOperations(defaultFortnoxTransport);
