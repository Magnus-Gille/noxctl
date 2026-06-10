import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface ContractResponse {
  Contract: Record<string, unknown>;
}

interface InvoiceResponse {
  Invoice: Record<string, unknown>;
}

interface ContractsResponse {
  Contracts: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListContractsParams {
  filter?: string; // active, inactive, finished
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listContracts(params: ListContractsParams = {}): Promise<ContractsResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    filter: params.filter,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'contracts',
      'Contracts',
      queryParams,
    );
    return {
      Contracts: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<ContractsResponse>('contracts', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getContract(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ContractResponse>(
    `contracts/${documentSegment(documentNumber)}`,
  );
  return data.Contract;
}

export async function createContract(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ContractResponse>('contracts', {
    method: 'POST',
    body: { Contract: params },
  });
  return data.Contract;
}

export async function updateContract(
  documentNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { documentNumber: _, ...body } = fields;
  const data = await fortnoxRequest<ContractResponse>(
    `contracts/${documentSegment(documentNumber)}`,
    {
      method: 'PUT',
      body: { Contract: body },
    },
  );
  return data.Contract;
}

// Mark the contract as finished — no further invoices will be created.
export async function finishContract(documentNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ContractResponse>(
    `contracts/${documentSegment(documentNumber)}/finish`,
    { method: 'PUT' },
  );
  return data?.Contract || {};
}

// Create the next invoice from the contract immediately. Returns the Invoice.
export async function createInvoiceFromContract(
  documentNumber: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<InvoiceResponse>(
    `contracts/${documentSegment(documentNumber)}/createinvoice`,
    { method: 'PUT' },
  );
  return data?.Invoice || {};
}

// Extend a non-continuous contract by one invoice.
export async function increaseInvoiceCount(
  documentNumber: string,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ContractResponse>(
    `contracts/${documentSegment(documentNumber)}/increaseinvoicecount`,
    { method: 'PUT' },
  );
  return data?.Contract || {};
}
