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

describe('schedule time operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getScheduleTime', () => {
    it('unwraps the ScheduleTime envelope', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });
      const { getScheduleTime } = await import('../../src/operations/scheduletimes.js');

      const result = await getScheduleTime('1', '2026-06-01');
      expect(result.EmployeeId).toBe('1');
      expect(result.Hours).toBe('8');
    });

    it('GETs scheduletimes/<EmployeeId>/<Date>', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01' } });
      const { getScheduleTime } = await import('../../src/operations/scheduletimes.js');

      await getScheduleTime('1', '2026-06-01');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('scheduletimes/1/2026-06-01');
    });

    it('encodes employeeId and date in URL', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: 'A/B', Date: '2026/06/01' } });
      const { getScheduleTime } = await import('../../src/operations/scheduletimes.js');

      await getScheduleTime('A/B', '2026/06/01');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('scheduletimes/A%2FB/2026%2F06%2F01');
    });
  });

  describe('updateScheduleTime', () => {
    it('uses PUT and wraps fields in ScheduleTime envelope', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });
      const { updateScheduleTime } = await import('../../src/operations/scheduletimes.js');

      await updateScheduleTime('1', '2026-06-01', { Hours: '8' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('scheduletimes/1/2026-06-01');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ScheduleTime.Hours).toBe('8');
    });

    it('excludes EmployeeId and Date from body', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });
      const { updateScheduleTime } = await import('../../src/operations/scheduletimes.js');

      await updateScheduleTime('1', '2026-06-01', {
        EmployeeId: '1',
        Date: '2026-06-01',
        Hours: '8',
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ScheduleTime.Hours).toBe('8');
      expect(body.ScheduleTime.EmployeeId).toBeUndefined();
      expect(body.ScheduleTime.Date).toBeUndefined();
    });
  });

  describe('resetScheduleTimeDay', () => {
    it('PUTs to scheduletimes/<EmployeeId>/<Date>/resetday', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });
      const { resetScheduleTimeDay } = await import('../../src/operations/scheduletimes.js');

      await resetScheduleTimeDay('1', '2026-06-01', { Hours: '8' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('scheduletimes/1/2026-06-01/resetday');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ScheduleTime.Hours).toBe('8');
    });

    it('excludes EmployeeId and Date from body', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });
      const { resetScheduleTimeDay } = await import('../../src/operations/scheduletimes.js');

      await resetScheduleTimeDay('1', '2026-06-01', {
        EmployeeId: '1',
        Date: '2026-06-01',
        Hours: '8',
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ScheduleTime.EmployeeId).toBeUndefined();
      expect(body.ScheduleTime.Date).toBeUndefined();
    });
  });
});
