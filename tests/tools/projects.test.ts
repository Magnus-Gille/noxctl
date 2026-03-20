import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('project tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_projects', () => {
    it('lists projects with default pagination', async () => {
      const mockData = {
        Projects: [
          { ProjectNumber: '1', Description: 'Projekt A' },
          { ProjectNumber: '2', Description: 'Projekt B' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_projects', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Projekt A');
      expect(text).toContain('Projekt B');
    });

    it('supports pagination', async () => {
      mockFetch({ Projects: [], MetaInformation: { '@CurrentPage': 2 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_projects',
        arguments: { page: 2, limit: 25 },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=25');
    });
  });

  describe('fortnox_get_project', () => {
    it('fetches a single project', async () => {
      mockFetch({
        Project: { ProjectNumber: '1', Description: 'Projekt A', Status: 'ONGOING' },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_project',
        arguments: { projectNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.ProjectNumber).toBe('1');
      expect(parsed.Description).toBe('Projekt A');
    });

    it('returns error for non-existent project', async () => {
      mockFetch({ ErrorInformation: { message: 'Not found', code: 2000428 } }, false, 404);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_project',
        arguments: { projectNumber: '999' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_create_project', () => {
    it('creates a project with required fields', async () => {
      mockFetch({ Project: { ProjectNumber: '5', Description: 'Nytt projekt' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_project',
        arguments: { Description: 'Nytt projekt', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Project.Description).toBe('Nytt projekt');
    });

    it('supports dry run', async () => {
      mockFetch({ Project: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_project',
        arguments: { Description: 'Test', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('requires confirmation', async () => {
      mockFetch({ Project: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_project',
        arguments: { Description: 'Test' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('fortnox_update_project', () => {
    it('updates specific fields', async () => {
      mockFetch({
        Project: { ProjectNumber: '1', Description: 'Uppdaterat', Status: 'COMPLETED' },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_project',
        arguments: { projectNumber: '1', Status: 'COMPLETED', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('projects/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Project.Status).toBe('COMPLETED');
    });

    it('requires confirmation before updating', async () => {
      mockFetch({ Project: { ProjectNumber: '1' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_project',
        arguments: { projectNumber: '1', Status: 'COMPLETED' },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
