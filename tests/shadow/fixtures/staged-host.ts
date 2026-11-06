/** Local test prototype only. Not exported, installed, or enabled by CLI serve. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createServer } from '../../../src/embedded.js';
import type { FortnoxTransport } from '../../../src/fortnox-client.js';
import { canonicalEncode, decode } from '../../../src/shadow/codec.js';
import { createQueueObserver } from '../../../src/shadow/observer.js';
import type { ShadowQueue } from '../../../src/shadow/queue.js';
import type { ShadowBinding } from '../../../src/shadow/types.js';

type StageState = 'prepared' | 'executing' | 'unknown' | 'completed';
export interface StagedCall {
  id: string;
  state: StageState;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
  binding: ShadowBinding;
  result?: CallToolResult;
}
type Invoke = (record: StagedCall) => Promise<CallToolResult>;
const allowedTools = new Set(['fortnox_create_customer', 'fortnox_create_invoice']);
const copy = <T>(value: T): T => decode(canonicalEncode(value)) as T;

/** Caller supplies a private, disposable prototype database, never a live database. */
export class StagedCallStore {
  readonly binding: Readonly<ShadowBinding>;
  constructor(
    private readonly db: DatabaseSync,
    binding: ShadowBinding,
    revision: string,
  ) {
    if (!binding.sourceCompany || !binding.targetCompany || !revision)
      throw new Error('Missing fixed host binding or revision');
    this.binding = Object.freeze(copy(binding));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS staged_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS staged_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, record TEXT NOT NULL);',
    );
    const expected = canonicalEncode({ version: 1, ...binding, revision });
    db.prepare('INSERT OR IGNORE INTO staged_binding(singleton,value) VALUES(1,?)').run(expected);
    if (db.prepare('SELECT value FROM staged_binding WHERE singleton=1').get()?.value !== expected)
      throw new Error('Staged host binding or revision mismatch');
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): StagedCall | undefined {
    const row = this.db.prepare('SELECT state,record FROM staged_calls WHERE id=?').get(id);
    return row
      ? { ...(decode(row.record as string) as StagedCall), state: row.state as StageState }
      : undefined;
  }

  list(): StagedCall[] {
    return this.db
      .prepare('SELECT id FROM staged_calls ORDER BY seq')
      .all()
      .map((row) => this.get(row.id as string)!);
  }

  prepare(tool: string, args: Record<string, unknown>): StagedCall & { state: 'prepared' } {
    if (!allowedTools.has(tool)) throw new Error('Tool outside prototype allowlist');
    const immutable = copy(args);
    if (
      immutable.confirm !== true ||
      (immutable.dryRun !== undefined && immutable.dryRun !== false)
    )
      throw new Error('Prepared business call requires confirm=true and no dry run');
    const record: StagedCall & { state: 'prepared' } = {
      id: randomUUID(),
      state: 'prepared',
      tool,
      args: immutable,
      createdAt: Date.now(),
      binding: copy(this.binding),
    };
    this.db
      .prepare('INSERT INTO staged_calls(id,state,record) VALUES(?,?,?)')
      .run(record.id, record.state, canonicalEncode(record));
    return copy(record);
  }

  private save(record: StagedCall): void {
    this.db
      .prepare('UPDATE staged_calls SET state=?,record=? WHERE id=?')
      .run(record.state, canonicalEncode(record), record.id);
  }

  async execute(id: string, confirmed: boolean, invoke: Invoke): Promise<CallToolResult> {
    if (confirmed !== true) throw new Error('Explicit execution confirmation required');
    const claim = this.transaction(() => {
      const record = this.get(id);
      if (!record) throw new Error('Unknown prepared call');
      if (record.state === 'completed') return { replay: true, record };
      if (record.state !== 'prepared')
        throw new Error('Execution is in flight or unknown; reconcile before retry');
      record.state = 'executing';
      this.save(record);
      return { replay: false, record };
    });
    if (claim.replay) return copy(CallToolResultSchema.parse(claim.record.result));
    try {
      // Persist the exact source MCP result, including an explicit isError result.
      // A thrown or interrupted invocation remains unknown and is never re-run.
      const result = CallToolResultSchema.parse(await invoke(copy(claim.record)));
      this.save({ ...claim.record, state: 'completed', result });
      return copy(result);
    } catch (error) {
      try {
        this.save({ ...claim.record, state: 'unknown' });
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          'Staged outcome unknown and persistence failed',
        );
      }
      throw error;
    }
  }
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function guarded<T extends unknown[]>(fn: (...args: T) => Promise<CallToolResult>) {
  return async (...args: T): Promise<CallToolResult> => {
    try {
      return await fn(...args);
    } catch (error) {
      // Avoid exposing provider exception details from a tool response.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Staged operation stopped (${error instanceof Error ? error.name : 'UnknownError'}); inspect the bound intent status before retry.`,
          },
        ],
      };
    }
  };
}

/** Only explicit staged control tools are exposed by this test gateway. */
export function createStagedHost(
  store: StagedCallStore,
  invoke: Invoke,
  shadowStatus?: () => unknown,
): McpServer {
  const server = new McpServer({ name: 'synthetic-staged-host', version: '0.0.0-test' });
  server.registerTool(
    'staged_prepare',
    {
      description: 'Förbered ett exakt syntetiskt anrop utan att verkställa det.',
      inputSchema: z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
    },
    guarded(async ({ tool, args }: { tool: string; args: Record<string, unknown> }) =>
      text(store.prepare(tool, args)),
    ),
  );
  server.registerTool(
    'staged_execute',
    {
      description: 'Verkställ ett tidigare förberett syntetiskt anrop med uttrycklig bekräftelse.',
      inputSchema: z.strictObject({ id: z.uuid(), confirm: z.boolean().optional() }),
    },
    guarded(async ({ id, confirm }: { id: string; confirm?: boolean }) =>
      store.execute(id, confirm === true, invoke),
    ),
  );
  server.registerTool(
    'staged_get',
    {
      description: 'Läs ett beständigt syntetiskt anrops status och kvitto.',
      inputSchema: z.strictObject({ id: z.uuid() }),
    },
    guarded(async ({ id }: { id: string }) => text(store.get(id) ?? { missing: true })),
  );
  server.registerTool(
    'staged_list',
    {
      description: 'Lista förberedda syntetiska anrop i den bundna värden.',
      inputSchema: z.strictObject({}),
    },
    guarded(async () => text(store.list())),
  );
  if (shadowStatus)
    server.registerTool(
      'fortnox_shadow_status',
      {
        description: 'Läs eftersläpning från den fasta syntetiska kön.',
        inputSchema: z.strictObject({}),
      },
      guarded(async () => text(shadowStatus())),
    );
  return server;
}

/** Real embedded SDK transport with a private per-execution async scope. */
export async function createStagedInvoker(queue: ShadowQueue, transport: FortnoxTransport) {
  const scope = new AsyncLocalStorage<{ id: string; index: number }>();
  const observer = createQueueObserver(queue, () => {
    const active = scope.getStore();
    if (!active) throw new Error('Missing logical execution scope');
    return `${active.id}:${active.index++}`;
  });
  const server = createServer({ transport, observer });
  const client = new Client({ name: 'synthetic-internal-staged-invoker', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    invoke: async (record: StagedCall): Promise<CallToolResult> => {
      if (canonicalEncode(record.binding) !== canonicalEncode(queue.binding))
        throw new Error('Staged source queue binding mismatch');
      return scope.run({ id: record.id, index: 0 }, async () =>
        CallToolResultSchema.parse(
          await client.callTool({ name: record.tool, arguments: record.args }),
        ),
      );
    },
    status: () => queue.status(),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
