import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createFortnoxClient,
  fortnoxRequest,
  FortnoxApiError,
  FortnoxRequestTimeoutError,
} from '../src/fortnox-client.js';
import { getResolvedProfile } from '../src/auth.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

describe('fortnox-client', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('makes a GET request with correct headers', async () => {
    const mockData = { Customer: { Name: 'Test' } };
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(mockData)),
    });

    const result = await fortnoxRequest('customers/1');
    expect(result).toEqual(mockData);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/customers/1',
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('appends query params', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"Customers": []}'),
    });

    await fortnoxRequest('customers', { params: { page: 2, limit: 50 } });

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('limit=50');
  });

  it('skips undefined params', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
    });

    await fortnoxRequest('customers', { params: { page: 1, filter: undefined } });

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).not.toContain('filter');
  });

  it('makes a POST request with body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{"Customer": {"Name": "New"}}'),
    });

    await fortnoxRequest('customers', {
      method: 'POST',
      body: { Customer: { Name: 'New' } },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ Customer: { Name: 'New' } }),
      }),
    );
  });

  it('throws FortnoxApiError on error response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          ErrorInformation: { message: 'Customer not found', code: 2000428 },
        }),
    });

    await expect(fortnoxRequest('customers/999999')).rejects.toThrow(FortnoxApiError);
    await expect(fortnoxRequest('customers/999999')).rejects.toThrow(/Customer not found/);
  });

  it('handles empty response body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    });

    const result = await fortnoxRequest('invoices/1/bookkeep', { method: 'PUT' });
    expect(result).toBeUndefined();
  });

  it('retries on 429 rate limit', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Rate limited', code: 0 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"ok": true}'),
      });

    const result = await fortnoxRequest('customers');
    expect(result).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-idempotent POST requests', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ ErrorInformation: { message: 'Rate limited', code: 0 } }),
    });

    await expect(
      fortnoxRequest('customers', {
        method: 'POST',
        body: { Customer: { Name: 'New' } },
      }),
    ).rejects.toThrow(FortnoxApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a GET when Node fetch reports a transient error in its cause', async () => {
    const transient = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"ok": true}'),
      });

    await expect(fortnoxRequest('customers')).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('caps Retry-After before retrying a read request', async () => {
    vi.useFakeTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '120' },
        json: () => Promise.resolve({ ErrorInformation: { message: 'Rate limited', code: 0 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"ok": true}'),
      });

    const request = fortnoxRequest('customers');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds mutation requests and marks a timeout outcome as unknown', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const request = fortnoxRequest('customers', {
      method: 'POST',
      body: { Customer: { Name: 'Acme AB' } },
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: 'FortnoxRequestTimeoutError',
      outcomeUnknown: true,
    } satisfies Partial<FortnoxRequestTimeoutError>);

    controller.abort(new DOMException('request timed out', 'TimeoutError'));
    await rejection;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('error hints', () => {
    it('includes scope hint for 403 on a known endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Forbidden', code: 0 } }),
      });

      try {
        await fortnoxRequest('invoices?limit=1');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FortnoxApiError);
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('invoice');
        expect(e.message).toContain('Hint:');
      }
    });

    it('includes scope hint for 403 on the SIE export endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Forbidden', code: 0 } }),
      });

      try {
        await fortnoxRequest('sie/4');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(FortnoxApiError);
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('bookkeeping');
      }
    });

    it('includes auth hint for 401', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Unauthorized', code: 0 } }),
      });

      try {
        await fortnoxRequest('customers');
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('noxctl init');
      }
    });

    it('includes not-found hint for 404', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Not found', code: 2000428 } }),
      });

      try {
        await fortnoxRequest('customers/999');
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('not found');
      }
    });

    it('includes employment-agreement hint when employee create fails on ftgavtalid', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            ErrorInformation: { message: 'Värdet kan inte vara null. (ftgavtalid)', code: 0 },
          }),
      });

      try {
        await fortnoxRequest('employees', { method: 'POST', body: { Employee: {} } });
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('EmploymentForm');
        expect(e.message).toContain('Hint:');
      }
    });

    it('includes server error hint for 500', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Internal error', code: 0 } }),
      });

      try {
        await fortnoxRequest('customers');
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.hint).toContain('server error');
      }
    });
  });

  describe('profile tagging', () => {
    afterEach(() => {
      vi.mocked(getResolvedProfile).mockReturnValue('default');
    });

    it('prefixes the error message with [profile: <name>] when non-default', async () => {
      vi.mocked(getResolvedProfile).mockReturnValue('staging');
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
      });

      try {
        await fortnoxRequest('customers');
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.message.startsWith('[profile: staging]')).toBe(true);
      }
    });

    it('omits the profile prefix for the default profile', async () => {
      vi.mocked(getResolvedProfile).mockReturnValue('default');
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
      });

      try {
        await fortnoxRequest('customers');
        expect.unreachable();
      } catch (err) {
        const e = err as FortnoxApiError;
        expect(e.message).not.toContain('[profile:');
      }
    });
  });

  it('sends a raw (FormData) body without a JSON Content-Type so fetch sets the multipart boundary', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ File: { Id: 'x' } })),
    });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('data')]), 'r.pdf');

    await fortnoxRequest('inbox', { method: 'POST', rawBody: form });

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer mock-token');
  });
});

describe('createFortnoxClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps concurrent tenant tokens bound to their own client', async () => {
    const fetchA = vi.fn().mockResolvedValue(new Response('{"CompanyInformation":{"Name":"A"}}'));
    const fetchB = vi.fn().mockResolvedValue(new Response('{"CompanyInformation":{"Name":"B"}}'));
    const clientA = createFortnoxClient({
      getAccessToken: async () => 'tenant-a-token',
      fetch: fetchA,
      contextLabel: 'tenant-a',
    });
    const clientB = createFortnoxClient({
      getAccessToken: async () => 'tenant-b-token',
      fetch: fetchB,
      contextLabel: 'tenant-b',
    });

    await Promise.all([
      clientA.request('companyinformation'),
      clientB.request('companyinformation'),
    ]);

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(fetchA).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/companyinformation',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-a-token' }),
      }),
    );
    expect(fetchB).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/companyinformation',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-b-token' }),
      }),
    );
  });

  it('keeps diagnostic error context isolated between clients', async () => {
    const errorResponse = (message: string) =>
      new Response(JSON.stringify({ ErrorInformation: { message, code: 0 } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    const clientA = createFortnoxClient({
      getAccessToken: async () => 'tenant-a-token',
      fetch: vi.fn().mockResolvedValue(errorResponse('failure-a')),
      contextLabel: 'tenant-a',
    });
    const clientB = createFortnoxClient({
      getAccessToken: async () => 'tenant-b-token',
      fetch: vi.fn().mockResolvedValue(errorResponse('failure-b')),
      contextLabel: 'tenant-b',
    });

    const [resultA, resultB] = await Promise.allSettled([
      clientA.request('companyinformation', { mutation: true }),
      clientB.request('companyinformation', { mutation: true }),
    ]);

    expect(resultA.status).toBe('rejected');
    expect(resultB.status).toBe('rejected');
    if (resultA.status !== 'rejected' || resultB.status !== 'rejected') expect.unreachable();
    expect(resultA.reason).toBeInstanceOf(FortnoxApiError);
    expect(resultB.reason).toBeInstanceOf(FortnoxApiError);
    expect((resultA.reason as Error).message).toContain('[context: tenant-a]');
    expect((resultA.reason as Error).message).not.toContain('tenant-b');
    expect((resultA.reason as Error).message).not.toContain('tenant-a-token');
    expect((resultB.reason as Error).message).toContain('[context: tenant-b]');
    expect((resultB.reason as Error).message).not.toContain('tenant-a');
    expect((resultB.reason as Error).message).not.toContain('tenant-b-token');
  });

  it('keeps rate-limit queues isolated between clients', async () => {
    vi.useFakeTimers();
    const fetchA = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    const fetchB = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    const rateLimit = { limit: 1, windowMs: 1_000 };
    const clientA = createFortnoxClient({
      getAccessToken: async () => 'tenant-a-token',
      fetch: fetchA,
      rateLimit,
    });
    const clientB = createFortnoxClient({
      getAccessToken: async () => 'tenant-b-token',
      fetch: fetchB,
      rateLimit,
    });

    const firstA = clientA.request('customers/1');
    const secondA = clientA.request('customers/2');
    const firstB = clientB.request('customers/1');

    await Promise.all([firstA, firstB]);
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_050);
    await secondA;
    expect(fetchA).toHaveBeenCalledTimes(2);
  });

  it('exposes metadata, PDF, mutation-PDF, and pagination through the instance', async () => {
    const previewPdf = Buffer.from('%PDF-preview');
    const printedPdf = Buffer.from('%PDF-printed\n%%EOF');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"Recurring":{"DocumentNumber":1}}', {
          headers: { etag: 'revision-1', 'last-modified': 'today' },
        }),
      )
      .mockResolvedValueOnce(new Response(previewPdf))
      .mockResolvedValueOnce(new Response(printedPdf))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            Customers: [{ CustomerNumber: '1' }],
            MetaInformation: {
              '@TotalPages': 1,
              '@CurrentPage': 1,
              '@TotalResources': 1,
            },
          }),
        ),
      );
    const client = createFortnoxClient({
      getAccessToken: async () => 'tenant-token',
      fetch,
    });

    await expect(client.requestWithMetadata('recurrings/1')).resolves.toMatchObject({
      data: { Recurring: { DocumentNumber: 1 } },
      etag: 'revision-1',
      lastModified: 'today',
    });
    await expect(client.requestPdf('invoices/1/preview')).resolves.toEqual(previewPdf);
    await expect(client.requestPdfFromMutation('invoices/1/print')).resolves.toEqual(printedPdf);
    await expect(client.fetchAllPages('customers', 'Customers')).resolves.toEqual({
      items: [{ CustomerNumber: '1' }],
      totalResources: 1,
    });
  });

  it('rejects invalid per-client rate-limit configuration', () => {
    expect(() =>
      createFortnoxClient({
        getAccessToken: async () => 'tenant-token',
        rateLimit: { limit: 0 },
      }),
    ).toThrow('rateLimit.limit must be a positive integer');
  });
});
