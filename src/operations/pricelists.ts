import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

// --- Price Lists ---

interface PriceListResponse {
  PriceList: Record<string, unknown>;
}

interface PriceListsResponse {
  PriceLists: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListPriceListsParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listPriceLists(
  params: ListPriceListsParams = {},
): Promise<PriceListsResponse> {
  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'pricelists',
      'PriceLists',
    );
    return {
      PriceLists: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<PriceListsResponse>('pricelists', {
    params: { page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getPriceList(code: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<PriceListResponse>(`pricelists/${encodeURIComponent(code)}`);
  return data.PriceList;
}

export async function createPriceList(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<PriceListResponse>('pricelists', {
    method: 'POST',
    body: { PriceList: params },
  });
  return data.PriceList;
}

export async function updatePriceList(
  code: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { Code: _, ...body } = fields;
  const data = await fortnoxRequest<PriceListResponse>(`pricelists/${encodeURIComponent(code)}`, {
    method: 'PUT',
    body: { PriceList: body },
  });
  return data.PriceList;
}

// --- Prices (sublists within price lists) ---

interface PriceResponse {
  Price: Record<string, unknown>;
}

interface PricesResponse {
  Prices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListPricesParams {
  priceListCode: string;
  articleNumber?: string;
  page?: number;
  limit?: number;
}

export async function listPrices(params: ListPricesParams): Promise<PricesResponse> {
  const endpoint = params.articleNumber
    ? `prices/sublist/${encodeURIComponent(params.priceListCode)}/${encodeURIComponent(params.articleNumber)}`
    : `prices/sublist/${encodeURIComponent(params.priceListCode)}`;

  return fortnoxRequest<PricesResponse>(endpoint, {
    params: { page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getPrice(
  priceListCode: string,
  articleNumber: string,
  fromQuantity = 0,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<PriceResponse>(
    `prices/${encodeURIComponent(priceListCode)}/${encodeURIComponent(articleNumber)}/${fromQuantity}`,
  );
  return data.Price;
}

export async function updatePrice(
  priceListCode: string,
  articleNumber: string,
  fields: Record<string, unknown>,
  fromQuantity = 0,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<PriceResponse>(
    `prices/${encodeURIComponent(priceListCode)}/${encodeURIComponent(articleNumber)}/${fromQuantity}`,
    {
      method: 'PUT',
      body: { Price: fields },
    },
  );
  return data.Price;
}
