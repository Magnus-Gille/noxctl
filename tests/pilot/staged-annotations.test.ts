import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';
import { createStagedServer } from '../../src/staged-server.js';
import { classifyTool } from '../../src/tool-classification.js';
import { COMPANY, ORG, tempRoot } from './helpers.js';

// The exported staged server registers its tools directly, so its annotations are
// set by hand. This pins them, and pins that every tool its execute step can run
// is additive, which is what staged_execute's destructiveHint: false relies on.
const STAGED_EXECUTABLE_TOOLS = [
  'fortnox_create_customer',
  'fortnox_create_invoice',
  'fortnox_create_invoice_payment',
];

describe('staged server MCP annotations (NOX-199)', () => {
  it('annotates every public staged tool', async () => {
    const directory = join(tempRoot(), 'staged');
    mkdirSync(directory, { mode: 0o700 });
    const server = await createStagedServer({
      transport: createSyntheticFortnox(ORG).transport,
      directory,
      binding: { sourceCompany: ORG, targetCompany: COMPANY },
      actorId: 'tester',
      revision: 'a'.repeat(64),
      maxPreparationAgeMs: 60_000,
      authorize: () => true,
    });
    const client = new Client({ name: 'staged-annotations', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      expect(Object.keys(byName).sort()).toEqual([
        'fortnox_shadow_status',
        'staged_execute',
        'staged_get',
        'staged_list',
        'staged_prepare',
      ]);
      for (const name of ['staged_get', 'staged_list', 'fortnox_shadow_status']) {
        expect(byName[name], name).toEqual({ readOnlyHint: true, openWorldHint: false });
      }
      expect(byName['staged_prepare']).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(byName['staged_execute']).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('only stages tools that the shared classification treats as additive', () => {
    for (const name of STAGED_EXECUTABLE_TOOLS) {
      const { access, annotations } = classifyTool(name, ['confirm', 'dryRun']);
      expect(access, name).toBe('potential-mutation');
      expect(annotations.destructiveHint, name).toBe(false);
    }
  });
});
