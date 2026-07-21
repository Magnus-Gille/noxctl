import { describe, it, expect, vi, afterEach } from 'vitest';
import { fortnoxRequest, fortnoxRequestPdf, FortnoxApiError } from '../src/fortnox-client.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

const PDF_BYTES = Buffer.from('%PDF-1.4\nbinary\x00\x01bytes');

function mockPdfResponse(bytes: Buffer = PDF_BYTES, contentType = 'application/pdf') {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
}

// Kept in its own file: the client's 25-requests-per-5-seconds rate limiter is
// module-level state, and vitest gives each test file a fresh module registry.
// Piling these onto fortnox-client.test.ts pushed that file over the limit and
// made unrelated tests block on the limiter.
describe('fortnox-client: PDF and mutation-classified requests', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fortnox exposes some state-changing actions as GET (e.g. /invoices/{n}/print
  // sets Sent=true), so the HTTP verb alone cannot decide retry safety.
  describe('mutation option overriding the verb-derived classification', () => {
    it('does not retry a GET that is flagged as a mutation', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
      });

      await expect(fortnoxRequest('invoices/1/print', { mutation: true })).rejects.toThrow(
        FortnoxApiError,
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('still retries an ordinary GET', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers(),
          json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
        })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('{"ok":true}') });

      await expect(fortnoxRequest('invoices/1/preview')).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('reports a flagged GET timeout as an unknown outcome, not "safe to retry"', async () => {
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

      const request = fortnoxRequest('invoices/1/print', { mutation: true });
      const rejection = expect(request).rejects.toMatchObject({
        name: 'FortnoxRequestTimeoutError',
        outcomeUnknown: true,
      });

      controller.abort(new DOMException('request timed out', 'TimeoutError'));
      await rejection;
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fortnoxRequestPdf', () => {
    it('returns the raw bytes unmodified', async () => {
      mockPdfResponse();

      const result = await fortnoxRequestPdf('invoices/1001/preview');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.equals(PDF_BYTES)).toBe(true);
    });

    it('requests Accept: application/json — Fortnox rejects application/pdf with error 1000030', async () => {
      mockPdfResponse();

      await fortnoxRequestPdf('invoices/1001/preview');

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

      await expect(fortnoxRequestPdf('invoices/999999/preview')).rejects.toThrow(
        /Can not find invoice/,
      );
    });

    it('rejects a 200 that is not a PDF instead of writing an error page to disk', async () => {
      const errorEnvelope = Buffer.from(
        JSON.stringify({ ErrorInformation: { message: 'Invalid response type', code: 1000030 } }),
      );
      mockPdfResponse(errorEnvelope, 'application/json');

      await expect(fortnoxRequestPdf('invoices/1001/preview')).rejects.toThrow(
        /Invalid response type/,
      );
    });

    // The content-type header is not evidence: validate the actual bytes, so a
    // mislabelled error page can never be saved under a .pdf name.
    it('rejects a non-PDF body even when it is labelled application/pdf', async () => {
      const errorEnvelope = Buffer.from(
        JSON.stringify({ ErrorInformation: { message: 'Invalid response type', code: 1000030 } }),
      );
      mockPdfResponse(errorEnvelope, 'application/pdf');

      await expect(fortnoxRequestPdf('invoices/1001/preview')).rejects.toThrow(
        /Invalid response type/,
      );
    });

    it('rejects an HTML error page served as application/octet-stream', async () => {
      mockPdfResponse(
        Buffer.from('<html><body>502 Bad Gateway</body></html>'),
        'application/octet-stream',
      );

      await expect(fortnoxRequestPdf('invoices/1001/preview')).rejects.toThrow(/not a PDF/i);
    });

    it('accepts real PDF bytes regardless of an unhelpful content-type', async () => {
      mockPdfResponse(PDF_BYTES, 'application/octet-stream');

      const result = await fortnoxRequestPdf('invoices/1001/preview');
      expect(result.equals(PDF_BYTES)).toBe(true);
    });

    it('retries a transient 500 on the non-mutating preview endpoint', async () => {
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
              PDF_BYTES.buffer.slice(
                PDF_BYTES.byteOffset,
                PDF_BYTES.byteOffset + PDF_BYTES.byteLength,
              ),
            ),
        });

      const result = await fortnoxRequestPdf('invoices/1001/preview');

      expect(result.equals(PDF_BYTES)).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
