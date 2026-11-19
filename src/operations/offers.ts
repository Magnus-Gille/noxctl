import { documentResource } from '../document-api-version.js';
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
        documentResource('offers'),
        'Offers',
        queryParams,
      );
      return {
        Offers: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<OffersResponse>(documentResource('offers'), {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>(
      `${documentResource('offers')}/${documentSegment(documentNumber)}`,
    );
    return data.Offer;
  }

  async function createOffer(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>(documentResource('offers'), {
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
      `${documentResource('offers')}/${documentSegment(documentNumber)}`,
      {
        method: 'PUT',
        body: { Offer: body },
      },
    );
    return data.Offer;
  }

  async function createInvoiceFromOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<{ Invoice: Record<string, unknown> }>(
      `${documentResource('offers')}/${documentSegment(documentNumber)}/createinvoice`,
      { method: 'PUT' },
    );
    return data.Invoice;
  }

  async function createOrderFromOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<{ Order: Record<string, unknown> }>(
      `${documentResource('offers')}/${documentSegment(documentNumber)}/createorder`,
      { method: 'PUT' },
    );
    return data.Order;
  }

  async function runOfferAction(
    documentNumber: string,
    action: 'cancel' | 'externalprint',
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>(
      `${documentResource('offers')}/${documentSegment(documentNumber)}/${action}`,
      { method: 'PUT' },
    );
    return data.Offer ?? {};
  }

  const cancelOffer = (documentNumber: string) => runOfferAction(documentNumber, 'cancel');
  const externalPrintOffer = (documentNumber: string) =>
    runOfferAction(documentNumber, 'externalprint');

  async function emailOffer(documentNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<OfferResponse>(
      `${documentResource('offers')}/${documentSegment(documentNumber)}/email`,
      { mutation: true },
    );
    return data.Offer ?? {};
  }

  async function getOfferPdf(
    documentNumber: string,
    mode: 'preview' | 'print' = 'preview',
  ): Promise<Buffer | undefined> {
    const path = `${documentResource('offers')}/${documentSegment(documentNumber)}/${mode}`;
    return mode === 'print' ? transport.requestPdfFromMutation(path) : transport.requestPdf(path);
  }

  return {
    listOffers,
    getOffer,
    createOffer,
    updateOffer,
    createInvoiceFromOffer,
    createOrderFromOffer,
    cancelOffer,
    emailOffer,
    externalPrintOffer,
    getOfferPdf,
  };
}

export const {
  listOffers,
  getOffer,
  createOffer,
  updateOffer,
  createInvoiceFromOffer,
  createOrderFromOffer,
  cancelOffer,
  emailOffer,
  externalPrintOffer,
  getOfferPdf,
} = createOfferOperations(defaultFortnoxTransport);
