import { getResolvedProfile, getValidToken } from './auth.js';
import { DEFAULT_PROFILE } from './profile-name.js';

const BASE_URL = 'https://api.fortnox.se/3';
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

// Rate limiter: max 25 requests per 5 seconds
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 25;
const requestTimestamps: number[] = [];
let rateLimitTail: Promise<void> = Promise.resolve();

async function waitForRateLimit(): Promise<void> {
  let release!: () => void;
  const previous = rateLimitTail;
  rateLimitTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    while (true) {
      const now = Date.now();
      while (requestTimestamps.length > 0 && requestTimestamps[0]! <= now - RATE_WINDOW_MS) {
        requestTimestamps.shift();
      }

      if (requestTimestamps.length < RATE_LIMIT) {
        requestTimestamps.push(now);
        return;
      }

      const oldestInWindow = requestTimestamps[0]!;
      const waitMs = Math.max(1, oldestInWindow + RATE_WINDOW_MS - now + 50);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  } finally {
    release();
  }
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
    public readonly retryAfterMs?: number,
  ) {
    const hint = getErrorHint(statusCode, fortnoxMessage, endpoint);
    const profile = getResolvedProfile();
    const profileTag = profile.toLowerCase() !== DEFAULT_PROFILE ? `[profile: ${profile}] ` : '';
    const parts = [`${profileTag}Fortnox API error (${statusCode}): ${fortnoxMessage}`];
    if (hint) parts.push(`Hint: ${hint}`);
    super(parts.join('\n'));
    this.name = 'FortnoxApiError';
    this.hint = hint;
  }
}

export class FortnoxRequestTimeoutError extends Error {
  public readonly outcomeUnknown: boolean;

  constructor(method: string, endpoint: string, timeoutMs: number) {
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const suffix = mutation
      ? ' The outcome is unknown; verify the result in Fortnox before retrying to avoid duplicate side effects.'
      : ' It is safe to retry the read request.';
    super(`Fortnox ${method} ${endpoint} timed out after ${timeoutMs} ms.${suffix}`);
    this.name = 'FortnoxRequestTimeoutError';
    this.outcomeUnknown = mutation;
  }
}

function getErrorHint(statusCode: number, message: string, endpoint?: string): string | undefined {
  // Payroll: creating an employee fails with a null "ftgavtalid" when Fortnox
  // can't assign a company/employment agreement — which happens when
  // EmploymentForm / PersonelType / SalaryForm are omitted. Message-based (the
  // status is a generic 400), so check it before the status switch.
  if (/ftgavtal/i.test(message)) {
    return 'Fortnox could not assign an employment agreement (företagsavtal). On employee create, also set EmploymentForm, PersonelType and SalaryForm — or configure a default agreement in Fortnox Lön.';
  }

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
      return 'Rate limited by Fortnox. Read requests are retried automatically; mutations are not retried to avoid duplicate side effects.';
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
    inbox: 'inbox',
    archive: 'archive',
    voucherfileconnections: 'connectfile',
    employees: 'salary',
    salarytransactions: 'salary',
    attendancetransactions: 'salary',
    absencetransactions: 'salary',
    scheduletimes: 'salary',
  };
  for (const [prefix, scope] of Object.entries(mapping)) {
    if (path.startsWith(prefix)) return scope;
  }
  return undefined;
}

function errorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string') return value.code;
    current = value.cause;
  }
  return undefined;
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError' || errorCode(err) === 'ABORT_ERR')
  );
}

function isTransientNetworkError(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  const code = errorCode(err);
  if (
    code &&
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code)
  ) {
    return true;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function retryAfterDelay(response: Response): number | undefined {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : new Date(raw).getTime() - Date.now();
  if (!Number.isFinite(delay)) return undefined;
  return Math.min(Math.max(0, delay), MAX_RETRY_DELAY_MS);
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retryable: boolean,
  maxRetries = MAX_RETRIES,
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
      } else if (!isTransientNetworkError(err)) {
        throw err;
      }

      const delay =
        err instanceof FortnoxApiError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : Math.min(1000 * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Unreachable');
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  params?: Record<string, string | number | undefined>;
}

// Issue the HTTP request and translate a non-2xx answer into a FortnoxApiError.
// Returns the raw Response so callers can decide how to read the body.
async function sendRequest(
  endpoint: string,
  options: RequestOptions,
  method: string,
  timeoutMs: number,
): Promise<Response> {
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

  // Accept is always application/json, even for the endpoints that answer with a
  // PDF. This looks wrong but is not: Fortnox rejects Accept: application/pdf (and
  // application/octet-stream) on its PDF endpoints with
  // {"ErrorInformation":{"error":1,"message":"Invalid response type","code":1000030}}.
  // Do not "fix" this header.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (options.rawBody !== undefined) {
    // A raw body (e.g. FormData for a multipart file upload): do NOT set
    // Content-Type — fetch/undici derives it (and the multipart boundary)
    // from the body itself.
    fetchOptions.body = options.rawBody;
  } else {
    headers['Content-Type'] = 'application/json';
    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }
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
    throw new FortnoxApiError(
      response.status,
      errorMessage,
      details,
      endpoint,
      retryAfterDelay(response),
    );
  }

  return response;
}

// Shared retry/timeout envelope; `readBody` turns a successful Response into T.
async function request<T>(
  endpoint: string,
  options: RequestOptions,
  readBody: (response: Response) => Promise<T>,
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  const timeoutMs = options.rawBody === undefined ? REQUEST_TIMEOUT_MS : UPLOAD_TIMEOUT_MS;

  try {
    return await retryWithBackoff(
      async () => readBody(await sendRequest(endpoint, options, method, timeoutMs)),
      retryable,
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new FortnoxRequestTimeoutError(method, endpoint, timeoutMs);
    }
    throw err;
  }
}

export async function fortnoxRequest<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(endpoint, options, async (response) => {
    // Some endpoints return empty responses (e.g., DELETE)
    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  });
}

// Summarize an unexpected (non-binary) body for an error message, preferring the
// Fortnox error envelope when the body turns out to be one.
function describeUnexpectedBody(buf: Buffer): string {
  const text = buf.toString('utf-8', 0, 2000).trim();
  try {
    const parsed = JSON.parse(text) as {
      ErrorInformation?: { message?: string; code?: number };
    };
    const info = parsed?.ErrorInformation;
    if (info?.message) {
      return info.code === undefined ? info.message : `${info.message} (code ${info.code})`;
    }
  } catch {
    // not JSON — fall through to the raw excerpt
  }
  return text.slice(0, 200) || '<empty body>';
}

/**
 * Fetch a binary payload (currently: the PDF that Fortnox's invoice
 * print/preview endpoints return). Shares rate limiting, retries, timeouts and
 * error mapping with `fortnoxRequest`.
 *
 * Guards against writing a non-PDF body to disk: Fortnox can answer 200 with a
 * JSON error envelope, and silently saving that as `invoice-1001.pdf` would look
 * like success until someone opens the file.
 */
export async function fortnoxRequestBinary(
  endpoint: string,
  options: RequestOptions = {},
): Promise<Buffer> {
  return request<Buffer>(endpoint, options, async (response) => {
    const contentType = response.headers?.get?.('content-type') ?? '';
    const buf = Buffer.from(await response.arrayBuffer());

    if (!/application\/(pdf|octet-stream)/i.test(contentType)) {
      throw new Error(
        `Fortnox returned ${contentType || 'an unknown content type'} instead of a PDF for ${endpoint}: ${describeUnexpectedBody(buf)}`,
      );
    }

    return buf;
  });
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
