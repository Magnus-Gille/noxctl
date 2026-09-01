import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface SupplierInvoiceResponse {
  SupplierInvoice: Record<string, unknown>;
}

export interface SupplierInvoicesResponse {
  SupplierInvoices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListSupplierInvoicesParams {
  filter?: string;
  supplierNumber?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export interface SupplierInvoiceAttachment {
  fileName: string;
  fileId: string;
  supplierInvoiceNumber: string;
}

export interface SupplierInvoiceFileContent {
  fileId: string;
  contentType: string;
  buffer: Buffer;
}

export function createSupplierInvoiceOperations(transport: FortnoxTransport) {
  async function listSupplierInvoices(
    params: ListSupplierInvoicesParams = {},
  ): Promise<SupplierInvoicesResponse> {
    const subpath = params.filter ? `?filter=${encodeURIComponent(params.filter)}` : '';
    const endpoint = `supplierinvoices${subpath}`;
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.supplierNumber ? { suppliernumber: params.supplierNumber } : {}),
      ...(params.fromDate ? { fromdate: params.fromDate } : {}),
      ...(params.toDate ? { todate: params.toDate } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        endpoint,
        'SupplierInvoices',
        queryParams,
      );
      return {
        SupplierInvoices: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<SupplierInvoicesResponse>(endpoint, {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getSupplierInvoice(givenNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>(
      `supplierinvoices/${encodeURIComponent(givenNumber)}`,
    );
    return data.SupplierInvoice;
  }

  async function createSupplierInvoice(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>('supplierinvoices', {
      method: 'POST',
      body: { SupplierInvoice: params },
    });
    return data.SupplierInvoice;
  }

  async function bookkeepSupplierInvoice(givenNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<SupplierInvoiceResponse>(
      `supplierinvoices/${encodeURIComponent(givenNumber)}/bookkeep`,
      { method: 'PUT' },
    );
    return data.SupplierInvoice;
  }

  interface SupplierInvoiceFileConnectionListResponse {
    SupplierInvoiceFileConnections: Record<string, unknown>[];
  }

  // List the files attached to a supplier invoice — the read counterpart that
  // was missing: vouchers and customer invoices both had a read path, but a
  // supplier invoice's original document (the scanned/emailed invoice itself)
  // was only reachable once the invoice was bookkept into a voucher. This
  // reaches it directly, so it works for `unbooked`/`authorizepending`
  // invoices too — server-side filtered by `supplierinvoicenumber`, unlike
  // voucherfileconnections which has no matching filter for vouchers.
  async function listSupplierInvoiceAttachments(
    givenNumber: string,
  ): Promise<SupplierInvoiceAttachment[]> {
    const data = await transport.request<SupplierInvoiceFileConnectionListResponse>(
      'supplierinvoicefileconnections',
      { params: { supplierinvoicenumber: givenNumber } },
    );
    return (data.SupplierInvoiceFileConnections ?? []).map((c) => ({
      fileName: String(c.Name ?? ''),
      fileId: String(c.FileId),
      supplierInvoiceNumber: String(c.SupplierInvoiceNumber ?? givenNumber),
    }));
  }

  // Download the actual bytes of a file attached to a supplier invoice.
  // Fortnox serves it the same way as a voucher attachment — GET inbox/{fileId}
  // under the connectfile scope — no archive scope needed (that's only for
  // customer invoices, which have no *invoicefileconnections* resource; see the
  // ARCHIVE_SCOPE comment in auth.ts).
  async function getSupplierInvoiceFile(fileId: string): Promise<SupplierInvoiceFileContent> {
    const { buffer, contentType } = await transport.requestFile(
      `inbox/${encodeURIComponent(fileId)}`,
    );
    return { fileId, contentType, buffer };
  }

  return {
    listSupplierInvoices,
    getSupplierInvoice,
    createSupplierInvoice,
    bookkeepSupplierInvoice,
    listSupplierInvoiceAttachments,
    getSupplierInvoiceFile,
  };
}

export const {
  listSupplierInvoices,
  getSupplierInvoice,
  createSupplierInvoice,
  bookkeepSupplierInvoice,
  listSupplierInvoiceAttachments,
  getSupplierInvoiceFile,
} = createSupplierInvoiceOperations(defaultFortnoxTransport);
