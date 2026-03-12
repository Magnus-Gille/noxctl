import { describe, it, expect, vi, afterEach } from 'vitest';
import { fortnoxRequest, FortnoxApiError } from '../src/fortnox-client.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

describe('fortnox-client', () => {
  afterEach(() => {
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
});
