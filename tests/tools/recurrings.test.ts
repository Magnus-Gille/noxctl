import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({ getValidToken: vi.fn().mockResolvedValue('mock-token') }));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
    headers: { get: () => null },
  });
}

async function client() {
  const server = createServer();
  const connected = new Client({ name: 'test-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), connected.connect(a)]);
  return connected;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe('recurring tools', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists recurrings with Swedish MCP parameters', async () => {
    mockFetch([{ id: 'id-1', serial_number: 4, status: 'ACTIVE' }]);
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_list_recurrings',
      arguments: { statuses: ['ACTIVE'] },
    });

    expect(textOf(result)).toContain('ACTIVE');
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'statuses=ACTIVE',
    );
  });

  it('requires confirmation before creating invoice requests', async () => {
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_create_recurring_invoice_request',
      arguments: { recurringIds: ['550e8400-e29b-41d4-a716-446655440000'] },
    });

    expect(result.isError).toBe(true);
  });

  it('preserves provider-defined create payloads end to end', async () => {
    mockFetch({ id: 'id-1', status: 'ACTIVE' });
    const input = {
      customer: { customer_number: '17', provider_extension: { mode: 'exact' } },
      rows: [{ article_number: 'A1', custom_value: 0 }],
    };
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_create_recurring',
      arguments: { input, confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(JSON.parse(init.body ?? 'null')).toEqual(input);
  });

  it('preserves provider-defined replacement payloads end to end', async () => {
    mockFetch({ id: '550e8400-e29b-41d4-a716-446655440000', status: 'ACTIVE' });
    const input = { status: 'ACTIVE', provider_extension: { retain: false } };
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_replace_recurring',
      arguments: {
        recurringId: '550e8400-e29b-41d4-a716-446655440000',
        etag: '"v1"',
        input,
        confirm: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      body?: string;
    };
    expect(JSON.parse(init.body ?? 'null')).toEqual(input);
  });

  it('rejects unknown fields in structured JSON Patch operations', async () => {
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_patch_recurring',
      arguments: {
        recurringId: '550e8400-e29b-41d4-a716-446655440000',
        etag: '"v1"',
        operations: [{ op: 'replace', path: '/status', value: 'ACTIVE', unexpected: true }],
        dryRun: true,
      },
    });
    expect(result.isError).toBe(true);
  });
});
