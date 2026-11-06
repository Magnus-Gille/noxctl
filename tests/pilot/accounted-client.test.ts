import { describe, expect, it, vi } from 'vitest';
import {
  createAccountedClient,
  PilotNotDispatchedError,
  PilotPolicyError,
} from '../../src/pilot/accounted-client.js';
import { AccountedShadowAdapter } from '../../src/shadow/accounted-adapter.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { TargetNotDispatchedError } from '../../src/shadow/types.js';
import { binding, sourceCustomer, useTempDirs } from '../shadow/baseline-helpers.js';
import { API_KEY, COMPANY, ORIGIN, fakeAccounted } from './helpers.js';

const base = `/api/v1/companies/${COMPANY}`;
const CUSTOMER = '00000000-0000-4000-8000-000000000999';
const directory = useTempDirs();

function client(
  fake = fakeAccounted(),
  extra: Partial<Parameters<typeof createAccountedClient>[0]> = {},
) {
  return {
    fake,
    request: createAccountedClient({
      origin: ORIGIN,
      companyId: COMPANY,
      apiKey: async () => API_KEY,
      fetchImpl: fake.fetchImpl,
      timeoutMs: 200,
      ...extra,
    }),
  };
}

describe('origin and allowlist', () => {
  it.each([
    'http://a.test',
    'https://a.test/x',
    'https://u:p@a.test',
    'https://a.test?q=1',
    'https://a.test/',
    'a.test',
  ])('rejects origin %s', (origin) => {
    expect(() =>
      createAccountedClient({ origin, companyId: COMPANY, apiKey: async () => 'k' }),
    ).toThrow(PilotPolicyError);
  });
  it('accepts origin with port', () => {
    expect(() =>
      createAccountedClient({
        origin: 'https://a.test:8443',
        companyId: COMPANY,
        apiKey: async () => 'k',
      }),
    ).not.toThrow();
  });

  const other = '99999999-9999-4999-8999-999999999999';
  it.each([
    ['DELETE', `${base}/customers/${CUSTOMER}`],
    ['PATCH', `${base}/customers/${CUSTOMER}`],
    ['PUT', `${base}/invoices/${CUSTOMER}`],
    ['POST', `${base}/invoices/${CUSTOMER}/mark-sent`],
    ['POST', `${base}/invoices/${CUSTOMER}/mark-paid`],
    ['POST', `${base}/invoices/${CUSTOMER}/send`],
    ['POST', `${base}/invoices/${CUSTOMER}/book`],
    ['POST', `/api/v1/companies/${other}/customers`],
    ['GET', `/api/v1/companies/${other}/customers/${CUSTOMER}`],
    ['GET', `${base}/customers/${CUSTOMER}?foo=bar`],
    ['GET', `${base}/customers/${CUSTOMER}?expand=items&x=1`],
    ['GET', `${base}/articles`],
    ['GET', `${base}/articles?include_inactive=true&x=1`],
    ['GET', `${base}/customers/../x`],
    ['GET', `/api/v1/companies?x=1`],
    ['GET', `${base}/customers`],
    ['POST', `${base}/customers?dry_run=false`],
    ['POST', `${base}/articles`],
    ['GET', `https://evil.test/api/v1/companies`],
    ['GET', `//evil.test/api/v1/companies`],
    ['POST', `/api/v1/companies`],
  ])('refuses %s %s with zero network calls', async (method, path) => {
    const { fake, request } = client();
    const error = await request({ method: method as 'GET', path, body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(PilotPolicyError);
    expect(error).not.toBeInstanceOf(TargetNotDispatchedError);
    expect(fake.calls).toEqual([]);
  });
});

describe('transport behaviour', () => {
  it('sends bearer key per request, manual redirect, idempotency key on POST only', async () => {
    const apiKey = vi.fn(async () => API_KEY);
    const { fake, request } = client(fakeAccounted(), { apiKey });
    const created = await request({
      method: 'POST',
      path: `${base}/customers`,
      body: { name: 'x' },
      idempotencyKey: 'shadow_abc',
    });
    expect(created.status).toBe(201);
    expect(fake.calls.map((c) => `${c.method} ${c.url.slice(ORIGIN.length)}`)).toEqual([
      'GET /api/v1/companies',
      `POST ${base}/customers`,
    ]);
    for (const call of fake.calls) {
      expect(call.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(call.redirect).toBe('manual');
    }
    expect(fake.calls[0]!.headers['Idempotency-Key']).toBeUndefined();
    expect(fake.calls[1]!.headers['Idempotency-Key']).toBe('shadow_abc');
    expect(apiKey).toHaveBeenCalledTimes(2);
  });

  it('treats any 3xx as an error', async () => {
    const { request } = client(fakeAccounted({ redirect: true }));
    await expect(request({ method: 'GET', path: '/api/v1/companies' })).rejects.toThrow(
      /redirect/i,
    );
  });

  it('rejects a non-JSON body as an ordinary (post-dispatch) error', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    const { request } = client(fakeAccounted(), { fetchImpl });
    const error = await request({ method: 'GET', path: '/api/v1/companies' }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TargetNotDispatchedError);
  });

  it.each([
    ['no company', []],
    ['two companies', [{ id: COMPANY }, { id: '99999999-9999-4999-8999-999999999999' }]],
    ['other company', [{ id: '99999999-9999-4999-8999-999999999999' }]],
    ['malformed', 'nope'],
  ])('sends no POST when the pre-check sees %s', async (_label, companies) => {
    const { fake, request } = client(fakeAccounted({ companies: companies as unknown[] }));
    const error = await request({ method: 'POST', path: `${base}/customers`, body: {} }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(PilotNotDispatchedError);
    expect(error).toBeInstanceOf(TargetNotDispatchedError);
    expect(fake.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('refuses a paginated company list', async () => {
    const { fake, request } = client(fakeAccounted({ nextCursor: 'more' }));
    await expect(
      request({ method: 'POST', path: `${base}/customers`, body: {} }),
    ).rejects.toBeInstanceOf(PilotNotDispatchedError);
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('key retrieval failure is not dispatched and sends nothing', async () => {
    const { fake, request } = client(fakeAccounted(), {
      apiKey: async () => {
        throw new Error('keychain locked');
      },
    });
    await expect(
      request({ method: 'POST', path: `${base}/customers`, body: {} }),
    ).rejects.toBeInstanceOf(PilotNotDispatchedError);
    expect(fake.calls).toEqual([]);
  });

  it('never leaks the key into errors, even from a fetch that echoes it', async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      if (String(_u).endsWith('/api/v1/companies'))
        return new Response(
          JSON.stringify({ data: [{ id: COMPANY }], meta: { next_cursor: null } }),
        );
      throw new Error(`boom ${JSON.stringify(init?.headers)}`);
    }) as typeof fetch;
    const { request } = client(fakeAccounted(), { fetchImpl });
    const error = await request({ method: 'POST', path: `${base}/customers`, body: {} }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TargetNotDispatchedError);
    expect(JSON.stringify(error) + String(error.message) + String(error.stack)).not.toContain(
      API_KEY,
    );
    expect(error.cause).toBeUndefined();
  });

  it('a POST timeout becomes target_unknown through the queue and leaks no key', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      { id: 'baseline-c', operation: 'baselineCustomer', args: [{ CustomerNumber: '7' }] },
      async () => sourceCustomer,
    );
    const fake = fakeAccounted({ postHangs: true });
    const { request } = client(fake);
    const adapter = new AccountedShadowAdapter(COMPANY, request);
    // The shadow binding in the helpers uses the same target company.
    expect(binding.targetCompany).toBe(COMPANY);
    expect(await queue.drainOne(adapter)).toBe(false);
    const record = queue.get('baseline-c')!;
    expect(record.state).toBe('target_unknown');
    expect(JSON.stringify(record)).not.toContain(API_KEY);
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // Never retried automatically.
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(fake.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    queue.close();
  });

  it('a pre-POST company mismatch leaves the record retry_wait, not applied or unknown', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      { id: 'baseline-c', operation: 'baselineCustomer', args: [{ CustomerNumber: '7' }] },
      async () => sourceCustomer,
    );
    const fake = fakeAccounted({ companies: [] });
    const adapter = new AccountedShadowAdapter(COMPANY, client(fake).request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('baseline-c')!.state).toBe('retry_wait');
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
    queue.close();
  });
});
