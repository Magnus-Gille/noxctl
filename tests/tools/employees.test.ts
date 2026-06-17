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

describe('employee tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_employees', () => {
    it('lists employees', async () => {
      mockFetch({
        Employees: [
          { EmployeeId: '1', FullName: 'Anna Andersson' },
          { EmployeeId: '2', FullName: 'Bo Berg' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_employees', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Anna Andersson');
      expect(text).toContain('Bo Berg');
    });
  });

  describe('fortnox_get_employee', () => {
    it('fetches a single employee', async () => {
      mockFetch({ Employee: { EmployeeId: '1', FirstName: 'Anna', LastName: 'Andersson' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_employee',
        arguments: { employeeId: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.EmployeeId).toBe('1');
    });
  });

  describe('fortnox_create_employee', () => {
    it('creates an employee', async () => {
      mockFetch({ Employee: { EmployeeId: '3', FirstName: 'Cilla' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_employee',
        arguments: {
          FirstName: 'Cilla',
          LastName: 'Carlsson',
          Email: 'cilla@example.se',
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Employee.FirstName).toBe('Cilla');
      expect(body.Employee.Email).toBe('cilla@example.se');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_employee',
        arguments: { FirstName: 'X', LastName: 'Y', Email: 'x@y.se', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_employee',
        arguments: { FirstName: 'X', LastName: 'Y', Email: 'x@y.se' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_update_employee', () => {
    it('updates an employee', async () => {
      mockFetch({ Employee: { EmployeeId: '1', JobTitle: 'Utvecklare' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_employee',
        arguments: { employeeId: '1', JobTitle: 'Utvecklare', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('employees/1');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_employee',
        arguments: { employeeId: '1', JobTitle: 'Utvecklare' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
