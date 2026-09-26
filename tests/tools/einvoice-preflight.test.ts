import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFortnoxClient } from '../../src/fortnox-client.js';
import { createServer } from '../../src/index.js';

async function setup() {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Invoice: {
            DocumentNumber: '1001',
            CustomerNumber: '25',
            Sent: false,
            Booked: false,
            Cancelled: false,
            YourReference: 'Buyer',
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          Customer: { CustomerNumber: '25', DefaultDeliveryTypes: { Invoice: 'EINVOICE' } },
        }),
      ),
    );
  const server = createServer({
    transport: createFortnoxClient({ getAccessToken: async () => 'synthetic-token', fetch }),
  });
  const client = new Client({ name: 'preflight-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, fetch };
}

describe('e-invoice preflight MCP tool', () => {
  it('exposes machine-readable unsupported readiness and only reads the invoice and its customer', async () => {
    const { client, fetch } = await setup();
    try {
      const result = await client.callTool({
        name: 'fortnox_preflight_invoice',
        arguments: { documentNumber: '1001' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: false,
        status: 'unknown',
        draft: { status: 'verified' },
        recipientConnection: { status: 'unsupported' },
      });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(
        result.structuredContent,
      );
      expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
        ['https://api.fortnox.se/3/invoices/1001', 'GET'],
        ['https://api.fortnox.se/3/customers/25', 'GET'],
      ]);
    } finally {
      await client.close();
    }
  });
  it('rejects mutation-like arguments before making any request', async () => {
    const { client, fetch } = await setup();
    try {
      const result = await client.callTool({
        name: 'fortnox_preflight_invoice',
        arguments: { documentNumber: '1001', confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
