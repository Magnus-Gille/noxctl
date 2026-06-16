import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

function calledUrl(): string {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

function fetchCall(): [string, { method?: string; body?: string }] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    { method?: string; body?: string },
  ];
}

describe('contract operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listContracts', () => {
    it('passes the filter query param', async () => {
      mockFetch({ Contracts: [], MetaInformation: {} });
      const { listContracts } = await import('../../src/operations/contracts.js');

      await listContracts({ filter: 'active' });

      expect(calledUrl()).toContain('contracts');
      expect(calledUrl()).toContain('filter=active');
    });
  });

  describe('getContract', () => {
    it('unwraps the Contract envelope', async () => {
      mockFetch({ Contract: { DocumentNumber: '1', CustomerNumber: '25' } });
      const { getContract } = await import('../../src/operations/contracts.js');

      const result = await getContract('1');
      expect(result.DocumentNumber).toBe('1');
    });

    it('rejects path traversal in document numbers', async () => {
      mockFetch({ Contract: {} });
      const { getContract } = await import('../../src/operations/contracts.js');

      await expect(getContract('../companyinformation')).rejects.toThrow();
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('createContract', () => {
    it('wraps params in Contract envelope for POST', async () => {
      mockFetch({ Contract: { DocumentNumber: '2' } });
      const { createContract } = await import('../../src/operations/contracts.js');

      await createContract({ CustomerNumber: '25', InvoiceInterval: 3 });

      const [, init] = fetchCall();
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body!) as { Contract: Record<string, unknown> };
      expect(body.Contract.CustomerNumber).toBe('25');
    });
  });

  describe('updateContract', () => {
    it('uses PUT against the document number', async () => {
      mockFetch({ Contract: { DocumentNumber: '1' } });
      const { updateContract } = await import('../../src/operations/contracts.js');

      await updateContract('1', { Comments: 'Updated' });

      const [url, init] = fetchCall();
      expect(url).toContain('contracts/1');
      expect(init.method).toBe('PUT');
    });
  });

  describe('contract actions', () => {
    it('finishContract PUTs to /finish', async () => {
      mockFetch({ Contract: { DocumentNumber: '1' } });
      const { finishContract } = await import('../../src/operations/contracts.js');

      await finishContract('1');

      const [url, init] = fetchCall();
      expect(url).toContain('contracts/1/finish');
      expect(init.method).toBe('PUT');
    });

    it('createInvoiceFromContract PUTs to /createinvoice and unwraps Invoice', async () => {
      mockFetch({ Invoice: { DocumentNumber: '99' } });
      const { createInvoiceFromContract } = await import('../../src/operations/contracts.js');

      const result = await createInvoiceFromContract('1');

      const [url, init] = fetchCall();
      expect(url).toContain('contracts/1/createinvoice');
      expect(init.method).toBe('PUT');
      expect(result.DocumentNumber).toBe('99');
    });

    it('increaseInvoiceCount PUTs to /increaseinvoicecount', async () => {
      mockFetch({ Contract: { DocumentNumber: '1', InvoicesRemaining: 5 } });
      const { increaseInvoiceCount } = await import('../../src/operations/contracts.js');

      await increaseInvoiceCount('1');

      const [url, init] = fetchCall();
      expect(url).toContain('contracts/1/increaseinvoicecount');
      expect(init.method).toBe('PUT');
    });
  });
});
