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

describe('salary transaction tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_salarytransactions', () => {
    it('lists salary transactions', async () => {
      mockFetch({
        SalaryTransactions: [
          { SalaryRow: 1, EmployeeId: '1', SalaryCode: 'TIM' },
          { SalaryRow: 2, EmployeeId: '2', SalaryCode: 'MAN' },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_list_salarytransactions',
        arguments: {},
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('TIM');
      expect(text).toContain('MAN');
    });

    it('passes employeeId and date filters', async () => {
      mockFetch({
        SalaryTransactions: [],
        MetaInformation: { '@TotalResources': 0, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_salarytransactions',
        arguments: { employeeId: '1', date: '2026-06-01' },
      });

      const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('employeeId=1');
      expect(calledUrl).toContain('date=2026-06-01');
    });
  });

  describe('fortnox_get_salarytransaction', () => {
    it('fetches a single salary transaction', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 1, EmployeeId: '1', SalaryCode: 'TIM' } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_salarytransaction',
        arguments: { salaryRow: '1', includeRaw: true },
      });

      const parsed = JSON.parse(
        (result.content as { type: string; text: string }[])[0].text.split('Raw JSON:\n')[1],
      );
      expect(parsed.SalaryRow).toBe(1);
    });
  });

  describe('fortnox_create_salarytransaction', () => {
    it('creates a salary transaction', async () => {
      mockFetch({ SalaryTransaction: { SalaryRow: 3, EmployeeId: '1', SalaryCode: 'TIM' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_salarytransaction',
        arguments: { EmployeeId: '1', SalaryCode: 'TIM', Date: '2026-06-01', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.SalaryTransaction.EmployeeId).toBe('1');
      expect(body.SalaryTransaction.SalaryCode).toBe('TIM');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_salarytransaction',
        arguments: { EmployeeId: '1', SalaryCode: 'TIM', Date: '2026-06-01', dryRun: true },
      });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_salarytransaction',
        arguments: { EmployeeId: '1', SalaryCode: 'TIM', Date: '2026-06-01' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_delete_salarytransaction', () => {
    it('deletes a salary transaction', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve(undefined),
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_delete_salarytransaction',
        arguments: { salaryRow: '1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('salarytransactions/1');
      expect(fetchCall[1].method).toBe('DELETE');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_delete_salarytransaction',
        arguments: { salaryRow: '1' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
