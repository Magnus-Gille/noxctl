import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFortnoxClient } from '../src/fortnox-client.js';
import { createServer as createEmbeddedServer } from '../src/embedded.js';
import { createServer } from '../src/index.js';
import { VERSION } from '../src/version.js';

async function setupClientServer() {
  const server = createServer();
  const client = new Client({ name: 'capability-resource-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

describe('MCP capability resource', () => {
  it('is discoverable and readable without credentials or network access', async () => {
    const { client } = await setupClientServer();

    try {
      const resources = await client.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uri: 'noxctl://capabilities',
            mimeType: 'application/json',
          }),
        ]),
      );

      const result = await client.readResource({ uri: 'noxctl://capabilities' });
      const content = result.contents[0];
      expect(content).toMatchObject({
        uri: 'noxctl://capabilities',
        mimeType: 'application/json',
      });

      const capabilities = JSON.parse((content as { text: string }).text) as {
        name: string;
        version: string;
        description: string;
        tools: { name: string; description: string }[];
        inventoryNote: string;
        workflows: {
          readOnly: string;
          mutations: { confirmation: string; dryRun: string };
        };
      };
      expect(capabilities).toMatchObject({
        name: 'fortnox-mcp',
        version: VERSION,
        description: expect.stringMatching(/[ÅÄÖåäö]/),
        inventoryNote: expect.stringMatching(/registrerade verktygsinventering/i),
        workflows: {
          readOnly: expect.any(String),
          mutations: {
            confirmation: expect.any(String),
            dryRun: expect.any(String),
          },
        },
      });
      const advertisedTools = await client.listTools();
      expect(capabilities.tools.map(({ name }) => name).sort()).toEqual(
        advertisedTools.tools.map(({ name }) => name).sort(),
      );
      expect(capabilities.tools.length).toBeGreaterThan(100);
      expect(capabilities.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'fortnox_list_customers' }),
          expect.objectContaining({ name: 'fortnox_create_invoice' }),
        ]),
      );
    } finally {
      await client.close();
    }
  });

  it('keeps host-only status out of embedded capability inventory', async () => {
    const fetch = vi.fn();
    const getAccessToken = vi.fn().mockResolvedValue('unused');
    const server = createEmbeddedServer({
      transport: createFortnoxClient({
        getAccessToken,
        fetch,
      }),
    });
    const client = new Client({
      name: 'embedded-capability-resource-test-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain('fortnox_status');
      const result = await client.readResource({ uri: 'noxctl://capabilities' });
      expect((result.contents[0] as { text: string }).text).not.toContain('fortnox_status');
      expect(fetch).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
