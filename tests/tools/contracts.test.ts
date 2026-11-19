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

function textOf(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content[0].text;
}

describe('contract tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_list_contracts', () => {
    it('lists contracts', async () => {
      mockFetch({
        Contracts: [
          { DocumentNumber: '1', CustomerName: 'Acme AB', Total: 1000 },
          { DocumentNumber: '2', CustomerName: 'Beta HB', Total: 2000 },
        ],
        MetaInformation: { '@TotalResources': 2, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_list_contracts', arguments: {} });

      const text = textOf(result);
      expect(text).toContain('Acme AB');
      expect(text).toContain('Beta HB');
    });

    it('passes filter through to the API', async () => {
      mockFetch({
        Contracts: [{ DocumentNumber: '1', CustomerName: 'Acme AB' }],
        MetaInformation: { '@TotalResources': 1, '@TotalPages': 1, '@CurrentPage': 1 },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_list_contracts',
        arguments: { filter: 'active' },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('filter=active');
    });
  });

  describe('fortnox_get_contract', () => {
    it('fetches a single contract', async () => {
      mockFetch({
        Contract: { DocumentNumber: '1', CustomerName: 'Acme AB', CustomerNumber: '25' },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_get_contract',
        arguments: { documentNumber: '1', includeRaw: true },
      });

      const parsed = JSON.parse(textOf(result).split('Raw JSON:\n')[1]);
      expect(parsed.DocumentNumber).toBe('1');
      expect(parsed.CustomerName).toBe('Acme AB');
    });
  });

  describe('fortnox_create_contract', () => {
    it('creates a contract', async () => {
      mockFetch({
        Contract: { DocumentNumber: '5', CustomerNumber: '25', CustomerName: 'Acme AB' },
      });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1, Price: 500 }],
          InvoiceInterval: 1,
          confirm: true,
        },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Contract.CustomerNumber).toBe('25');
      expect(body.Contract.InvoiceRows[0].Price).toBe(500);
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1, Price: 500 }],
          dryRun: true,
        },
      });

      const text = textOf(result);
      expect(text).toContain('Dry run');
      expect(text).toContain('25');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1, Price: 500 }],
        },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('contract fields from issues #224-#226', () => {
    function sentContract(): Record<string, unknown> {
      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      return (JSON.parse(call[1].body) as { Contract: Record<string, unknown> }).Contract;
    }

    it('create accepts CostCenter and Project on rows and on the contract (#224)', async () => {
      mockFetch({ Contract: { DocumentNumber: '5' } });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          CostCenter: '8',
          Project: '42',
          InvoiceRows: [
            {
              ArticleNumber: '10',
              DeliveredQuantity: 1,
              Price: 500,
              AccountNumber: 3004,
              CostCenter: '8',
              Project: '42',
            },
          ],
          confirm: true,
        },
      });

      expect(result.isError).toBeFalsy();
      const contract = sentContract();
      expect(contract.CostCenter).toBe('8');
      expect(contract.Project).toBe('42');
      const row = (contract.InvoiceRows as Record<string, unknown>[])[0];
      expect(row.CostCenter).toBe('8');
      expect(row.Project).toBe('42');
    });

    it('update accepts CostCenter and Project on rows and on the contract (#224)', async () => {
      mockFetch({ Contract: { DocumentNumber: '1' } });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_contract',
        arguments: {
          documentNumber: '1',
          CostCenter: '8',
          Project: '42',
          InvoiceRows: [
            { ArticleNumber: '10', DeliveredQuantity: 1, CostCenter: '8', Project: '42' },
          ],
          confirm: true,
        },
      });

      expect(result.isError).toBeFalsy();
      const contract = sentContract();
      expect(contract.CostCenter).toBe('8');
      expect(contract.Project).toBe('42');
      const row = (contract.InvoiceRows as Record<string, unknown>[])[0];
      expect(row.CostCenter).toBe('8');
      expect(row.Project).toBe('42');
    });

    it('create sends ContractLength 0 with Continuous true (#225)', async () => {
      mockFetch({ Contract: { DocumentNumber: '5' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          Continuous: true,
          InvoiceInterval: 1,
          PeriodStart: '2026-12-01',
          PeriodEnd: '2026-12-31',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1, Price: 500 }],
          confirm: true,
        },
      });

      const contract = sentContract();
      expect(contract.Continuous).toBe(true);
      expect(contract.ContractLength).toBe(0);
    });

    it('create dry run shows ContractLength 0 with Continuous true (#225)', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          Continuous: true,
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1 }],
          dryRun: true,
        },
      });

      expect(textOf(result)).toContain('"ContractLength": 0');
    });

    it('rejects Continuous true together with a positive ContractLength (#225)', async () => {
      mockFetch({ Contract: {} });
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          Continuous: true,
          ContractLength: 12,
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1 }],
          confirm: true,
        },
      });

      expect(result.isError).toBe(true);
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('create and update pass ContractDate through (#226)', async () => {
      mockFetch({ Contract: { DocumentNumber: '5' } });
      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          ContractDate: '2026-10-31',
          PeriodStart: '2026-11-01',
          PeriodEnd: '2026-11-30',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1 }],
          confirm: true,
        },
      });
      expect(sentContract().ContractDate).toBe('2026-10-31');

      mockFetch({ Contract: { DocumentNumber: '5' } });
      await client.callTool({
        name: 'fortnox_update_contract',
        arguments: { documentNumber: '5', ContractDate: '2026-10-31', confirm: true },
      });
      expect(sentContract().ContractDate).toBe('2026-10-31');
    });

    it('rejects a malformed ContractDate', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_contract',
        arguments: {
          CustomerNumber: '25',
          ContractDate: '31/10/2026',
          InvoiceRows: [{ ArticleNumber: '10', DeliveredQuantity: 1 }],
          dryRun: true,
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_update_contract', () => {
    it('updates a contract', async () => {
      mockFetch({ Contract: { DocumentNumber: '1', Comments: 'Uppdaterad' } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_update_contract',
        arguments: { documentNumber: '1', Comments: 'Uppdaterad', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('contracts/1');
      expect(fetchCall[1].method).toBe('PUT');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.Contract.Comments).toBe('Uppdaterad');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_contract',
        arguments: { documentNumber: '1', Comments: 'Test', dryRun: true },
      });

      const text = textOf(result);
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_update_contract',
        arguments: { documentNumber: '1', Comments: 'Test' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_finish_contract', () => {
    it('finishes a contract', async () => {
      mockFetch({ Contract: { DocumentNumber: '1', Active: false } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_finish_contract',
        arguments: { documentNumber: '1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('contracts/1/finish');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_finish_contract',
        arguments: { documentNumber: '1', dryRun: true },
      });

      const text = textOf(result);
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_finish_contract',
        arguments: { documentNumber: '1' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_create_invoice_from_contract', () => {
    it('creates an invoice from a contract', async () => {
      mockFetch({ Invoice: { DocumentNumber: '99', CustomerName: 'Acme AB', Total: 500 } });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_from_contract',
        arguments: { documentNumber: '1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('contracts/1/createinvoice');
      expect(fetchCall[1].method).toBe('PUT');
      expect(textOf(result)).toContain('Acme AB');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_from_contract',
        arguments: { documentNumber: '1', dryRun: true },
      });

      const text = textOf(result);
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_create_invoice_from_contract',
        arguments: { documentNumber: '1' },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('fortnox_increase_contract_invoice_count', () => {
    it('increases the invoice count', async () => {
      mockFetch({ Contract: { DocumentNumber: '1', InvoicesRemaining: 3 } });

      const { client } = await setupClientServer();
      await client.callTool({
        name: 'fortnox_increase_contract_invoice_count',
        arguments: { documentNumber: '1', confirm: true },
      });

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(fetchCall[0]).toContain('contracts/1/increaseinvoicecount');
      expect(fetchCall[1].method).toBe('PUT');
    });

    it('supports dry run', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_increase_contract_invoice_count',
        arguments: { documentNumber: '1', dryRun: true },
      });

      const text = textOf(result);
      expect(text).toContain('Dry run');
    });

    it('requires confirmation', async () => {
      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_increase_contract_invoice_count',
        arguments: { documentNumber: '1' },
      });

      expect(result.isError).toBe(true);
    });
  });
});
