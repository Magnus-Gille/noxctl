import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

interface OfferResponse {
  Offer: Record<string, unknown>;
}

export interface OffersResponse {
  Offers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListOffersParams {
  filter?: string;
  customerNumber?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createOfferOperations(transport: FortnoxTransport) {
  async function listOffers(params: ListOffersParams = {}): Promise<OffersResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      filter: params.filter,
      customernumber: params.customerNumber,
      fromdate: params.fromDate,
      todate: params.toDate,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'offers',
        'Offers',
        queryParams,
      );
      return {
        Offers: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<OffersResponse>('offers', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>(
      `offers/${documentSegment(documentNumber)}`,
    );
    return data.Offer;
  }

  async function createOffer(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>('offers', {
      method: 'POST',
      body: { Offer: params },
    });
    return data.Offer;
  }

  async function updateOffer(
    documentNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { documentNumber: _, ...body } = fields;
    const data = await transport.request<OfferResponse>(
      `offers/${documentSegment(documentNumber)}`,
      {
        method: 'PUT',
        body: { Offer: body },
      },
    );
    return data.Offer;
  }

  async function createInvoiceFromOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<{ Invoice: Record<string, unknown> }>(
      `offers/${documentSegment(documentNumber)}/createinvoice`,
      { method: 'PUT' },
    );
    return data.Invoice;
  }

  async function createOrderFromOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<{ Order: Record<string, unknown> }>(
      `offers/${documentSegment(documentNumber)}/createorder`,
      { method: 'PUT' },
    );
    return data.Order;
  }

  return {
    listOffers,
    getOffer,
    createOffer,
    updateOffer,
    createInvoiceFromOffer,
    createOrderFromOffer,
  };
}

export const {
  listOffers,
  getOffer,
  createOffer,
  updateOffer,
  createInvoiceFromOffer,
  createOrderFromOffer,
} = createOfferOperations(defaultFortnoxTransport);
