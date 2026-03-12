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

describe('company operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCompanyInfo', () => {
    it('unwraps CompanyInformation envelope', async () => {
      mockFetch({
        CompanyInformation: { CompanyName: 'Test AB', OrganizationNumber: '556677-8899' },
      });
      const { getCompanyInfo } = await import('../../src/operations/company.js');

      const result = await getCompanyInfo();
      expect(result.CompanyName).toBe('Test AB');
      expect(result.OrganizationNumber).toBe('556677-8899');
    });
  });
});
