/** Explicit staged writes for an embedding host with its own authenticated caller boundary. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FortnoxTransport } from './fortnox-client.js';
import { createServer } from './index.js';
import { parseStrictToolInput } from './strict-mcp-server.js';
import { canonicalEncode, decode } from './shadow/codec.js';
import { openShadowQueue, type ShadowQueue } from './shadow/queue.js';
import type { ShadowBinding } from './shadow/types.js';

export interface StagedAuthorizationContext {
  readonly actorId: string;
  readonly binding: Readonly<ShadowBinding>;
  readonly action: 'prepare' | 'execute' | 'get' | 'list' | 'status';
  readonly intentId?: string;
}
export interface CreateStagedServerOptions {
  transport: FortnoxTransport;
  directory: string;
  binding: ShadowBinding;
  actorId: string;
  /** SHA256 of the reviewed host artifact, supplied and verified by the embedding host. */
  revision: string;
  maxPreparationAgeMs: number;
  /** Host must authenticate the caller before connecting MCP; literal true grants this action. */
  authorize: (context: StagedAuthorizationContext) => boolean | Promise<boolean>;
  /**
   * Optional host check of the planned call, run before the call is saved (prepare) and again
   * before Fortnox is contacted (execute). Return a reason to refuse; the reason reaches the
   * caller in the tool error.
   */
  preflight?: (call: {
    tool: string;
    operation: string;
    args: Readonly<Record<string, unknown>>;
  }) => string | undefined | Promise<string | undefined>;
  /**
   * Also stage `fortnox_create_invoice_payment`. Default false: a payment record cannot be
   * refused by the operator, so a host enables this only together with a payment drain.
   */
  enableInvoicePayments?: boolean;
  /**
   * The host asserts that every staged_prepare/staged_execute is serialized with all other
   * pilot mutations (the pilot host's pilot.lock), so an execute-time preflight cannot race.
   * Required, together with `preflight`, when `enableInvoicePayments` is true.
   */
  serializedExecution?: boolean;
  now?: () => number;
}
export interface StagedServer {
  server: McpServer;
  /** Trusted host access for existing explicit target worker/reconciliation contracts. */
  queue: ShadowQueue;
  /** Refuses while an execute call is active. Interrupted work must be reconciled after restart. */
  close(): Promise<void>;
}
interface PreparedCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  state: 'prepared' | 'executing' | 'unknown' | 'completed';
  result?: CallToolResult;
}
const baseAllowed: ReadonlyArray<readonly [string, string]> = [
  ['fortnox_create_customer', 'createCustomer'],
  ['fortnox_create_invoice', 'createInvoice'],
];
/** Opt-in (NOX-211): off until the host can also drain, preview and reconcile payments. */
const paymentAllowed: ReadonlyArray<readonly [string, string]> = [
  ['fortnox_create_invoice_payment', 'createInvoicePayment'],
];
const copy = <T>(value: T): T => decode(canonicalEncode(value)) as T;
function identity(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value))
    throw new StagedHostError('Invalid fixed staged identity');
}
function privateFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new StagedHostError('Staged files must be private owned regular files');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
class StagedHostError extends Error {}
function stopped(error: unknown): CallToolResult {
  const detail = error instanceof StagedHostError ? error.message : 'Internal error';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Anropet stoppades (${detail}). Läs det sparade anropets status och stäm av eventuellt okänt utfall innan en ny åtgärd förbereds.`,
      },
    ],
  };
}

export async function createStagedServer(
  options: CreateStagedServerOptions,
): Promise<StagedServer> {
  if (!options?.transport || typeof options.authorize !== 'function')
    throw new StagedHostError(
      'Staged server requires a tenant-bound transport and host authorization',
    );
  identity(options.actorId);
  identity(options.binding?.sourceCompany);
  identity(options.binding?.targetCompany);
  if (!/^[a-f0-9]{64}$/.test(options.revision))
    throw new StagedHostError('Invalid staged artifact SHA256');
  if (
    !Number.isSafeInteger(options.maxPreparationAgeMs) ||
    options.maxPreparationAgeMs < 1_000 ||
    options.maxPreparationAgeMs > 86_400_000
  )
    throw new StagedHostError('Preparation lifetime must be between one second and one day');
  const config = Object.freeze({
    actorId: options.actorId,
    binding: Object.freeze(copy(options.binding)),
    revision: options.revision,
    maxPreparationAgeMs: options.maxPreparationAgeMs,
  });
  if (
    options.enableInvoicePayments === true &&
    (typeof options.preflight !== 'function' || options.serializedExecution !== true)
  )
    throw new StagedHostError(
      'Invoice payment staging requires a host preflight and serialized execution',
    );
  const allowed = new Map(
    options.enableInvoicePayments === true ? [...baseAllowed, ...paymentAllowed] : baseAllowed,
  );
  const authorize = options.authorize;
  const preflight = options.preflight;
  const clock = options.now ?? Date.now;
  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 86_400_000)
      throw new StagedHostError('Invalid staged clock');
    return value;
  }
  now();
  if (process.platform === 'win32')
    throw new StagedHostError(
      'Staged server is supported on macOS and Linux only (needs POSIX private directories)',
    );
  const root = resolve(options.directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new StagedHostError('Staged server requires a private owned directory');
  const path = join(root, 'staged.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) privateFile(path + suffix);
  const { DatabaseSync: SqliteDatabase } = await import('node:sqlite');
  const db = new SqliteDatabase(path);
  let queue: ShadowQueue | undefined;
  let inner: McpServer | undefined;
  let client: Client | undefined;
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS staged_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);' +
        'CREATE TABLE IF NOT EXISTS staged_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, record TEXT NOT NULL);',
    );
    const expected = canonicalEncode({ version: 1, ...config });
    db.prepare('INSERT OR IGNORE INTO staged_binding(singleton,value) VALUES(1,?)').run(expected);
    if (db.prepare('SELECT value FROM staged_binding WHERE singleton=1').get()?.value !== expected)
      throw new StagedHostError('Staged host binding mismatch');
    queue = await openShadowQueue(join(root, 'queue'), config.binding, now);
    const boundQueue = queue;
    let closed = false;
    let active = 0;
    const scope = new AsyncLocalStorage<{
      id: string;
      operation: string;
      observed: boolean;
      createdAt: number;
      expiresAt: number;
    }>();
    async function permit(action: StagedAuthorizationContext['action'], intentId?: string) {
      if (closed) throw new StagedHostError('Staged host closed');
      const context = Object.freeze({ ...config, action, intentId });
      if ((await authorize(context)) !== true)
        throw new StagedHostError('Staged authorization denied');
      if (closed) throw new StagedHostError('Staged host closed');
    }
    inner = createServer({
      transport: options.transport,
      observer: {
        status: () => boundQueue.status(),
        execute: async (operation, args, invoke) => {
          const context = scope.getStore();
          if (!context || context.operation !== operation || context.observed)
            throw new StagedHostError('Unexpected staged child operation');
          context.observed = true;
          await permit('execute', context.id);
          const time = now();
          if (time < context.createdAt || time >= context.expiresAt)
            throw new StagedHostError('Preparation expired before dispatch');
          return boundQueue.execute({ id: `${context.id}:0`, operation, args }, invoke);
        },
      },
    });
    const innerServer = inner;
    client = new Client({ name: 'noxctl-staged-internal', version: '1.0.0' });
    const innerClient = client;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([innerServer.connect(st), innerClient.connect(ct)]);
    const server = new McpServer({ name: 'noxctl-staged', version: '1.0.0' });
    const get = (id: string): PreparedCall | undefined => {
      const row = db.prepare('SELECT state,record FROM staged_calls WHERE id=?').get(id);
      return row
        ? {
            ...(decode(row.record as string) as PreparedCall),
            state: row.state as PreparedCall['state'],
          }
        : undefined;
    };
    const save = (record: PreparedCall) => {
      db.prepare('UPDATE staged_calls SET state=?,record=? WHERE id=?').run(
        record.state,
        canonicalEncode(record),
        record.id,
      );
    };
    async function runPreflight(tool: string, args: Record<string, unknown>): Promise<void> {
      const reason = await preflight?.({ tool, operation: allowed.get(tool)!, args: copy(args) });
      if (reason !== undefined) throw new StagedHostError(`Preflight refused: ${reason}`);
    }
    async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
      try {
        return await fn();
      } catch (error) {
        // Raw provider, authorization and persistence exception values are never MCP output.
        // Durable states, rather than retryable error strings, determine recovery.
        return stopped(error);
      }
    }
    server.registerTool(
      'staged_prepare',
      {
        description: 'Validera och spara ett exakt anrop utan att skriva till Fortnox.',
        inputSchema: z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()) }),
      },
      ({ tool, args }) =>
        guarded(async () => {
          await permit('prepare');
          if (!allowed.has(tool)) throw new StagedHostError('Tool outside staged contract');
          if (Buffer.byteLength(canonicalEncode(args)) > 65_536)
            throw new StagedHostError('Arguments too large');
          let normalized: Record<string, unknown>;
          try {
            normalized = parseStrictToolInput(innerServer, tool, copy(args));
          } catch (error) {
            if (!(error instanceof z.ZodError)) throw error;
            throw new StagedHostError(
              `Invalid input: ${error.issues
                .slice(0, 8)
                .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
                .join('; ')}`,
            );
          }
          if (normalized.confirm !== true || normalized.dryRun === true)
            throw new StagedHostError('Prepared call must be confirmed and not a dry run');
          await runPreflight(tool, normalized);
          const createdAt = now();
          const record: PreparedCall = {
            id: randomUUID(),
            tool,
            args: normalized,
            createdAt,
            expiresAt: createdAt + config.maxPreparationAgeMs,
            state: 'prepared',
          };
          db.prepare('INSERT INTO staged_calls(id,state,record) VALUES(?,?,?)').run(
            record.id,
            record.state,
            canonicalEncode(record),
          );
          return json(record);
        }),
    );
    server.registerTool(
      'staged_execute',
      {
        description: 'Verkställ det sparade anropets ID med uttrycklig bekräftelse.',
        inputSchema: z.strictObject({ id: z.uuid(), confirm: z.boolean().optional() }),
      },
      ({ id, confirm }) =>
        guarded(async () => {
          await permit('execute', id);
          if (confirm !== true) throw new StagedHostError('Explicit confirmation required');
          const planned = get(id);
          if (planned?.state === 'prepared') await runPreflight(planned.tool, planned.args);
          const claim = transaction(db, () => {
            const record = get(id);
            if (!record) throw new StagedHostError('Unknown intent');
            if (record.state === 'completed') return { replay: true, record };
            if (record.state !== 'prepared') throw new StagedHostError('Execution unresolved');
            const time = now();
            if (time < record.createdAt || time >= record.expiresAt)
              throw new StagedHostError('Preparation expired');
            record.state = 'executing';
            save(record);
            return { replay: false, record };
          });
          if (claim.replay) return copy(CallToolResultSchema.parse(claim.record.result));
          active++;
          try {
            const context = {
              id,
              operation: allowed.get(claim.record.tool)!,
              observed: false,
              createdAt: claim.record.createdAt,
              expiresAt: claim.record.expiresAt,
            };
            const innerResult = await scope.run(context, async () =>
              CallToolResultSchema.parse(
                await innerClient.callTool({
                  name: claim.record.tool,
                  arguments: copy(claim.record.args),
                }),
              ),
            );
            const sourceState = boundQueue.get(`${id}:0`)?.state;
            if (
              !sourceState ||
              ['prepared', 'source_unknown', 'source_in_flight'].includes(sourceState)
            )
              throw new StagedHostError('Source outcome unresolved');
            // The inner SDK serializes thrown callback errors into isError content.
            // Never persist or relay raw authorization/provider/formatting diagnostics.
            const result = innerResult.isError
              ? stopped(
                  new StagedHostError('Source tool response failed; inspect durable receipts'),
                )
              : innerResult;
            if (Buffer.byteLength(canonicalEncode(result)) > 2_097_152)
              throw new StagedHostError('Result too large');
            save({ ...claim.record, state: 'completed', result });
            return copy(result);
          } catch (error) {
            try {
              save({ ...claim.record, state: 'unknown' });
            } catch (persistenceError) {
              throw new AggregateError(
                [error, persistenceError],
                'Outcome and persistence unresolved',
              );
            }
            throw error;
          } finally {
            active--;
          }
        }),
    );
    server.registerTool(
      'staged_get',
      {
        description: 'Läs ett sparat anrop och dess MCP-kvitto.',
        inputSchema: z.strictObject({ id: z.uuid() }),
      },
      ({ id }) =>
        guarded(async () => {
          await permit('get', id);
          return json(get(id) ?? { missing: true });
        }),
    );
    server.registerTool(
      'staged_list',
      {
        description: 'Lista en begränsad sida med anrop, utan affärsargument eller kvitton.',
        inputSchema: z.strictObject({
          cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      },
      ({ cursor = 0, limit = 25 }) =>
        guarded(async () => {
          await permit('list');
          const rows = db
            .prepare('SELECT seq,id FROM staged_calls WHERE seq>? ORDER BY seq LIMIT ?')
            .all(cursor, limit + 1);
          const page = rows.slice(0, limit);
          const items = page.map((row) => {
            const { id, tool, state, createdAt, expiresAt } = get(row.id as string)!;
            return { id, tool, state, createdAt, expiresAt, cursor: Number(row.seq) };
          });
          return json({ items, nextCursor: rows.length > limit ? items.at(-1)!.cursor : null });
        }),
    );
    server.registerTool(
      'fortnox_shadow_status',
      {
        description: 'Visa köantal och eftersläpning för det bundna målföretaget.',
        inputSchema: z.strictObject({}),
      },
      () =>
        guarded(async () => {
          await permit('status');
          const status = boundQueue.summary();
          return json({
            enabled: true,
            binding: status.binding,
            counts: status.counts,
            oldestUnappliedAgeMs: status.oldestUnappliedAgeMs,
          });
        }),
    );
    return {
      server,
      queue: boundQueue,
      close: async () => {
        if (closed) return;
        if (active) throw new StagedHostError('Cannot close staged server during execution');
        closed = true;
        const results = await Promise.allSettled([
          server.close(),
          innerClient.close(),
          innerServer.close(),
        ]);
        boundQueue.close();
        db.close();
        const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
        if (errors.length) throw new AggregateError(errors, 'Staged shutdown failed');
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([client?.close(), inner?.close()]);
    queue?.close();
    db.close();
    const errors = cleanup.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length) throw new AggregateError([error, ...errors], 'Staged startup failed');
    throw error;
  }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
