import { describe, it, expect, vi, afterEach } from 'vitest';
import { fortnoxRequest, FortnoxApiError } from '../src/fortnox-client.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

// Issue #95: a 403 hint that names the wrong scope sends people to the wrong
// checkbox in the Fortnox developer portal. Offers, orders and both payment
// families are scopes of their own — they are not covered by `invoice` or
// `supplierinvoice`.
describe('403 scope hints name the scope Fortnox actually checks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['invoices?limit=1', 'invoice'],
    ['invoicepayments?limit=1', 'payment'],
    ['supplierinvoices?limit=1', 'supplierinvoice'],
    ['supplierinvoicepayments?limit=1', 'payment'],
    ['offers?limit=1', 'offer'],
    ['orders?limit=1', 'order'],
    ['projects?limit=1', 'project'],
    ['costcenters?limit=1', 'costcenter'],
    ['pricelists?limit=1', 'price'],
    ['prices/a/b?limit=1', 'price'],
    ['financialyears', 'bookkeeping'],
    ['settings/lockedperiod', 'settings'],
    ['vouchers?limit=1', 'bookkeeping'],
    ['taxreductions?limit=1', 'invoice'],
  ])('%s -> %s', async (endpoint, scope) => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ ErrorInformation: { message: 'Forbidden', code: 0 } }),
    });

    try {
      await fortnoxRequest(endpoint);
      expect.unreachable();
    } catch (err) {
      expect((err as FortnoxApiError).hint).toContain(`Missing "${scope}" scope`);
    }
  });
});
