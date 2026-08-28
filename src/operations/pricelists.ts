import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

// --- Price Lists ---

interface PriceListResponse {
  PriceList: Record<string, unknown>;
}

export interface PriceListsResponse {
  PriceLists: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListPriceListsParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export function createPriceListOperations(transport: FortnoxTransport) {
  async function listPriceLists(params: ListPriceListsParams = {}): Promise<PriceListsResponse> {
    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'pricelists',
        'PriceLists',
      );
      return {
        PriceLists: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<PriceListsResponse>('pricelists', {
      params: { page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getPriceList(code: string): Promise<Record<string, unknown>> {
    const data = await transport.request<PriceListResponse>(
      `pricelists/${encodeURIComponent(code)}`,
    );
    return data.PriceList;
  }

  async function createPriceList(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<PriceListResponse>('pricelists', {
      method: 'POST',
      body: { PriceList: params },
    });
    return data.PriceList;
  }

  async function updatePriceList(
    code: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { Code: _, ...body } = fields;
    const data = await transport.request<PriceListResponse>(
      `pricelists/${encodeURIComponent(code)}`,
      {
        method: 'PUT',
        body: { PriceList: body },
      },
    );
    return data.PriceList;
  }

  return { listPriceLists, getPriceList, createPriceList, updatePriceList };
}

export const { listPriceLists, getPriceList, createPriceList, updatePriceList } =
  createPriceListOperations(defaultFortnoxTransport);

// --- Prices (sublists within price lists) ---

interface PriceResponse {
  Price: Record<string, unknown>;
}

export interface PricesResponse {
  Prices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListPricesParams {
  priceListCode: string;
  articleNumber?: string;
  page?: number;
  limit?: number;
}

export function createPriceOperations(transport: FortnoxTransport) {
  async function listPrices(params: ListPricesParams): Promise<PricesResponse> {
    const endpoint = params.articleNumber
      ? `prices/sublist/${encodeURIComponent(params.priceListCode)}/${encodeURIComponent(params.articleNumber)}`
      : `prices/sublist/${encodeURIComponent(params.priceListCode)}`;

    return transport.request<PricesResponse>(endpoint, {
      params: { page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getPrice(
    priceListCode: string,
    articleNumber: string,
    fromQuantity = 0,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<PriceResponse>(
      `prices/${encodeURIComponent(priceListCode)}/${encodeURIComponent(articleNumber)}/${fromQuantity}`,
    );
    return data.Price;
  }

  async function updatePrice(
    priceListCode: string,
    articleNumber: string,
    fields: Record<string, unknown>,
    fromQuantity = 0,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<PriceResponse>(
      `prices/${encodeURIComponent(priceListCode)}/${encodeURIComponent(articleNumber)}/${fromQuantity}`,
      {
        method: 'PUT',
        body: { Price: fields },
      },
    );
    return data.Price;
  }

  return { listPrices, getPrice, updatePrice };
}

export const { listPrices, getPrice, updatePrice } = createPriceOperations(defaultFortnoxTransport);
