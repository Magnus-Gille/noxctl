import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { createStrictMcpServer } from '../src/strict-mcp-server.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'strict-input-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[])[0]?.text ?? '';
}

describe('strict MCP tool inputs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails fast if a future tool bypasses the repository registration convention', () => {
    const server = createStrictMcpServer({ name: 'test-server', version: '1.0.0' });

    expect(() => server.tool('unsupported-overload', () => ({ content: [] }))).toThrow(
      /must use tool\(name, description, ZodRawShape, callback\)/,
    );
  });

  it('rejects an unknown top-level mutation argument before calling Fortnox', async () => {
    global.fetch = vi.fn();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_create_supplier',
      arguments: {
        Name: 'Testleverantör AB',
        confirm: true,
        YourReferense: 'felstavat fältnamn',
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('YourReferense');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unknown nested mutation argument before calling Fortnox', async () => {
    global.fetch = vi.fn();
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_create_voucher',
      arguments: {
        Description: 'Test',
        TransactionDate: '2026-08-29',
        VoucherRows: [
          { Account: 6110, Debit: 100, TransactionInfo: 'felstavat fältnamn' },
          { Account: 1930, Credit: 100 },
        ],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TransactionInfo');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('advertises closed schemas for every top-level tool input', async () => {
    const { client } = await setupClientServer();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(100);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('advertises closed schemas for every structured financial-document row', async () => {
    const { client } = await setupClientServer();
    const { tools } = await client.listTools();
    const structuredRows = [
      ['fortnox_create_invoice', 'InvoiceRows'],
      ['fortnox_update_invoice', 'InvoiceRows'],
      ['fortnox_create_supplier_invoice', 'SupplierInvoiceRows'],
      ['fortnox_create_offer', 'OfferRows'],
      ['fortnox_update_offer', 'OfferRows'],
      ['fortnox_create_order', 'OrderRows'],
      ['fortnox_update_order', 'OrderRows'],
      ['fortnox_create_voucher', 'VoucherRows'],
    ] as const;

    for (const [toolName, rowProperty] of structuredRows) {
      const tool = tools.find((candidate) => candidate.name === toolName)!;
      const schema = tool.inputSchema as {
        properties: Record<string, { items?: { additionalProperties?: boolean } }>;
      };
      expect(schema.properties[rowProperty].items?.additionalProperties, toolName).toBe(false);
    }
  });

  it('rejects additional fields in structured contract rows', async () => {
    const { client } = await setupClientServer();

    const result = await client.callTool({
      name: 'fortnox_create_contract',
      arguments: {
        CustomerNumber: '25',
        InvoiceRows: [
          {
            ArticleNumber: '10',
            DeliveredQuantity: 1,
            Price: 500,
            FutureFortnoxField: 'bevaras',
          },
        ],
        dryRun: true,
      },
    });

    expect(result.isError).toBe(true);
  });
});
