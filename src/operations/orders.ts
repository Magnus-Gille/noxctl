import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface OrderResponse {
  Order: Record<string, unknown>;
}

interface OrdersResponse {
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

export async function listOrders(params: ListOrdersParams = {}): Promise<OrdersResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    filter: params.filter,
    customernumber: params.customerNumber,
    fromdate: params.fromDate,
    todate: params.toDate,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'orders',
      'Orders',
      queryParams,
    );
    return {
      Orders: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<OrdersResponse>('orders', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getOrder(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<OrderResponse>(`orders/${documentSegment(documentNumber)}`);
  return data.Order;
}

export async function createOrder(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<OrderResponse>('orders', {
    method: 'POST',
    body: { Order: params },
  });
  return data.Order;
}

export async function updateOrder(
  documentNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { documentNumber: _, ...body } = fields;
  const data = await fortnoxRequest<OrderResponse>(`orders/${documentSegment(documentNumber)}`, {
    method: 'PUT',
    body: { Order: body },
  });
  return data.Order;
}

export async function createInvoiceFromOrder(
  documentNumber: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<{ Invoice: Record<string, unknown> }>(
    `orders/${documentSegment(documentNumber)}/createinvoice`,
    { method: 'PUT' },
  );
  return data.Invoice;
}
