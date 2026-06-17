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

describe('salary transaction operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listSalaryTransactions', () => {
    it('passes page and limit params', async () => {
      mockFetch({ SalaryTransactions: [], MetaInformation: {} });
      const { listSalaryTransactions } = await import('../../src/operations/salarytransactions.js');

      await listSalaryTransactions({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('salarytransactions');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('passes employeeId and date filters', async () => {
      mockFetch({ SalaryTransactions: [], MetaInformation: {} });
      const { listSalaryTransactions } = await import('../../src/operations/salarytransactions.js');

      await listSalaryTransactions({ employeeId: '1', date: '2026-06-01' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employeeId=1');
      expect(calledUrl).toContain('date=2026-06-01');
    });

    it('returns the full envelope', async () => {
      const response = {
        SalaryTransactions: [{ SalaryRow: 1, EmployeeId: '1', SalaryCode: 'TIM' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listSalaryTransactions } = await import('../../src/operations/salarytransactions.js');

      const result = await listSalaryTransactions();
      expect(result.SalaryTransactions).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getSalaryTransaction', () => {
    it('unwraps the SalaryTransaction envelope', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 1, EmployeeId: '1', SalaryCode: 'TIM' } });
      const { getSalaryTransaction } = await import('../../src/operations/salarytransactions.js');

      const result = await getSalaryTransaction('1');
      expect(result.SalaryRow).toBe(1);
      expect(result.EmployeeId).toBe('1');
    });

    it('encodes salaryRow in URL', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 1 } });
      const { getSalaryTransaction } = await import('../../src/operations/salarytransactions.js');

      await getSalaryTransaction('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('salarytransactions/A%2FB');
    });
  });

  describe('createSalaryTransaction', () => {
    it('wraps params in SalaryTransaction envelope for POST', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 2, EmployeeId: '1', SalaryCode: 'TIM' } });
      const { createSalaryTransaction } =
        await import('../../src/operations/salarytransactions.js');

      await createSalaryTransaction({ EmployeeId: '1', SalaryCode: 'TIM', Date: '2026-06-01' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SalaryTransaction.EmployeeId).toBe('1');
      expect(body.SalaryTransaction.SalaryCode).toBe('TIM');
    });

    it('unwraps the response', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 2, EmployeeId: '1', SalaryCode: 'TIM' } });
      const { createSalaryTransaction } =
        await import('../../src/operations/salarytransactions.js');

      const result = await createSalaryTransaction({
        EmployeeId: '1',
        SalaryCode: 'TIM',
        Date: '2026-06-01',
      });
      expect(result.SalaryRow).toBe(2);
    });
  });

  describe('deleteSalaryTransaction', () => {
    it('sends DELETE request', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteSalaryTransaction } =
        await import('../../src/operations/salarytransactions.js');

      await deleteSalaryTransaction('1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('salarytransactions/1');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
