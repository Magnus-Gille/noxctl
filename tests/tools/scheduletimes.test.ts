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

describe('schedule time tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_get_scheduletime', () => {
    it('fetches a single schedule time', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_scheduletime',
        arguments: { employeeId: '1', date: '2026-06-01', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.EmployeeId).toBe('1');
      expect(parsed.Hours).toBe('8');
    });
  });

  describe('fortnox_update_scheduletime', () => {
    it('updates a schedule time', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_scheduletime',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('scheduletimes/1/2026-06-01');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.ScheduleTime.Hours).toBe('8');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_scheduletime',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_scheduletime',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_reset_scheduletime_day', () => {
    it('resets a schedule time day', async () => {
      mockFetch({ ScheduleTime: { EmployeeId: '1', Date: '2026-06-01', Hours: '8' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_reset_scheduletime_day',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('scheduletimes/1/2026-06-01/resetday');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_reset_scheduletime_day',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_reset_scheduletime_day',
        arguments: { employeeId: '1', date: '2026-06-01', Hours: '8' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
