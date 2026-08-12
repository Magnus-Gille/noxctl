import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown, headers: Record<string, string> = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  });
}

function fetchCall(): [
  string,
  { method?: string; body?: string; headers?: Record<string, string> },
] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    { method?: string; body?: string; headers?: Record<string, string> },
  ];
}

const recurringId = '550e8400-e29b-41d4-a716-446655440000';

describe('recurring operations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the API-root recurring-billing endpoint and serializes list filters', async () => {
    mockFetch([]);
    const { listRecurrings } = await import('../../src/operations/recurrings.js');

    await listRecurrings({ customerNumbers: ['1', '2'], statuses: ['ACTIVE'] });

    const [url] = fetchCall();
    expect(url).toBe(
      'https://api.fortnox.se/api/recurring-billing/recurrings-v1?customer-numbers=1%2C2&statuses=ACTIVE',
    );
  });

  it('returns the ETag supplied by a recurring GET', async () => {
    mockFetch({ id: recurringId, serial_number: 4 }, { etag: '"recurring-v1"' });
    const { getRecurring } = await import('../../src/operations/recurrings.js');

    const result = await getRecurring(recurringId);

    expect(result.etag).toBe('"recurring-v1"');
    expect(result.recurring.serial_number).toBe(4);
  });

  it('requires and forwards If-Match when replacing a recurring', async () => {
    mockFetch({ id: recurringId }, { etag: '"recurring-v2"' });
    const { replaceRecurring } = await import('../../src/operations/recurrings.js');

    await replaceRecurring(recurringId, '"recurring-v1"', { status: 'ACTIVE' });

    const [url, init] = fetchCall();
    expect(url).toContain(`/recurrings-v1/${recurringId}`);
    expect(init.method).toBe('PUT');
    expect(init.headers?.['If-Match']).toBe('"recurring-v1"');
    expect(JSON.parse(init.body!)).toEqual({ status: 'ACTIVE' });
  });

  it('posts invoice requests with the requested processing mode', async () => {
    mockFetch({ id: 'request-id', status: 'PENDING' });
    const { createInvoiceRequest } = await import('../../src/operations/recurrings.js');

    await createInvoiceRequest([recurringId], 'ASYNC');

    const [url, init] = fetchCall();
    expect(url).toContain('recurrings-invoice-requests-v1?processing-mode=ASYNC');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body!)).toEqual({ recurring_ids: [recurringId] });
  });

  it('rejects synchronous invoice batches larger than 100 before making a request', async () => {
    mockFetch({});
    const { createInvoiceRequest } = await import('../../src/operations/recurrings.js');

    await expect(
      createInvoiceRequest(Array.from({ length: 101 }, () => recurringId)),
    ).rejects.toThrow('Use ASYNC');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
