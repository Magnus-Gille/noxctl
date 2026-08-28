import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface ContractResponse {
  Contract: Record<string, unknown>;
}

interface InvoiceResponse {
  Invoice: Record<string, unknown>;
}

export interface ContractsResponse {
  Contracts: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListContractsParams {
  filter?: string; // active, inactive, finished
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createContractOperations(transport: FortnoxTransport) {
  async function listContracts(params: ListContractsParams = {}): Promise<ContractsResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      filter: params.filter,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'contracts',
        'Contracts',
        queryParams,
      );
      return {
        Contracts: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<ContractsResponse>('contracts', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getContract(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ContractResponse>(
      `contracts/${documentSegment(documentNumber)}`,
    );
    return data.Contract;
  }

  async function createContract(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<ContractResponse>('contracts', {
      method: 'POST',
      body: { Contract: params },
    });
    return data.Contract;
  }

  async function updateContract(
    documentNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { documentNumber: _, ...body } = fields;
    const data = await transport.request<ContractResponse>(
      `contracts/${documentSegment(documentNumber)}`,
      {
        method: 'PUT',
        body: { Contract: body },
      },
    );
    return data.Contract;
  }

  // Mark the contract as finished — no further invoices will be created.
  async function finishContract(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ContractResponse>(
      `contracts/${documentSegment(documentNumber)}/finish`,
      { method: 'PUT' },
    );
    return data?.Contract || {};
  }

  // Create the next invoice from the contract immediately. Returns the Invoice.
  async function createInvoiceFromContract(
    documentNumber: string,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<InvoiceResponse>(
      `contracts/${documentSegment(documentNumber)}/createinvoice`,
      { method: 'PUT' },
    );
    return data?.Invoice || {};
  }

  // Extend a non-continuous contract by one invoice.
  async function increaseInvoiceCount(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ContractResponse>(
      `contracts/${documentSegment(documentNumber)}/increaseinvoicecount`,
      { method: 'PUT' },
    );
    return data?.Contract || {};
  }

  return {
    listContracts,
    getContract,
    createContract,
    updateContract,
    finishContract,
    createInvoiceFromContract,
    increaseInvoiceCount,
  };
}

export const {
  listContracts,
  getContract,
  createContract,
  updateContract,
  finishContract,
  createInvoiceFromContract,
  increaseInvoiceCount,
} = createContractOperations(defaultFortnoxTransport);
