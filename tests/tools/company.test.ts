import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

function mockFetch(response: unknown) {
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

describe('company tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fortnox_company_info', () => {
    it('fetches company information', async () => {
      mockFetch({
        CompanyInformation: {
          CompanyName: 'Northwind Services AB',
          OrganisationNumber: '556123-4567',
          Address: 'Storgatan 1',
          ZipCode: '11122',
          City: 'Stockholm',
          Country: 'SE',
          Email: 'finance@northwind.example',
          DatabaseNumber: 12345,
        },
      });

      const { client } = await setupClientServer();
      const result = await client.callTool({ name: 'fortnox_company_info', arguments: {} });

      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('Northwind Services AB');
      expect(text).toContain('556123-4567');
      expect(text).toContain('Stockholm');
    });
  });
});
