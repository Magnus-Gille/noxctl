import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.js';
import { REFERENCE_TOOL_DEFINITIONS } from '../../src/tools/reference-data.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

async function setup() {
  const server = createServer();
  const client = new Client({ name: 'reference-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('reference data tools', () => {
  it('discovers explicit list/get tools for every selected resource', async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map(({ name }) => name);
    for (const definition of REFERENCE_TOOL_DEFINITIONS) {
      expect(names).toContain(`fortnox_list_${definition.id}`);
      if (definition.getId) expect(names).toContain(`fortnox_get_${definition.getId}`);
    }
  });

  it('returns stable list and detail output', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ Currencies: [{ Code: 'SEK', Description: 'Krona' }] })),
    });
    const { client } = await setup();
    const listed = await client.callTool({ name: 'fortnox_list_currencies', arguments: {} });
    expect((listed.content as { text: string }[])[0]?.text).toContain('SEK');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify({ Currency: { Code: 'SEK', Description: 'Krona' } })),
    });
    const detail = await client.callTool({
      name: 'fortnox_get_currency',
      arguments: { code: 'SEK' },
    });
    expect((detail.content as { text: string }[])[0]?.text).toContain('Krona');
  });
});
