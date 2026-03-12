import { fortnoxRequest } from '../fortnox-client.js';
import { customerSegment } from '../identifiers.js';

interface CustomerResponse {
  Customer: Record<string, unknown>;
}

interface CustomersResponse {
  Customers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListCustomersParams {
  search?: string;
  page?: number;
  limit?: number;
}

export async function listCustomers(params: ListCustomersParams = {}): Promise<CustomersResponse> {
  return fortnoxRequest<CustomersResponse>('customers', {
    params: {
      page: params.page || 1,
      limit: params.limit || 100,
      ...(params.search ? { name: params.search } : {}),
    },
  });
}

export async function getCustomer(customerNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CustomerResponse>(`customers/${customerSegment(customerNumber)}`);
  return data.Customer;
}

export async function createCustomer(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CustomerResponse>('customers', {
    method: 'POST',
    body: { Customer: params },
  });
  return data.Customer;
}

export async function updateCustomer(
  customerNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { customerNumber: _cn, ...body } = fields;
  const data = await fortnoxRequest<CustomerResponse>(`customers/${customerSegment(customerNumber)}`, {
    method: 'PUT',
    body: { Customer: body },
  });
  return data.Customer;
}
