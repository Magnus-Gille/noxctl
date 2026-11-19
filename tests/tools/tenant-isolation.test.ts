import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFortnoxClient } from '../../src/fortnox-client.js';
import { createServer } from '../../src/index.js';

async function connectedClient(companyName: string, token: string) {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ CompanyInformation: { CompanyName: companyName } })),
    );
  const transport = createFortnoxClient({
    getAccessToken: async () => token,
    fetch,
    contextLabel: companyName,
  });
  const server = createServer({ transport });
  const client = new Client({ name: `test-${companyName}`, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, fetch };
}

describe('tenant-bound MCP servers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps concurrent server data and tokens isolated', async () => {
    const tenantA = await connectedClient('Tenant A AB', 'tenant-a-token');
    const tenantB = await connectedClient('Tenant B AB', 'tenant-b-token');

    const tools = await tenantA.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain('fortnox_status');
    expect(JSON.stringify(tools.tools.map((tool) => tool.inputSchema))).not.toMatch(
      /tenant|profile|access.?token/i,
    );

    const [resultA, resultB] = await Promise.all([
      tenantA.client.callTool({ name: 'fortnox_company_info', arguments: {} }),
      tenantB.client.callTool({ name: 'fortnox_company_info', arguments: {} }),
    ]);

    expect(JSON.stringify(resultA.content)).toContain('Tenant A AB');
    expect(JSON.stringify(resultA.content)).not.toContain('Tenant B AB');
    expect(JSON.stringify(resultB.content)).toContain('Tenant B AB');
    expect(JSON.stringify(resultB.content)).not.toContain('Tenant A AB');
    expect(tenantA.fetch).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/companyinformation',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-a-token' }),
      }),
    );
    expect(tenantB.fetch).toHaveBeenCalledWith(
      'https://api.fortnox.se/3/companyinformation',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-b-token' }),
      }),
    );

    await Promise.all([tenantA.client.close(), tenantB.client.close()]);
  });

  it('keeps error context isolated between concurrent servers', async () => {
    async function failingClient(contextLabel: string, failure: string) {
      const transport = createFortnoxClient({
        getAccessToken: async () => `${contextLabel}-token`,
        contextLabel,
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ErrorInformation: { message: failure, code: 0 } }), {
            status: 400,
          }),
        ),
      });
      const server = createServer({ transport });
      const client = new Client({ name: `test-${contextLabel}`, version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    }
    const clientA = await failingClient('tenant-a', 'failure-a');
    const clientB = await failingClient('tenant-b', 'failure-b');

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: 'fortnox_company_info', arguments: {} }),
      clientB.callTool({ name: 'fortnox_company_info', arguments: {} }),
    ]);

    expect(JSON.stringify(resultA.content)).toContain('[context: tenant-a]');
    expect(JSON.stringify(resultA.content)).toContain('failure-a');
    expect(JSON.stringify(resultA.content)).not.toContain('tenant-b');
    expect(JSON.stringify(resultB.content)).toContain('[context: tenant-b]');
    expect(JSON.stringify(resultB.content)).toContain('failure-b');
    expect(JSON.stringify(resultB.content)).not.toContain('tenant-a');
    await Promise.all([clientA.close(), clientB.close()]);
  });

  it('preserves the local-only status tool on the default server', async () => {
    const server = createServer();
    const client = new Client({ name: 'local-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('fortnox_status');
    await client.close();
  });

  it('never applies local profile send defaults (BCC) in a tenant-bound server', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = await mkdtemp(join(tmpdir(), 'noxctl-tenant-bcc-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const { setInvoiceDefaultBcc } = await import('../../src/invoice-send-defaults.js');
      await setInvoiceDefaultBcc('default', 'host-copy@example.com');

      const fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('attachments-v1')) return new Response('[]');
        if (url.includes('/customers/')) return new Response(JSON.stringify({ Customer: {} }));
        return new Response(
          JSON.stringify({
            Invoice: { DocumentNumber: '7', EmailInformation: { EmailAddressTo: 'a@b.se' } },
          }),
        );
      });
      const transport = createFortnoxClient({
        getAccessToken: async () => 'tenant-token',
        fetch,
        contextLabel: 'Tenant',
      });
      const server = createServer({ transport });
      const client = new Client({ name: 'test-bcc', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'fortnox_send_invoice',
        arguments: { documentNumber: '7', dryRun: true },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).not.toContain('host-copy@example.com');
      await client.close();
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await rm(home, { recursive: true, force: true });
    }
  });
});
