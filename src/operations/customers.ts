import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
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
  all?: boolean;
}

export async function listCustomers(params: ListCustomersParams = {}): Promise<CustomersResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    ...(params.search ? { name: params.search } : {}),
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'customers',
      'Customers',
      queryParams,
    );
    return {
      Customers: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<CustomersResponse>('customers', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getCustomer(customerNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CustomerResponse>(
    `customers/${customerSegment(customerNumber)}`,
  );
  return data.Customer;
}

// Server-derived display fields Fortnox rejects on write ("Fältet Country är
// endast läsbart"). Stripping them lets a `get` response be fed back into
// create/update unchanged; the *CountryCode fields remain the writable source.
const READ_ONLY_CUSTOMER_FIELDS = ['Country', 'DeliveryCountry', 'VisitingCountry'] as const;

function stripReadOnlyFields(params: Record<string, unknown>): Record<string, unknown> {
  const writable = { ...params };
  for (const field of READ_ONLY_CUSTOMER_FIELDS) delete writable[field];
  return writable;
}

export async function createCustomer(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CustomerResponse>('customers', {
    method: 'POST',
    body: { Customer: stripReadOnlyFields(params) },
  });
  return data.Customer;
}

export async function updateCustomer(
  customerNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { customerNumber: _, ...body } = fields;
  const data = await fortnoxRequest<CustomerResponse>(
    `customers/${customerSegment(customerNumber)}`,
    {
      method: 'PUT',
      body: { Customer: stripReadOnlyFields(body) },
    },
  );
  return data.Customer;
}
