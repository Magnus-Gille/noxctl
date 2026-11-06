/**
 * Unpublished pilot host (NOX-214): a deliberately narrow Accounted HTTP client.
 * Only the request shapes the shadow adapters need are allowed: GET plus POST to the customers
 * and invoices collections of ONE configured company. Everything else is refused before any I/O.
 */
import { TargetNotDispatchedError } from '../shadow/types.js';
import type {
  AccountedRequest,
  AccountedRequestCallback,
  AccountedResponse,
} from '../shadow/accounted-adapter.js';

/**
 * A request outside the pilot policy was attempted. Thrown before any network I/O. It is NOT a
 * TargetNotDispatchedError: the queue therefore records `target_unknown`, which stops the pilot
 * loudly instead of scheduling a retry of something that must never be sent. It can never be applied.
 */
export class PilotPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PilotPolicyError';
  }
}

/**
 * Provably nothing was sent: key retrieval failed, or the pre-POST company check failed or
 * mismatched. Queue semantics: `retry_wait` (the pilot gate still refuses until the operator looks).
 */
export class PilotNotDispatchedError extends TargetNotDispatchedError {
  constructor(readonly reason: string) {
    super();
    this.message = `Target not dispatched: ${reason}`;
  }
}

export interface AccountedClientOptions {
  /** Exactly `https://host[:port]`. */
  origin: string;
  companyId: string;
  /** Called for every HTTP request; the key is never stored, logged or put in errors. */
  apiKey: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const MAX_BODY_CHARS = 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeFailure(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(error.name) ? error.name : 'Error';
  const code =
    (error as { cause?: { code?: unknown }; code?: unknown } | undefined)?.cause?.code ??
    (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? `${name}/${code}` : name;
}

export function createAccountedClient(options: AccountedClientOptions): AccountedRequestCallback {
  const origin = options.origin;
  if (typeof origin !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(origin))
    throw new PilotPolicyError('Accounted origin must be exactly https://host[:port]');
  const companyId = options.companyId;
  if (typeof companyId !== 'string' || !UUID.test(companyId))
    throw new PilotPolicyError('Accounted company id must be a UUID');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new PilotPolicyError('Invalid Accounted timeout');
  if (typeof options.apiKey !== 'function') throw new PilotPolicyError('apiKey provider required');
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const company = escapeRegExp(companyId);
  const allowedGet = [
    /^\/api\/v1\/companies$/,
    new RegExp(
      `^/api/v1/companies/${company}/(customers|invoices)/${UUID_SOURCE}(\\?expand=items)?$`,
      'i',
    ),
    new RegExp(`^/api/v1/companies/${company}/articles\\?include_inactive=true$`),
  ];
  const allowedPost = [new RegExp(`^/api/v1/companies/${company}/(customers|invoices)$`)];

  function assertAllowed(request: AccountedRequest): void {
    const { method, path } = request;
    const list = method === 'GET' ? allowedGet : method === 'POST' ? allowedPost : undefined;
    if (typeof path !== 'string' || !list || !list.some((pattern) => pattern.test(path)))
      throw new PilotPolicyError(`Request outside the pilot allowlist (${String(method)})`);
    if (method === 'GET' && request.body !== undefined)
      throw new PilotPolicyError('GET requests carry no body');
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    idempotencyKey: string | undefined,
    notDispatchedOnKeyFailure: boolean,
  ): Promise<AccountedResponse> {
    let key: string;
    try {
      key = await apiKey();
      if (typeof key !== 'string' || !key || /[\u0000- \u007f]/.test(key))
        throw new Error('invalid key');
    } catch {
      if (notDispatchedOnKeyFailure) throw new PilotNotDispatchedError('API key unavailable');
      throw new Error('Accounted API key unavailable');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    };
    let payload: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
      if (payload.length > MAX_BODY_CHARS) throw new PilotPolicyError('Request body too large');
      if (idempotencyKey !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(idempotencyKey))
          throw new PilotPolicyError('Invalid idempotency key');
        headers['Idempotency-Key'] = idempotencyKey;
      }
    }
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(origin + path, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = response.status >= 300 && response.status < 400 ? '' : await response.text();
    } catch (error) {
      // Never forward the original error: it may carry request headers. Name and code only.
      throw new Error(`Accounted ${method} request failed (${safeFailure(error)})`);
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error(`Accounted ${method} returned redirect HTTP ${response.status}`);
    if (text.length > MAX_RESPONSE_CHARS) throw new Error('Accounted response too large');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Accounted ${method} response was not JSON (HTTP ${response.status})`);
    }
    return { status: response.status, json };
  }

  /** Exactly one company, exactly the configured one, and no further pages. */
  async function checkCompany(): Promise<void> {
    let response: AccountedResponse;
    try {
      response = await send('GET', '/api/v1/companies', undefined, undefined, true);
    } catch (error) {
      if (error instanceof PilotNotDispatchedError) throw error;
      throw new PilotNotDispatchedError('company check request failed');
    }
    const body = response.json as { data?: unknown; meta?: { next_cursor?: unknown } } | null;
    const list = body && typeof body === 'object' ? body.data : undefined;
    const next = body && typeof body === 'object' ? body.meta?.next_cursor : undefined;
    if (
      response.status !== 200 ||
      !Array.isArray(list) ||
      list.length !== 1 ||
      (list[0] as { id?: unknown } | null)?.id !== companyId ||
      (next !== undefined && next !== null)
    )
      throw new PilotNotDispatchedError('API key does not see exactly the configured company');
  }

  return async (request) => {
    assertAllowed(request);
    if (request.method === 'POST') {
      await checkCompany();
      return send('POST', request.path, request.body, request.idempotencyKey, true);
    }
    return send('GET', request.path, undefined, undefined, false);
  };
}
