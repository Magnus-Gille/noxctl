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

describe('absence transaction operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listAbsenceTransactions', () => {
    it('maps employeeId/date to lowercase query keys', async () => {
      mockFetch({ AbsenceTransactions: [], MetaInformation: {} });
      const { listAbsenceTransactions } =
        await import('../../src/operations/absencetransactions.js');

      await listAbsenceTransactions({ employeeId: '1', date: '2024-01-15' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('absencetransactions');
      expect(calledUrl).toContain('employeeid=1');
      expect(calledUrl).toContain('date=2024-01-15');
    });

    it('passes page and limit params', async () => {
      mockFetch({ AbsenceTransactions: [], MetaInformation: {} });
      const { listAbsenceTransactions } =
        await import('../../src/operations/absencetransactions.js');

      await listAbsenceTransactions({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        AbsenceTransactions: [{ id: 'abc-123', EmployeeId: '1', CauseCode: 'SEM' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listAbsenceTransactions } =
        await import('../../src/operations/absencetransactions.js');

      const result = await listAbsenceTransactions();
      expect(result.AbsenceTransactions).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getAbsenceTransaction', () => {
    it('unwraps the AbsenceTransaction envelope', async () => {
      mockFetch({ AbsenceTransaction: { id: 'abc-123', EmployeeId: '1', CauseCode: 'SEM' } });
      const { getAbsenceTransaction } = await import('../../src/operations/absencetransactions.js');

      const result = await getAbsenceTransaction('abc-123');
      expect(result.id).toBe('abc-123');
      expect(result.CauseCode).toBe('SEM');
    });

    it('encodes id in URL', async () => {
      mockFetch({ AbsenceTransaction: { id: 'A/B' } });
      const { getAbsenceTransaction } = await import('../../src/operations/absencetransactions.js');

      await getAbsenceTransaction('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('absencetransactions/A%2FB');
    });
  });

  describe('createAbsenceTransaction', () => {
    it('wraps params in AbsenceTransaction envelope for POST', async () => {
      mockFetch({ AbsenceTransaction: { id: 'new-1', EmployeeId: '1', CauseCode: 'VAB' } });
      const { createAbsenceTransaction } =
        await import('../../src/operations/absencetransactions.js');

      await createAbsenceTransaction({
        EmployeeId: '1',
        CauseCode: 'VAB',
        Date: '2024-01-15',
        Hours: 8,
        Extent: 50,
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.AbsenceTransaction.EmployeeId).toBe('1');
      expect(body.AbsenceTransaction.CauseCode).toBe('VAB');
      // Hours/Extent are numbers in the Fortnox spec, not strings.
      expect(body.AbsenceTransaction.Hours).toBe(8);
      expect(body.AbsenceTransaction.Extent).toBe(50);
    });

    it('unwraps the response', async () => {
      mockFetch({ AbsenceTransaction: { id: 'new-1', EmployeeId: '1', CauseCode: 'VAB' } });
      const { createAbsenceTransaction } =
        await import('../../src/operations/absencetransactions.js');

      const result = await createAbsenceTransaction({
        EmployeeId: '1',
        CauseCode: 'VAB',
        Date: '2024-01-15',
      });
      expect(result.id).toBe('new-1');
    });
  });

  describe('deleteAbsenceTransaction', () => {
    it('sends DELETE request', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteAbsenceTransaction } =
        await import('../../src/operations/absencetransactions.js');

      await deleteAbsenceTransaction('abc-123');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('absencetransactions/abc-123');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
