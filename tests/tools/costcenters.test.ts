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

describe('cost center tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_costcenters', () => {
    it('lists cost centers', async () => {
      const mockData = {
        CostCenters: [
          { Code: 'CC1', Description: 'Avdelning A' },
          { Code: 'CC2', Description: 'Avdelning B' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      };
      mockFetch(mockData);

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_costcenters', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Avdelning A');
      expect(text).toContain('Avdelning B');
    });
  });

  describe('fortnox_get_costcenter', () => {
    it('fetches a single cost center', async () => {
      mockFetch({
        CostCenter: { Code: 'CC1', Description: 'Avdelning A', Active: true },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_costcenter',
        arguments: { code: 'CC1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.Code).toBe('CC1');
    });
  });

  describe('fortnox_create_costcenter', () => {
    it('creates a cost center', async () => {
      mockFetch({ CostCenter: { Code: 'CC3', Description: 'Ny avdelning' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_costcenter',
        arguments: { Code: 'CC3', Description: 'Ny avdelning', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.CostCenter.Code).toBe('CC3');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_costcenter',
        arguments: { Code: 'CC3', Description: 'Test', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_costcenter',
        arguments: { Code: 'CC3', Description: 'Test' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_update_costcenter', () => {
    it('updates a cost center', async () => {
      mockFetch({ CostCenter: { Code: 'CC1', Description: 'Uppdaterad' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_costcenter',
        arguments: { code: 'CC1', Description: 'Uppdaterad', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('costcenters/CC1');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_costcenter',
        arguments: { code: 'CC1', Description: 'Uppdaterad' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_delete_costcenter', () => {
    it('deletes a cost center', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_delete_costcenter',
        arguments: { code: 'CC1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('costcenters/CC1');
      expect(fetchCall[1].method).toBe('DELETE');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_delete_costcenter',
        arguments: { code: 'CC1' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
