import { getResolvedProfile, getValidToken } from './auth.js';
import { DEFAULT_PROFILE } from './profile-name.js';

const API_ROOT_URL = 'https://api.fortnox.se';
const BASE_URL = `${API_ROOT_URL}/3`;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

// Rate limiter: max 25 requests per 5 seconds
const RATE_WINDOW_MS = 5000;
const RATE_LIMIT = 25;

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
    diagnosticContext?: { kind: 'context' | 'profile'; label: string },
  ) {
    const hint = getErrorHint(statusCode, fortnoxMessage, endpoint);
    const contextTag = formatDiagnosticContext(diagnosticContext);
    const parts = [`${contextTag}Fortnox API error (${statusCode}): ${fortnoxMessage}`];
    if (hint) parts.push(`Hint: ${hint}`);
    super(parts.join('\n'));
    this.name = 'FortnoxApiError';
    this.hint = hint;
  }
}

function formatDiagnosticContext(context?: { kind: 'context' | 'profile'; label: string }): string {
  if (!context) return '';
  const label = context.label
    .trim()
    .replace(/[\r\n\[\]]+/g, ' ')
    .slice(0, 128);
  if (!label || (context.kind === 'profile' && label.toLowerCase() === DEFAULT_PROFILE)) return '';
  return `[${context.kind}: ${label}] `;
}

export class FortnoxRequestTimeoutError extends Error {
  public readonly outcomeUnknown: boolean;

  constructor(method: string, endpoint: string, timeoutMs: number, isMutation?: boolean) {
    const mutation = isMutation ?? !['GET', 'HEAD', 'OPTIONS'].includes(method);
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
    invoicepayments: 'payment',
    offers: 'offer',
    orders: 'order',
    suppliers: 'supplier',
    supplierinvoices: 'supplierinvoice',
    supplierinvoicepayments: 'payment',
    vouchers: 'bookkeeping',
    accounts: 'bookkeeping',
    financialyears: 'bookkeeping',
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
  /** Additional request headers, e.g. conditional ETags for APIs that require them. */
  headers?: Record<string, string | undefined>;
  /**
   * Override the safety classification that would otherwise be derived from the
   * HTTP verb. Fortnox exposes some state-changing actions as GET — notably
   * `/invoices/{n}/print`, which sets `Sent` — and those must not be retried
   * automatically, nor have their timeouts reported as "safe to retry".
   */
  mutation?: boolean;
}

export interface FortnoxRateLimitOptions {
  /** Maximum number of requests admitted during one window. Defaults to 25. */
  limit?: number;
  /** Sliding-window duration in milliseconds. Defaults to 5000. */
  windowMs?: number;
}

export interface CreateFortnoxClientOptions {
  /** Supplies a valid access token for this client instance. */
  getAccessToken: () => Promise<string>;
  /** Optional fetch implementation, primarily for hosts and tests. */
  fetch?: typeof globalThis.fetch;
  /** Non-secret label used only to distinguish this client's errors. */
  contextLabel?: string | (() => string | undefined);
  /** Per-client Fortnox request budget. */
  rateLimit?: FortnoxRateLimitOptions;
}

export interface FortnoxTransport {
  request<T>(endpoint: string, options?: RequestOptions): Promise<T>;
  requestWithMetadata<T>(endpoint: string, options?: RequestOptions): Promise<FortnoxResponse<T>>;
  requestPdf(endpoint: string, options?: RequestOptions): Promise<Buffer>;
  requestPdfFromMutation(endpoint: string, options?: RequestOptions): Promise<Buffer | undefined>;
  fetchAllPages<T extends Record<string, unknown>>(
    endpoint: string,
    dataKey: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<{ items: T[]; totalResources: number }>;
}

interface ClientRuntime {
  getAccessToken: () => Promise<string>;
  fetch: typeof globalThis.fetch;
  waitForRateLimit: () => Promise<void>;
  getDiagnosticContext: () => { kind: 'context' | 'profile'; label: string } | undefined;
}

// Issue the HTTP request and translate a non-2xx answer into a FortnoxApiError.
// Returns the raw Response so callers can decide how to read the body.
async function sendRequest(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions,
  method: string,
  timeoutMs: number,
): Promise<Response> {
  await runtime.waitForRateLimit();

  const token = await runtime.getAccessToken();
  // The original REST API is rooted at /3, while newer product APIs are rooted
  // directly at /api. A leading slash deliberately selects the API root.
  const url = endpoint.startsWith('/')
    ? new URL(endpoint, API_ROOT_URL)
    : new URL(`${BASE_URL}/${endpoint}`);

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
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers[name] = value;
  }

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

  const response = await runtime.fetch(url.toString(), fetchOptions);

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
      runtime.getDiagnosticContext(),
    );
  }

  return response;
}

// Shared retry/timeout envelope; `readBody` turns a successful Response into T.
async function request<T>(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions,
  readBody: (response: Response) => Promise<T>,
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation =
    options.mutation ?? !(method === 'GET' || method === 'HEAD' || method === 'OPTIONS');
  const retryable = !isMutation;

  const timeoutMs = options.rawBody === undefined ? REQUEST_TIMEOUT_MS : UPLOAD_TIMEOUT_MS;

  try {
    return await retryWithBackoff(
      async () => readBody(await sendRequest(runtime, endpoint, options, method, timeoutMs)),
      retryable,
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new FortnoxRequestTimeoutError(method, endpoint, timeoutMs, isMutation);
    }
    throw err;
  }
}

async function requestJson<T>(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(runtime, endpoint, options, async (response) => {
    // Some endpoints return empty responses (e.g., DELETE)
    const text = await response.text();
    if (!text) return undefined as T;

    return JSON.parse(text) as T;
  });
}

/** JSON response together with the conditional metadata returned by newer APIs. */
export interface FortnoxResponse<T> {
  data: T;
  etag?: string;
  lastModified?: string;
}

async function requestWithMetadata<T>(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions = {},
): Promise<FortnoxResponse<T>> {
  return request<FortnoxResponse<T>>(runtime, endpoint, options, async (response) => {
    const text = await response.text();
    return {
      data: text ? (JSON.parse(text) as T) : (undefined as T),
      etag: response.headers?.get?.('etag') ?? undefined,
      lastModified: response.headers?.get?.('last-modified') ?? undefined,
    };
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

const PDF_MAGIC = '%PDF-';
const PDF_TRAILER = '%%EOF';

function startsWithPdfMagic(buf: Buffer): boolean {
  return buf.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC;
}

/**
 * A PDF that both starts with the magic number and carries its end-of-file
 * trailer, i.e. one that was not cut short in transit. Used where a *partial*
 * document would be worse than none — replacing an already-saved copy, say.
 * The trailer may be followed by whitespace, so search the tail rather than
 * requiring it at the very end.
 */
function isCompletePdf(buf: Buffer): boolean {
  if (!startsWithPdfMagic(buf)) return false;
  const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString('latin1');
  return tail.includes(PDF_TRAILER);
}

/** Fortnox can answer 2xx with an error envelope; detect one in a raw body. */
function fortnoxErrorInBody(buf: Buffer): { message: string; code?: number } | undefined {
  if (startsWithPdfMagic(buf)) return undefined;
  try {
    const parsed = JSON.parse(buf.toString('utf-8', 0, 4096)) as {
      ErrorInformation?: { message?: string; code?: number };
    };
    const info = parsed?.ErrorInformation;
    return info?.message ? { message: info.message, code: info.code } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a PDF from one of Fortnox's document endpoints. Shares rate limiting,
 * retries, timeouts and error mapping with `fortnoxRequest`.
 *
 * The returned bytes are validated by their magic number rather than by the
 * Content-Type header: Fortnox can answer 200 with a JSON error envelope, and a
 * proxy can return an HTML error page, either of which would otherwise be saved
 * as `invoice-1001.pdf` and look like success until someone opened the file.
 */
async function requestPdf(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions = {},
): Promise<Buffer> {
  return request<Buffer>(runtime, endpoint, options, async (response) => {
    const buf = Buffer.from(await response.arrayBuffer());

    if (!startsWithPdfMagic(buf)) {
      const contentType = response.headers?.get?.('content-type') || 'an unknown content type';
      throw new Error(
        `Fortnox returned ${contentType} that is not a PDF for ${endpoint}: ${describeUnexpectedBody(buf)}`,
      );
    }

    return buf;
  });
}

/**
 * For endpoints where the PDF is a by-product of a state change — Fortnox's
 * `/print` both returns the document and sets `Sent`.
 *
 * Once the server has answered 2xx the mutation has happened, so nothing about
 * the body may raise: a truncated or malformed payload is reported as "no PDF"
 * rather than as an error, because throwing here would turn a completed
 * accounting change into a reported failure. Always treated as a mutation, so
 * it is never auto-retried.
 */
async function requestPdfFromMutation(
  runtime: ClientRuntime,
  endpoint: string,
  options: RequestOptions = {},
): Promise<Buffer | undefined> {
  return request<Buffer | undefined>(
    runtime,
    endpoint,
    { ...options, mutation: true },
    async (response) => {
      let buf: Buffer;
      try {
        buf = Buffer.from(await response.arrayBuffer());
      } catch {
        // Body unreadable (truncated stream, aborted transfer). The status line
        // already said the action succeeded; report it as such.
        return undefined;
      }

      if (isCompletePdf(buf)) return buf;

      // A well-formed Fortnox error envelope is positive evidence that the action
      // did NOT happen — unlike an unreadable body, which is merely inconclusive.
      // Fortnox can send these with a 2xx status, so this has to be checked here
      // rather than left to the status code.
      const failure = fortnoxErrorInBody(buf);
      if (failure) {
        throw new FortnoxApiError(
          response.status,
          failure.message,
          `Error code: ${failure.code}`,
          endpoint,
          undefined,
          runtime.getDiagnosticContext(),
        );
      }

      // Something else came back — an incomplete PDF, or a payload we cannot
      // interpret. Inconclusive, so treat the action as done but offer no
      // document: callers must not overwrite a good file with this.
      return undefined;
    },
  );
}

/**
 * Fetch all pages of a paginated Fortnox list endpoint.
 * `dataKey` is the envelope key (e.g. "Invoices", "Customers").
 */
async function fetchPages<T extends Record<string, unknown>>(
  runtime: ClientRuntime,
  endpoint: string,
  dataKey: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ items: T[]; totalResources: number }> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;
  let totalResources = 0;

  do {
    const data = await requestJson<Record<string, unknown>>(runtime, endpoint, {
      params: { ...params, page, limit: 100 },
    });
    const items = (data[dataKey] as T[]) ?? [];
    all.push(...items);

    const meta = data.MetaInformation as
      { '@TotalPages': number; '@CurrentPage': number; '@TotalResources': number } | undefined;
    totalPages = meta?.['@TotalPages'] ?? 1;
    totalResources = meta?.['@TotalResources'] ?? all.length;
    page++;
  } while (page <= totalPages);

  return { items: all, totalResources };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function createRateLimiter(options: FortnoxRateLimitOptions = {}): () => Promise<void> {
  const limit = positiveInteger(options.limit ?? RATE_LIMIT, 'rateLimit.limit');
  const windowMs = positiveInteger(options.windowMs ?? RATE_WINDOW_MS, 'rateLimit.windowMs');
  const requestTimestamps: number[] = [];
  let tail: Promise<void> = Promise.resolve();

  return async () => {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      while (true) {
        const now = Date.now();
        while (requestTimestamps.length > 0 && requestTimestamps[0]! <= now - windowMs) {
          requestTimestamps.shift();
        }

        if (requestTimestamps.length < limit) {
          requestTimestamps.push(now);
          return;
        }

        const oldestInWindow = requestTimestamps[0]!;
        const waitMs = Math.max(1, oldestInWindow + windowMs - now + 50);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } finally {
      release();
    }
  };
}

function createFortnoxClientInternal(
  options: CreateFortnoxClientOptions,
  contextKind: 'context' | 'profile',
): FortnoxTransport {
  const fetchImpl =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const contextLabel = options.contextLabel;
  const contextProvider: () => string | undefined =
    typeof contextLabel === 'function' ? contextLabel : () => contextLabel;
  const runtime: ClientRuntime = {
    getAccessToken: options.getAccessToken,
    fetch: fetchImpl,
    waitForRateLimit: createRateLimiter(options.rateLimit),
    getDiagnosticContext: () => {
      try {
        const label = contextProvider();
        return label ? { kind: contextKind, label } : undefined;
      } catch {
        return undefined;
      }
    },
  };

  return Object.freeze({
    request<T>(endpoint: string, requestOptions: RequestOptions = {}): Promise<T> {
      return requestJson<T>(runtime, endpoint, requestOptions);
    },
    requestWithMetadata<T>(
      endpoint: string,
      requestOptions: RequestOptions = {},
    ): Promise<FortnoxResponse<T>> {
      return requestWithMetadata<T>(runtime, endpoint, requestOptions);
    },
    requestPdf(endpoint: string, requestOptions: RequestOptions = {}): Promise<Buffer> {
      return requestPdf(runtime, endpoint, requestOptions);
    },
    requestPdfFromMutation(
      endpoint: string,
      requestOptions: RequestOptions = {},
    ): Promise<Buffer | undefined> {
      return requestPdfFromMutation(runtime, endpoint, requestOptions);
    },
    fetchAllPages<T extends Record<string, unknown>>(
      endpoint: string,
      dataKey: string,
      params: Record<string, string | number | undefined> = {},
    ): Promise<{ items: T[]; totalResources: number }> {
      return fetchPages<T>(runtime, endpoint, dataKey, params);
    },
  });
}

/** Create an isolated Fortnox transport for one host-authorized context. */
export function createFortnoxClient(options: CreateFortnoxClientOptions): FortnoxTransport {
  return createFortnoxClientInternal(options, 'context');
}

const defaultClient = createFortnoxClientInternal(
  {
    getAccessToken: getValidToken,
    contextLabel: () => getResolvedProfile(),
  },
  'profile',
);

export async function fortnoxRequest<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  return defaultClient.request<T>(endpoint, options);
}

export async function fortnoxRequestWithMetadata<T>(
  endpoint: string,
  options: RequestOptions = {},
): Promise<FortnoxResponse<T>> {
  return defaultClient.requestWithMetadata<T>(endpoint, options);
}

export async function fortnoxRequestPdf(
  endpoint: string,
  options: RequestOptions = {},
): Promise<Buffer> {
  return defaultClient.requestPdf(endpoint, options);
}

export async function fortnoxRequestPdfFromMutation(
  endpoint: string,
  options: RequestOptions = {},
): Promise<Buffer | undefined> {
  return defaultClient.requestPdfFromMutation(endpoint, options);
}

export async function fetchAllPages<T extends Record<string, unknown>>(
  endpoint: string,
  dataKey: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ items: T[]; totalResources: number }> {
  return defaultClient.fetchAllPages<T>(endpoint, dataKey, params);
}
