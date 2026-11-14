import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { CAPABILITY_RESOURCE_URI } from '../src/capability-resource.js';

async function connect(readOnly?: boolean) {
  const server = createServer(readOnly === undefined ? {} : { readOnly });
  const client = new Client({ name: 'read-only-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

function mutationFields(inputSchema: unknown): string[] {
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).filter((field) => field === 'confirm' || field === 'dryRun');
}

describe('read-only MCP server mode', () => {
  it('lists no tool with confirm or dryRun inputs', async () => {
    const { client, close } = await connect(true);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(90);
      for (const tool of tools) {
        expect(mutationFields(tool.inputSchema), tool.name).toEqual([]);
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it('keeps every read tool of the full server and drops every mutation', async () => {
    const full = await connect();
    const readOnly = await connect(true);
    try {
      const fullTools = (await full.client.listTools()).tools;
      const readOnlyNames = (await readOnly.client.listTools()).tools
        .map((tool) => tool.name)
        .sort();
      const expectedReads = fullTools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
        .sort();
      expect(readOnlyNames).toEqual(expectedReads);
      expect(readOnlyNames).toEqual(
        expect.arrayContaining([
          'fortnox_list_invoices',
          'fortnox_get_voucher',
          'fortnox_general_ledger',
        ]),
      );
      expect(readOnlyNames).not.toContain('fortnox_create_invoice');
      expect(readOnlyNames).not.toContain('fortnox_invoice_pdf');
    } finally {
      await full.close();
      await readOnly.close();
    }
  });

  it('rejects calls to omitted mutation tools as unknown tools', async () => {
    const { client, close } = await connect(true);
    try {
      // The SDK reports an unregistered tool as an error result, not a transport failure.
      const result = await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: { confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/not found/i);
    } finally {
      await close();
    }
  });

  it('defaults to the full server when no option is given', async () => {
    const { client, close } = await connect();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('fortnox_create_invoice');
    } finally {
      await close();
    }
  });
});

describe('capability resource mode', () => {
  async function readCapabilities(readOnly?: boolean) {
    const { client, close } = await connect(readOnly);
    try {
      const result = await client.readResource({ uri: CAPABILITY_RESOURCE_URI });
      return JSON.parse((result.contents[0] as { text: string }).text) as {
        mode: string;
        tools: { name: string; access: string }[];
        workflows: { mutations: { confirmation: string; dryRun: string } };
      };
    } finally {
      await close();
    }
  }

  it('reports read-only mode and lists only read tools', async () => {
    const capabilities = await readCapabilities(true);
    expect(capabilities.mode).toBe('read-only');
    expect(capabilities.tools.length).toBeGreaterThan(90);
    expect(capabilities.tools.filter((tool) => tool.access !== 'read')).toEqual([]);
    expect(capabilities.tools.map((tool) => tool.name)).not.toContain('fortnox_create_invoice');
  });

  it('does not claim that confirm-gated mutation tools exist in read-only mode', async () => {
    const capabilities = await readCapabilities(true);
    const text = JSON.stringify(capabilities.workflows);
    expect(text).not.toContain('confirm: true');
    expect(text).not.toContain('dryRun: true');
    expect(capabilities.workflows.mutations.confirmation).toMatch(/skrivskyddat/i);
  });

  it('reports full mode and keeps mutation guidance on the default server', async () => {
    const capabilities = await readCapabilities();
    expect(capabilities.mode).toBe('full');
    expect(capabilities.workflows.mutations.confirmation).toContain('confirm: true');
    expect(capabilities.tools.map((tool) => tool.access)).toContain('potential-mutation');
  });
});

describe('startMcpServer read-only environment', () => {
  let origReadOnly: string | undefined;

  beforeEach(() => {
    origReadOnly = process.env['NOXCTL_READ_ONLY'];
  });

  afterEach(() => {
    if (origReadOnly === undefined) delete process.env['NOXCTL_READ_ONLY'];
    else process.env['NOXCTL_READ_ONLY'] = origReadOnly;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fails closed with exit code 2 and a clear message for an invalid value', async () => {
    process.env['NOXCTL_READ_ONLY'] = 'yes';
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { startMcpServer } = await import('../src/index.js');

    await startMcpServer({ profile: 'default' });

    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join('')).toContain('NOXCTL_READ_ONLY');
    expect(writes.join('')).toMatch(/1.*true|true.*1/);
  });
});
