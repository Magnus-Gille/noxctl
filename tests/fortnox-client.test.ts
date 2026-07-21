import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fortnoxRequest,
  fortnoxRequestBinary,
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

  describe('fortnoxRequestBinary', () => {
    const PDF_BYTES = Buffer.from('%PDF-1.4\nbinary\x00\x01bytes');

    function mockPdfResponse(bytes: Buffer = PDF_BYTES, contentType = 'application/pdf') {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': contentType }),
        arrayBuffer: () =>
          Promise.resolve(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          ),
      });
    }

    it('returns the raw bytes unmodified', async () => {
      mockPdfResponse();

      const result = await fortnoxRequestBinary('invoices/1001/preview');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.equals(PDF_BYTES)).toBe(true);
    });

    it('requests Accept: application/json — Fortnox rejects application/pdf with error 1000030', async () => {
      mockPdfResponse();

      await fortnoxRequestBinary('invoices/1001/preview');

      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Accept).toBe('application/json');
      expect(headers.Authorization).toBe('Bearer mock-token');
    });

    it('raises a FortnoxApiError when Fortnox answers with a JSON error envelope', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({ ErrorInformation: { message: 'Can not find invoice', code: 2000428 } }),
      });

      await expect(fortnoxRequestBinary('invoices/999999/preview')).rejects.toThrow(
        /Can not find invoice/,
      );
    });

    it('rejects a 200 that is not a PDF instead of writing an error page to disk', async () => {
      const errorEnvelope = Buffer.from(
        JSON.stringify({ ErrorInformation: { message: 'Invalid response type', code: 1000030 } }),
      );
      mockPdfResponse(errorEnvelope, 'application/json');

      await expect(fortnoxRequestBinary('invoices/1001/preview')).rejects.toThrow(
        /Invalid response type/,
      );
    });

    it('retries a transient 500 and returns the bytes from the successful attempt', async () => {
      const pdfBody = PDF_BYTES;
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ ErrorInformation: { message: 'boom', code: 1 } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/pdf' }),
          arrayBuffer: () =>
            Promise.resolve(
              pdfBody.buffer.slice(pdfBody.byteOffset, pdfBody.byteOffset + pdfBody.byteLength),
            ),
        });

      const result = await fortnoxRequestBinary('invoices/1001/preview');

      expect(result.equals(PDF_BYTES)).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
