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

describe('absence transaction tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_absencetransactions', () => {
    it('lists absence transactions', async () => {
      mockFetch({
        AbsenceTransactions: [
          { id: 'abc-1', EmployeeId: '1', CauseCode: 'SEM', Date: '2024-01-15' },
          { id: 'abc-2', EmployeeId: '2', CauseCode: 'VAB', Date: '2024-01-16' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_absencetransactions',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('SEM');
      expect(text).toContain('VAB');
    });

    it('maps employeeId/date to lowercase query keys', async () => {
      mockFetch({ AbsenceTransactions: [], MetaInformation: {} });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_absencetransactions',
        arguments: { employeeId: '1', date: '2024-01-15' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employeeid=1');
      expect(calledUrl).toContain('date=2024-01-15');
    });
  });

  describe('fortnox_get_absencetransaction', () => {
    it('fetches a single absence transaction', async () => {
      mockFetch({ AbsenceTransaction: { id: 'abc-1', EmployeeId: '1', CauseCode: 'SEM' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_absencetransaction',
        arguments: { id: 'abc-1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.id).toBe('abc-1');
    });
  });

  describe('fortnox_create_absencetransaction', () => {
    it('creates an absence transaction', async () => {
      mockFetch({ AbsenceTransaction: { id: 'new-1', EmployeeId: '1', CauseCode: 'VAB' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_absencetransaction',
        arguments: {
          EmployeeId: '1',
          CauseCode: 'VAB',
          Date: '2024-01-15',
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.AbsenceTransaction.EmployeeId).toBe('1');
      expect(body.AbsenceTransaction.CauseCode).toBe('VAB');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_absencetransaction',
        arguments: { EmployeeId: '1', CauseCode: 'VAB', Date: '2024-01-15', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_absencetransaction',
        arguments: { EmployeeId: '1', CauseCode: 'VAB', Date: '2024-01-15' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_delete_absencetransaction', () => {
    it('deletes an absence transaction', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_delete_absencetransaction',
        arguments: { id: 'abc-1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('absencetransactions/abc-1');
      expect(fetchCall[1].method).toBe('DELETE');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_delete_absencetransaction',
        arguments: { id: 'abc-1' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
