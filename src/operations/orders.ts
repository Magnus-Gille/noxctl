import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface OrderResponse {
  Order: Record<string, unknown>;
}

export interface OrdersResponse {
  Orders: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListOrdersParams {
  filter?: string;
  customerNumber?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createOrderOperations(transport: FortnoxTransport) {
  async function listOrders(params: ListOrdersParams = {}): Promise<OrdersResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      filter: params.filter,
      customernumber: params.customerNumber,
      fromdate: params.fromDate,
      todate: params.toDate,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'orders',
        'Orders',
        queryParams,
      );
      return {
        Orders: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<OrdersResponse>('orders', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getOrder(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<OrderResponse>(
      `orders/${documentSegment(documentNumber)}`,
    );
    return data.Order;
  }

  async function createOrder(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<OrderResponse>('orders', {
      method: 'POST',
      body: { Order: params },
    });
    return data.Order;
  }

  async function updateOrder(
    documentNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { documentNumber: _, ...body } = fields;
    const data = await transport.request<OrderResponse>(
      `orders/${documentSegment(documentNumber)}`,
      {
        method: 'PUT',
        body: { Order: body },
      },
    );
    return data.Order;
  }

  async function createInvoiceFromOrder(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<{ Invoice: Record<string, unknown> }>(
      `orders/${documentSegment(documentNumber)}/createinvoice`,
      { method: 'PUT' },
    );
    return data.Invoice;
  }

  async function runOrderAction(
    documentNumber: string,
    action: 'cancel' | 'externalprint',
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<OrderResponse>(
      `orders/${documentSegment(documentNumber)}/${action}`,
      { method: 'PUT' },
    );
    return data.Order ?? {};
  }

  const cancelOrder = (documentNumber: string) => runOrderAction(documentNumber, 'cancel');
  const externalPrintOrder = (documentNumber: string) =>
    runOrderAction(documentNumber, 'externalprint');

  async function emailOrder(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<OrderResponse>(
      `orders/${documentSegment(documentNumber)}/email`,
      { mutation: true },
    );
    return data.Order ?? {};
  }

  async function getOrderPdf(
    documentNumber: string,
    mode: 'preview' | 'print' = 'preview',
  ): Promise<Buffer | undefined> {
    const path = `orders/${documentSegment(documentNumber)}/${mode}`;
    return mode === 'print' ? transport.requestPdfFromMutation(path) : transport.requestPdf(path);
  }

  return {
    listOrders,
    getOrder,
    createOrder,
    updateOrder,
    createInvoiceFromOrder,
    cancelOrder,
    emailOrder,
    externalPrintOrder,
    getOrderPdf,
  };
}

export const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  createInvoiceFromOrder,
  cancelOrder,
  emailOrder,
  externalPrintOrder,
  getOrderPdf,
} = createOrderOperations(defaultFortnoxTransport);
