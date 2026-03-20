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

describe('cost center operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listCostCenters', () => {
    it('passes page and limit params', async () => {
      mockFetch({ CostCenters: [], MetaInformation: {} });
      const { listCostCenters } = await import('../../src/operations/costcenters.js');

      await listCostCenters({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        CostCenters: [{ Code: 'CC1', Description: 'Avdelning A' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listCostCenters } = await import('../../src/operations/costcenters.js');

      const result = await listCostCenters();
      expect(result.CostCenters).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getCostCenter', () => {
    it('unwraps the CostCenter envelope', async () => {
      mockFetch({ CostCenter: { Code: 'CC1', Description: 'Avdelning A' } });
      const { getCostCenter } = await import('../../src/operations/costcenters.js');

      const result = await getCostCenter('CC1');
      expect(result.Code).toBe('CC1');
      expect(result.Description).toBe('Avdelning A');
    });

    it('encodes code in URL', async () => {
      mockFetch({ CostCenter: { Code: 'A/B', Description: 'Test' } });
      const { getCostCenter } = await import('../../src/operations/costcenters.js');

      await getCostCenter('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('costcenters/A%2FB');
    });
  });

  describe('createCostCenter', () => {
    it('wraps params in CostCenter envelope for POST', async () => {
      mockFetch({ CostCenter: { Code: 'CC2', Description: 'Ny avdelning' } });
      const { createCostCenter } = await import('../../src/operations/costcenters.js');

      await createCostCenter({ Code: 'CC2', Description: 'Ny avdelning' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.CostCenter.Code).toBe('CC2');
      expect(body.CostCenter.Description).toBe('Ny avdelning');
    });

    it('unwraps the response', async () => {
      mockFetch({ CostCenter: { Code: 'CC2', Description: 'Ny avdelning' } });
      const { createCostCenter } = await import('../../src/operations/costcenters.js');

      const result = await createCostCenter({ Code: 'CC2', Description: 'Ny avdelning' });
      expect(result.Code).toBe('CC2');
    });
  });

  describe('updateCostCenter', () => {
    it('uses PUT and excludes Code from body', async () => {
      mockFetch({ CostCenter: { Code: 'CC1', Description: 'Uppdaterad' } });
      const { updateCostCenter } = await import('../../src/operations/costcenters.js');

      await updateCostCenter('CC1', { Code: 'CC1', Description: 'Uppdaterad' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('costcenters/CC1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.CostCenter.Description).toBe('Uppdaterad');
      expect(body.CostCenter.Code).toBeUndefined();
    });
  });

  describe('deleteCostCenter', () => {
    it('sends DELETE request', async () => {
      mockFetch(undefined);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteCostCenter } = await import('../../src/operations/costcenters.js');

      await deleteCostCenter('CC1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('costcenters/CC1');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
