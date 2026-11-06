import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createStagedServer } from '../../src/embedded.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowStatus } from '../../src/shadow/types.js';
import type { StagedAuthorizationContext } from '../../src/embedded.js';
import type { ShadowAdapter } from '../../src/shadow/types.js';

const binding = { sourceCompany: 'summary-source', targetCompany: 'summary-target' };
const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'noxctl-shadow-summary-'));
  roots.push(path);
  return path;
}

function adapter(): ShadowAdapter {
  return {
    prepare: () => ({ request: { name: 'fixture' } }),
    apply: vi.fn().mockResolvedValue({ targetId: 'target-1', receipt: { id: 'target-1' } }),
    verify: vi.fn().mockResolvedValue(true),
  };
}

function projection(status: ShadowStatus) {
  const { items: _items, ...summary } = status;
  return summary;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('shadow queue summary', () => {
  it('matches the status projection for an empty queue and after restart', async () => {
    const path = root();
    let queue = await openShadowQueue(path, binding, () => 1000);
    let closed = false;
    try {
      expect(queue.summary()).toEqual(projection(queue.status()));
      queue.close();
      closed = true;

      queue = await openShadowQueue(path, binding, () => 1500);
      closed = false;
      expect(queue.summary()).toEqual(projection(queue.status()));
    } finally {
      if (!closed) queue.close();
    }
  });

  it('summarizes mixed states, clamps clock rollback, survives restart, and ignores corrupt applied receipts', async () => {
    let now = 1000;
    const path = root();
    let queue = await openShadowQueue(path, binding, () => now);
    let closed = false;
    try {
      await queue.execute({ id: 'applied', operation: 'createCustomer', args: [] }, async () => ({
        sourceId: 'source-1',
      }));
      expect(await queue.drainOne(adapter())).toBe(true);

      now = 2000;
      await queue.execute({ id: 'blocked', operation: 'createCustomer', args: [] }, async () => ({
        sourceId: 'source-2',
      }));
      const blockedAdapter = adapter();
      blockedAdapter.prepare = () => ({ blocked: 'unsupported fixture' });
      expect(await queue.drainOne(blockedAdapter)).toBe(false);

      // Later insertion has an earlier clock value; oldest follows sequence, not MIN(time).
      now = 500;
      await queue.execute({ id: 'pending', operation: 'createCustomer', args: [] }, async () => ({
        sourceId: 'source-3',
      }));
      expect(queue.get('applied')?.state).toBe('applied');
      expect(queue.get('blocked')?.state).toBe('blocked');
      expect(queue.get('pending')?.state).toBe('pending');

      now = 5000;
      expect(queue.summary()).toEqual(projection(queue.status()));
      expect(queue.summary()).toMatchObject({
        enabled: true,
        binding,
        counts: { pending: 1, applied: 1, blocked: 1 },
        oldestUnappliedAgeMs: 3000,
      });

      now = 1500;
      expect(queue.summary().oldestUnappliedAgeMs).toBe(0);
      queue.close();
      closed = true;

      now = 5000;
      queue = await openShadowQueue(path, binding, () => now);
      closed = false;
      expect(queue.summary()).toMatchObject({
        enabled: true,
        binding,
        counts: { pending: 1, applied: 1, blocked: 1 },
        oldestUnappliedAgeMs: 3000,
      });

      // Only the first unapplied receipt is needed, not applied or later pending payloads.
      const fault = new DatabaseSync(join(path, 'shadow.sqlite'));
      try {
        fault
          .prepare('UPDATE intents SET record=? WHERE id=?')
          .run('{malformed applied receipt', 'applied');
        fault
          .prepare('UPDATE intents SET record=? WHERE id=?')
          .run('{malformed later pending receipt', 'pending');
      } finally {
        fault.close();
      }
      expect(queue.summary()).toMatchObject({
        counts: { pending: 1, applied: 1, blocked: 1 },
        oldestUnappliedAgeMs: 3000,
      });
    } finally {
      if (!closed) queue.close();
    }
  });

  it('serves staged MCP status through the queue summary', async () => {
    const directory = root();
    const transport = {
      request: vi.fn(async () => ({})),
      requestWithMetadata: vi.fn(),
      requestPdf: vi.fn(),
      requestPdfFromMutation: vi.fn(),
      requestFile: vi.fn(),
      fetchAllPages: vi.fn(),
    } as unknown as FortnoxTransport;
    const authorize = vi.fn((_context: StagedAuthorizationContext) => true);
    const runtime = await createStagedServer({
      transport,
      directory,
      binding,
      actorId: 'summary-test-actor',
      revision: 'a'.repeat(64),
      maxPreparationAgeMs: 60_000,
      authorize,
    });
    const client = new Client({ name: 'shadow-summary-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
      vi.spyOn(runtime.queue, 'status').mockImplementation(() => {
        throw new Error('legacy status materialized receipt items');
      });
      const result = (await client.callTool({
        name: 'fortnox_shadow_status',
        arguments: {},
      })) as CallToolResult;
      const text = result.content?.find((item) => item.type === 'text');
      expect(text && 'text' in text ? JSON.parse(text.text) : null).toMatchObject({
        enabled: true,
        binding,
        counts: { pending: 0, applied: 0 },
        oldestUnappliedAgeMs: null,
      });
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'status' }));
    } finally {
      await client.close();
      await runtime.close();
    }
  });
});
