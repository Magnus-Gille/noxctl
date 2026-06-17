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

describe('employee operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listEmployees', () => {
    it('passes page and limit params', async () => {
      mockFetch({ Employees: [], MetaInformation: {} });
      const { listEmployees } = await import('../../src/operations/employees.js');

      await listEmployees({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employees');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        Employees: [{ EmployeeId: '1', FullName: 'Anna Andersson' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listEmployees } = await import('../../src/operations/employees.js');

      const result = await listEmployees();
      expect(result.Employees).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getEmployee', () => {
    it('unwraps the Employee envelope', async () => {
      mockFetch({ Employee: { EmployeeId: '1', FirstName: 'Anna', LastName: 'Andersson' } });
      const { getEmployee } = await import('../../src/operations/employees.js');

      const result = await getEmployee('1');
      expect(result.EmployeeId).toBe('1');
      expect(result.FirstName).toBe('Anna');
    });

    it('encodes employeeId in URL', async () => {
      mockFetch({ Employee: { EmployeeId: 'A/B' } });
      const { getEmployee } = await import('../../src/operations/employees.js');

      await getEmployee('A/B');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employees/A%2FB');
    });
  });

  describe('createEmployee', () => {
    it('wraps params in Employee envelope for POST', async () => {
      mockFetch({ Employee: { EmployeeId: '2', FirstName: 'Bo' } });
      const { createEmployee } = await import('../../src/operations/employees.js');

      await createEmployee({ FirstName: 'Bo', LastName: 'Berg', Email: 'bo@example.se' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Employee.FirstName).toBe('Bo');
      expect(body.Employee.Email).toBe('bo@example.se');
    });
  });

  describe('updateEmployee', () => {
    it('uses PUT and excludes EmployeeId from body', async () => {
      mockFetch({ Employee: { EmployeeId: '1', JobTitle: 'Utvecklare' } });
      const { updateEmployee } = await import('../../src/operations/employees.js');

      await updateEmployee('1', { EmployeeId: '1', JobTitle: 'Utvecklare' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('employees/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Employee.JobTitle).toBe('Utvecklare');
      expect(body.Employee.EmployeeId).toBeUndefined();
    });
  });
});
