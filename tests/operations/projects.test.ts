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

describe('project operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listProjects', () => {
    it('passes page and limit params', async () => {
      mockFetch({ Projects: [], MetaInformation: {} });
      const { listProjects } = await import('../../src/operations/projects.js');

      await listProjects({ page: 2, limit: 25 });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });

    it('returns the full envelope', async () => {
      const response = {
        Projects: [{ ProjectNumber: '1', Description: 'Testprojekt' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(response);
      const { listProjects } = await import('../../src/operations/projects.js');

      const result = await listProjects();
      expect(result.Projects).toHaveLength(1);
      expect(result.MetaInformation).toBeDefined();
    });
  });

  describe('getProject', () => {
    it('unwraps the Project envelope', async () => {
      mockFetch({ Project: { ProjectNumber: '1', Description: 'Testprojekt' } });
      const { getProject } = await import('../../src/operations/projects.js');

      const result = await getProject('1');
      expect(result.ProjectNumber).toBe('1');
      expect(result.Description).toBe('Testprojekt');
    });

    it('encodes project number in URL', async () => {
      mockFetch({ Project: { ProjectNumber: 'P/1', Description: 'Test' } });
      const { getProject } = await import('../../src/operations/projects.js');

      await getProject('P/1');

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('projects/P%2F1');
    });
  });

  describe('createProject', () => {
    it('wraps params in Project envelope for POST', async () => {
      mockFetch({ Project: { ProjectNumber: '5', Description: 'Nytt projekt' } });
      const { createProject } = await import('../../src/operations/projects.js');

      await createProject({ Description: 'Nytt projekt', Status: 'ONGOING' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Project.Description).toBe('Nytt projekt');
      expect(body.Project.Status).toBe('ONGOING');
    });

    it('unwraps the response', async () => {
      mockFetch({ Project: { ProjectNumber: '5', Description: 'Nytt projekt' } });
      const { createProject } = await import('../../src/operations/projects.js');

      const result = await createProject({ Description: 'Nytt projekt' });
      expect(result.ProjectNumber).toBe('5');
    });
  });

  describe('updateProject', () => {
    it('uses PUT and excludes ProjectNumber from body', async () => {
      mockFetch({ Project: { ProjectNumber: '1', Description: 'Uppdaterat' } });
      const { updateProject } = await import('../../src/operations/projects.js');

      await updateProject('1', { ProjectNumber: '1', Description: 'Uppdaterat' });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('projects/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Project.Description).toBe('Uppdaterat');
      expect(body.Project.ProjectNumber).toBeUndefined();
    });
  });
});
