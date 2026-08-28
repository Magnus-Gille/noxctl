import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { customerSegment } from '../identifiers.js';

interface CustomerResponse {
  Customer: Record<string, unknown>;
}

export interface CustomersResponse {
  Customers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListCustomersParams {
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createCustomerOperations(transport: FortnoxTransport) {
  async function listCustomers(params: ListCustomersParams = {}): Promise<CustomersResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.search ? { name: params.search } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'customers',
        'Customers',
        queryParams,
      );
      return {
        Customers: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<CustomersResponse>('customers', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getCustomer(customerNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<CustomerResponse>(
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

  async function createCustomer(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<CustomerResponse>('customers', {
      method: 'POST',
      body: { Customer: stripReadOnlyFields(params) },
    });
    return data.Customer;
  }

  async function updateCustomer(
    customerNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { customerNumber: _, ...body } = fields;
    const data = await transport.request<CustomerResponse>(
      `customers/${customerSegment(customerNumber)}`,
      {
        method: 'PUT',
        body: { Customer: stripReadOnlyFields(body) },
      },
    );
    return data.Customer;
  }

  return { listCustomers, getCustomer, createCustomer, updateCustomer };
}

export const { listCustomers, getCustomer, createCustomer, updateCustomer } =
  createCustomerOperations(defaultFortnoxTransport);
