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
});
