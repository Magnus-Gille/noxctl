import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

// Single-page invoice list: fetchAllPages reads MetaInformation['@TotalPages'],
// so include it (=1) to keep the mock to one fetch call.
function mockInvoices(invoices: Record<string, unknown>[]) {
  const response = {
    Invoices: invoices,
    MetaInformation: {
      '@TotalResources': invoices.length,
      '@TotalPages': 1,
      '@CurrentPage': 1,
    },
  };
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
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

describe('analytics tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_overdue_invoices', () => {
    it('summarizes overdue invoices (oldest first)', async () => {
      // DueDates well in the past so they are overdue regardless of run date.
      mockInvoices([
        {
          DocumentNumber: 101,
          CustomerName: 'Acme AB',
          InvoiceDate: '2024-12-01',
          DueDate: '2025-02-01',
          Total: 1000,
          Balance: 1000,
          Cancelled: false,
        },
        {
          DocumentNumber: 102,
          CustomerName: 'Globex AB',
          InvoiceDate: '2024-11-01',
          DueDate: '2025-01-01',
          Total: 500,
          Balance: 500,
          Cancelled: false,
        },
      ]);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_overdue_invoices',
        arguments: {},
      });

      const text = textOf(result);
      expect(text).toContain('Förfallna fakturor: 2 st');
      expect(text).toContain('1500.00'); // total outstanding
      expect(text).toContain('Äldsta förfallodatum: 2025-01-01'); // oldest due
      expect(text).toContain('Acme AB');
      expect(text).toContain('Globex AB');
    });

    it('reports when there are no overdue invoices', async () => {
      mockInvoices([]);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_overdue_invoices',
        arguments: {},
      });

      expect(textOf(result)).toContain('Inga förfallna fakturor.');
    });
  });

  describe('fortnox_unpaid_totals', () => {
    it('totals unpaid invoices and separates the overdue portion', async () => {
      mockInvoices([
        // overdue (past due date, open balance)
        {
          DocumentNumber: 201,
          DueDate: '2025-01-01',
          Total: 1000,
          Balance: 1000,
          Cancelled: false,
        },
        // open but not yet due (far-future due date)
        {
          DocumentNumber: 202,
          DueDate: '2099-12-31',
          Total: 400,
          Balance: 400,
          Cancelled: false,
        },
      ]);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_unpaid_totals',
        arguments: {},
      });

      const text = textOf(result);
      expect(text).toContain('Obetalda fakturor: 2 st');
      expect(text).toContain('1400.00'); // total outstanding
      expect(text).toContain('Varav förfallna: 1 st');
      expect(text).toContain('1000.00'); // overdue portion
    });
  });

  describe('fortnox_top_customers', () => {
    it('ranks customers by invoiced total', async () => {
      mockInvoices([
        { CustomerNumber: '1', CustomerName: 'Acme AB', Total: 1000, Cancelled: false },
        { CustomerNumber: '1', CustomerName: 'Acme AB', Total: 500, Cancelled: false },
        { CustomerNumber: '2', CustomerName: 'Globex AB', Total: 2000, Cancelled: false },
        // cancelled invoices are excluded from the aggregation
        { CustomerNumber: '3', CustomerName: 'Skip AB', Total: 9999, Cancelled: true },
      ]);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_top_customers',
        arguments: { fromDate: '2025-01-01', toDate: '2025-12-31', limit: 5 },
      });

      const text = textOf(result);
      expect(text).toContain('Period: 2025-01-01 — 2025-12-31');
      expect(text).toContain('Globex AB');
      expect(text).toContain('2000.00');
      expect(text).toContain('Acme AB');
      expect(text).toContain('1500.00'); // 1000 + 500 aggregated
      expect(text).not.toContain('Skip AB'); // cancelled excluded

      // Globex (2000) should be ranked above Acme (1500).
      expect(text.indexOf('Globex AB')).toBeLessThan(text.indexOf('Acme AB'));
    });

    it('reports when there are no invoices in the period', async () => {
      mockInvoices([]);

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_top_customers',
        arguments: {},
      });

      expect(textOf(result)).toContain('Inga fakturor i perioden.');
    });
  });

  describe('fortnox_vat_summary', () => {
    it('summarizes VAT accounts and net position', async () => {
      // getVatSummary -> generateTaxReport makes two GETs: accounts, then vouchers.
      const accountsResponse = {
        Accounts: [
          {
            Number: 2610,
            Description: 'Utgående moms 25%',
            SRU: 0,
            BalanceBroughtForward: 0,
            BalanceCarriedForward: -12500,
          },
          {
            Number: 2640,
            Description: 'Ingående moms',
            SRU: 0,
            BalanceBroughtForward: 0,
            BalanceCarriedForward: 3200,
          },
        ],
      };
      const vouchersResponse = {
        Vouchers: [
          {
            VoucherNumber: 1,
            VoucherRows: [
              { Account: 2610, Debit: 0, Credit: 12500, Description: 'Utgående moms' },
              { Account: 2640, Debit: 3200, Credit: 0, Description: 'Ingående moms' },
            ],
          },
        ],
      };

      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        const response = fetchCallCount === 1 ? accountsResponse : vouchersResponse;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
          json: () => Promise.resolve(response),
        });
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({
        name: 'fortnox_vat_summary',
        arguments: { fromDate: '2025-01-01', toDate: '2025-03-31' },
      });

      const text = textOf(result);
      expect(text).toContain('2025-01-01');
      expect(text).toContain('2025-03-31');
      expect(text).toContain('2610');
      expect(text).toContain('12500.00');
      expect(text).toContain('2640');
      expect(text).toContain('3200.00');
      // Net VAT = (debit - credit) across accounts:
      // 2610: 0 - 12500 = -12500; 2640: 3200 - 0 = 3200; net = -9300.
      expect(text).toContain('Netto moms: -9300.00');
    });
  });
});
