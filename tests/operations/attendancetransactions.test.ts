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

describe('attendance transaction operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listAttendanceTransactions', () => {
    it('maps employeeId to the lowercase employeeid param and passes date', async () => {
      mockFetch({ AttendanceTransactions: [], MetaInformation: {} });
      const { listAttendanceTransactions } =
        await import('../../src/operations/attendancetransactions.js');

      await listAttendanceTransactions({ employeeId: '1', date: '2026-06-01' });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('attendancetransactions');
      expect(calledUrl).toContain('employeeid=1');
      expect(calledUrl).toContain('date=2026-06-01');
    });

    it('passes page and limit params', async () => {
      mockFetch({ AttendanceTransactions: [], MetaInformation: {} });
      const { listAttendanceTransactions } =
        await import('../../src/operations/attendancetransactions.js');

      await listAttendanceTransactions({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('keeps the employeeid filter when fetching all pages', async () => {
      mockFetch({
        AttendanceTransactions: [],
        MetaInformation: { '@TotalResources': 0, '@TotalPages': 1, '@CurrentPage': 1 },
      });
      const { listAttendanceTransactions } =
        await import('../../src/operations/attendancetransactions.js');

      await listAttendanceTransactions({ employeeId: '7', date: '2026-06-01', all: true });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employeeid=7');
      expect(calledUrl).toContain('date=2026-06-01');
    });

    it('returns the full envelope', async () => {
      const response = {
        AttendanceTransactions: [{ id: 'uuid-1', EmployeeId: '1', CauseCode: 'ARB' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listAttendanceTransactions } =
        await import('../../src/operations/attendancetransactions.js');

      const result = await listAttendanceTransactions();
      expect(result.AttendanceTransactions).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getAttendanceTransaction', () => {
    it('unwraps the AttendanceTransaction envelope', async () => {
      mockFetch({ AttendanceTransaction: { id: 'uuid-1', EmployeeId: '1', CauseCode: 'ARB' } });
      const { getAttendanceTransaction } =
        await import('../../src/operations/attendancetransactions.js');

      const result = await getAttendanceTransaction('uuid-1');
      expect(result.id).toBe('uuid-1');
      expect(result.CauseCode).toBe('ARB');
    });

    it('encodes id in URL', async () => {
      mockFetch({ AttendanceTransaction: { id: 'A/B' } });
      const { getAttendanceTransaction } =
        await import('../../src/operations/attendancetransactions.js');

      await getAttendanceTransaction('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('attendancetransactions/A%2FB');
    });
  });

  describe('createAttendanceTransaction', () => {
    it('wraps params in AttendanceTransaction envelope for POST', async () => {
      mockFetch({ AttendanceTransaction: { id: 'uuid-2', EmployeeId: '1', CauseCode: 'ARB' } });
      const { createAttendanceTransaction } =
        await import('../../src/operations/attendancetransactions.js');

      await createAttendanceTransaction({ EmployeeId: '1', CauseCode: 'ARB', Date: '2026-06-01' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.AttendanceTransaction.EmployeeId).toBe('1');
      expect(body.AttendanceTransaction.CauseCode).toBe('ARB');
    });

    it('unwraps the response', async () => {
      mockFetch({ AttendanceTransaction: { id: 'uuid-2', EmployeeId: '1', CauseCode: 'ARB' } });
      const { createAttendanceTransaction } =
        await import('../../src/operations/attendancetransactions.js');

      const result = await createAttendanceTransaction({
        EmployeeId: '1',
        CauseCode: 'ARB',
        Date: '2026-06-01',
      });
      expect(result.id).toBe('uuid-2');
    });
  });

  describe('deleteAttendanceTransaction', () => {
    it('sends DELETE request', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });
      const { deleteAttendanceTransaction } =
        await import('../../src/operations/attendancetransactions.js');

      await deleteAttendanceTransaction('uuid-1');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('attendancetransactions/uuid-1');
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });
});
