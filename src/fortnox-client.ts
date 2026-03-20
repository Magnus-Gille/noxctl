import { getValidToken } from './auth.js';

const BASE_URL = 'https://api.fortnox.se/3';

// Rate limiter: max 25 requests per 5 seconds
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 25;
const requestTimestamps: number[] = [];

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT) {
    const oldestInWindow = requestTimestamps[0]!;
    const waitMs = oldestInWindow + RATE_WINDOW_MS - now + 50; // 50ms buffer
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  requestTimestamps.push(Date.now());
}

export interface FortnoxError {
  code: number;
  message: string;
  details?: string;
}

export class FortnoxApiError extends Error {
  public readonly hint?: string;

  constructor(
    public readonly statusCode: number,
    public readonly fortnoxMessage: string,
    public readonly details?: string,
    endpoint?: string,
  ) {
    const hint = getErrorHint(statusCode, fortnoxMessage, endpoint);
    const parts = [`Fortnox API error (${statusCode}): ${fortnoxMessage}`];
    if (hint) parts.push(`Hint: ${hint}`);
    super(parts.join('\n'));
    this.name = 'FortnoxApiError';
    this.hint = hint;
  }
}

function getErrorHint(statusCode: number, message: string, endpoint?: string): string | undefined {
  switch (statusCode) {
    case 401:
      return 'Authentication failed. Try `noxctl init` to re-authenticate.';
    case 403:
      if (endpoint) {
        const scope = endpointToScope(endpoint);
        if (scope) {
          return `Missing "${scope}" scope. Enable it in your Fortnox app at developer.fortnox.se, then re-run \`noxctl init\`.`;
        }
      }
      return 'Forbidden. Check that your Fortnox app has the required scopes enabled at developer.fortnox.se.';
    case 404:
      return 'Resource not found. Verify the ID/number exists in Fortnox.';
    case 429:
      return 'Rate limited by Fortnox. The request will be retried automatically.';
    default:
      if (statusCode >= 500) {
        return 'Fortnox server error. Try again in a moment.';
      }
      return undefined;
  }
}

function endpointToScope(endpoint: string): string | undefined {
  const path = endpoint.split('?')[0]!.toLowerCase();
  const mapping: Record<string, string> = {
    articles: 'article',
    customers: 'customer',
    invoices: 'invoice',
    invoicepayments: 'invoice',
    offers: 'invoice',
    orders: 'invoice',
    suppliers: 'supplier',
    supplierinvoices: 'supplierinvoice',
    supplierinvoicepayments: 'supplierinvoice',
    vouchers: 'bookkeeping',
    accounts: 'bookkeeping',
    companyinformation: 'companyinformation',
    settings: 'settings',
    projects: 'project',
    costcenters: 'costcenter',
    taxreductions: 'invoice',
    pricelists: 'price',
    prices: 'price',
  };
  for (const [prefix, scope] of Object.entries(mapping)) {
    if (path.startsWith(prefix)) return scope;
  }
  return undefined;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retryable: boolean,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      if (!retryable) throw err;

      // Only retry on transient errors (429, 500, 502, 503, 504)
      if (err instanceof FortnoxApiError) {
        const retryable = [429, 500, 502, 503, 504];
        if (!retryable.includes(err.statusCode)) throw err;
      } else if (
        err instanceof Error &&
        !err.message.includes('ECONNRESET') &&
        !err.message.includes('ETIMEDOUT')
      ) {
        throw err;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
}

export async function fortnoxRequest<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  return retryWithBackoff(async () => {
    await waitForRateLimit();

    const token = await getValidToken();
    const url = new URL(`${BASE_URL}/${endpoint}`);

    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      let details: string | undefined;
      try {
        const errorBody = (await response.json()) as {
          ErrorInformation?: { message?: string; code?: number };
        };
        if (errorBody?.ErrorInformation) {
          errorMessage = errorBody.ErrorInformation.message || errorMessage;
          details = `Error code: ${errorBody.ErrorInformation.code}`;
        }
      } catch {
        // ignore parse errors
      }
      throw new FortnoxApiError(response.status, errorMessage, details, endpoint);
    }

    // Some endpoints return empty responses (e.g., DELETE)
    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  }, retryable);
}

/**
 * Fetch all pages of a paginated Fortnox list endpoint.
 * `dataKey` is the envelope key (e.g. "Invoices", "Customers").
 */
export async function fetchAllPages<T extends Record<string, unknown>>(
  endpoint: string,
  dataKey: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ items: T[]; totalResources: number }> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;
  let totalResources = 0;

  do {
    const data = await fortnoxRequest<Record<string, unknown>>(endpoint, {
      params: { ...params, page, limit: 100 },
    });
    const items = (data[dataKey] as T[]) ?? [];
    all.push(...items);

    const meta = data.MetaInformation as
      | { '@TotalPages': number; '@CurrentPage': number; '@TotalResources': number }
      | undefined;
    totalPages = meta?.['@TotalPages'] ?? 1;
    totalResources = meta?.['@TotalResources'] ?? all.length;
    page++;
  } while (page <= totalPages);

  return { items: all, totalResources };
}
