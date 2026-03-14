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
  constructor(
    public readonly statusCode: number,
    public readonly fortnoxMessage: string,
    public readonly details?: string,
  ) {
    super(`Fortnox API error (${statusCode}): ${fortnoxMessage}`);
    this.name = 'FortnoxApiError';
  }
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
      throw new FortnoxApiError(response.status, errorMessage, details);
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
