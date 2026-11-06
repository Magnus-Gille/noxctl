/**
 * Unpublished pilot host (NOX-214). Binds one Fortnox company to one Accounted company, opens the
 * staged server, and owns the write gate, backups and restore acknowledgement. Nothing here runs
 * automatically: every Accounted write is an explicit operator command.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FortnoxTransport } from '../fortnox-client.js';
import { createFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { canonicalEncode, decode } from '../shadow/codec.js';
import {
  AccountedMasterDataAdapter,
  type AccountedRequestCallback,
} from '../shadow/accounted-adapter.js';
import { AccountedArticleLinkAdapter } from '../shadow/article-link-adapter.js';
import { AccountedInvoiceDraftAdapter } from '../shadow/invoice-draft-adapter.js';
import type { ShadowQueue } from '../shadow/queue.js';
import type { ShadowAdapter, ShadowRecord } from '../shadow/types.js';
import { createStagedServer, type StagedServer } from '../staged-server.js';
import { PilotNotDispatchedError } from './accounted-client.js';
import { checkFortnoxCompany, checkWriteGate, type GateResult } from './gate.js';
import {
  appendJournal,
  defaultHeadDir,
  fsyncDirectory,
  initializeJournal,
  journalPath,
  PilotRegistryError,
  pilotIdPath,
  verifyJournal,
  type Fsync,
  type JournalContext,
} from './journal.js';
import { acquirePilotLock, PilotLockError } from './lock.js';
import { isOperatorRefused } from '../shadow/operator-refusal.js';
import { preflightStagedCall } from './preflight.js';

export interface PilotConfig {
  version: 1;
  profile: string;
  directory: string;
  sourceCompany: string;
  targetCompany: string;
  accountedOrigin: string;
  keychainService: string;
  keychainAccount: string;
  revision: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG_KEYS = [
  'version',
  'profile',
  'directory',
  'sourceCompany',
  'targetCompany',
  'accountedOrigin',
  'keychainService',
  'keychainAccount',
  'revision',
];

/** Strict, credential-free operator configuration (same file rules as the local shadow config). */
export function loadPilotConfig(path: string): PilotConfig {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 8192 ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Pilot configuration must be an owned regular file, not writable by others');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid pilot configuration');
  const config = raw as Record<string, unknown>;
  if (
    Object.keys(config).length !== CONFIG_KEYS.length ||
    CONFIG_KEYS.some((key) => !(key in config)) ||
    config.version !== 1
  )
    throw new Error('Invalid pilot configuration fields/version');
  for (const key of CONFIG_KEYS.filter((key) => key !== 'version')) {
    const value = config[key];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 500 ||
      /[\x00-\x1f]/.test(value)
    )
      throw new Error(`Invalid pilot configuration: ${key}`);
  }
  if (!isAbsolute(config.directory as string)) throw new Error('Pilot directory must be absolute');
  if (!UUID.test(config.targetCompany as string))
    throw new Error('Pilot targetCompany must be a lowercase UUID');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(config.accountedOrigin as string))
    throw new Error('Pilot accountedOrigin must be exactly https://host[:port]');
  if (!/^[a-f0-9]{64}$/.test(config.revision as string))
    throw new Error('Pilot revision must be a SHA256 hex digest');
  return config as unknown as PilotConfig;
}

export interface PilotHostDeps {
  fortnox: FortnoxTransport;
  accounted: AccountedRequestCallback;
  now?: () => number;
  stderr?: (line: string) => void;
  osUser?: () => string;
  /** Directory of the independent journal head records (outside the state directory). */
  headDir?: string;
  /** Injectable fsync (tests); defaults to fs.fsyncSync. */
  fsync?: Fsync;
}
export type BackupResult = { ok: true; directory: string } | { ok: false; reason: string };

export interface PilotHost {
  readonly config: PilotConfig;
  readonly directory: string;
  readonly queue: ShadowQueue;
  readonly staged: StagedServer;
  readonly operations: FortnoxOperations;
  readonly now: () => number;
  readonly osUser: () => string;
  readonly log: (line: string) => void;
  adapterFor(operation: string): ShadowAdapter | undefined;
  /** Queue/storage/restore gate plus the Fortnox company identity read. */
  checkGate(exceptId?: string, exceptStates?: readonly string[]): Promise<GateResult>;
  isStorageOk(): boolean;
  /** Written (under the pilot lock) before any mutation; removed only by a successful backup. */
  beginMutation(): void;
  /** Records the queue state and takes a backup. Caller MUST hold the pilot lock. Never throws. */
  afterMutation(): Promise<BackupResult>;
  /** Takes the pilot lock itself; refused (not queued) while another operation holds it. */
  backup(): Promise<BackupResult>;
  /** Cross-process exclusive section. Throws PilotLockError when the lock exists; never waits. */
  withLock<T>(command: string, fn: () => Promise<T>): Promise<T>;
  /** Dispatch-journal hook: durable record BEFORE a target request; failure means nothing is sent. */
  journalTarget(record: ShadowRecord): void;
  /** Durable record that the operator refused an unmappable intent (after the queue change). */
  journalRefused(intentId: string): void;
  /** Operator has looked at the real state (`status`); lifts the restore/outside-change refusal. */
  acknowledge(): void;
  wrapTransport(transport: Transport): Transport;
  close(): Promise<void>;
}

const MAX_PREPARATION_MS = 10 * 60_000;

export async function createPilotHost(
  config: PilotConfig,
  deps: PilotHostDeps,
): Promise<PilotHost> {
  const now = deps.now ?? Date.now;
  const log = deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const osUser = deps.osUser ?? (() => process.env['USER'] ?? 'unknown');
  const fsync: Fsync = deps.fsync ?? fsyncSync;
  const directory = resolve(config.directory);
  const journalCtx: JournalContext = {
    directory,
    headDir: resolve(deps.headDir ?? defaultHeadDir()),
    fsync,
  };
  const binding = { sourceCompany: config.sourceCompany, targetCompany: config.targetCompany };
  const markerPath = join(directory, 'backup-pending');
  const ackPath = join(directory, 'ack.json');
  const stagedPath = join(directory, 'staged.sqlite');
  const queuePath = join(directory, 'queue', 'shadow.sqlite');
  const backupsRoot = join(directory, 'backups');
  let needsAck = false;
  /** Lock held by this process: a command (`kind: 'command'`) or one staged MCP request. */
  let held: { owner: string; release: () => void; mutating: boolean } | undefined;
  /** `token` is generated by the server per incoming request; client JSON-RPC ids are never trusted. */
  const requestScope = new AsyncLocalStorage<{ token: string }>();
  let closed = false;
  let initializationRefused: string | undefined;
  let stagedDb: DatabaseSync | undefined;

  async function stagedDatabase(): Promise<DatabaseSync> {
    if (!stagedDb) {
      const { DatabaseSync } = await import('node:sqlite');
      stagedDb = new DatabaseSync(stagedPath);
      stagedDb.exec('PRAGMA busy_timeout=5000');
    }
    return stagedDb;
  }
  async function stagedCounts(excludeId?: string): Promise<{ executing: number; unknown: number }> {
    const rows = (await stagedDatabase())
      .prepare(
        "SELECT state, COUNT(*) AS n FROM staged_calls WHERE state IN ('executing','unknown') AND id != ? GROUP BY state",
      )
      .all(excludeId ?? '');
    const count = (state: string) => Number(rows.find((row) => row.state === state)?.n ?? 0);
    return { executing: count('executing'), unknown: count('unknown') };
  }

  function fingerprint(): string {
    const parts = host.queue
      .snapshot()
      .map(({ sequence, record }) => [
        sequence,
        record.id,
        record.state,
        record.requestHash,
        record.targetId ?? null,
      ]);
    return createHash('sha256').update(canonicalEncode(parts)).digest('hex');
  }
  function writePrivate(path: string, content: string): void {
    const temp = `${path}.tmp`;
    writeFileSync(temp, content, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  }
  function recordState(): void {
    if (needsAck) return;
    writePrivate(ackPath, JSON.stringify({ version: 1, fingerprint: fingerprint(), at: now() }));
  }

  function releaseHeld(): void {
    const current = held;
    held = undefined;
    current?.release();
  }
  async function withLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
    if (held) throw new PilotLockError('another pilot operation is running in this process');
    const release = acquirePilotLock(directory, command, now());
    held = { owner: `command:${command}`, release, mutating: false };
    try {
      return await fn();
    } finally {
      releaseHeld();
    }
  }

  async function authorize(context: { action: string; intentId?: string }): Promise<boolean> {
    // Reads of local durable state stay available while writes are refused.
    if (context.action === 'get' || context.action === 'list' || context.action === 'status')
      return true;
    // Mutating staged actions hold the pilot lock from here until the response is sent
    // (released by wrapTransport), so a concurrent CLI command or backup is refused.
    const token = requestScope.getStore()?.token;
    if (token === undefined) {
      log('pilot: write refused: staged mutations are only served through the pilot transport');
      return false;
    }
    const owner = `request:${token}`;
    let acquired = false;
    if (!held) {
      try {
        held = {
          owner,
          release: acquirePilotLock(directory, `mcp:${context.action}`, now()),
          mutating: false,
        };
        acquired = true;
      } catch (error) {
        log(`pilot: write refused: ${error instanceof Error ? error.message : 'lock failed'}`);
        return false;
      }
    } else if (held.owner !== owner) {
      log('pilot: write refused: another pilot operation is running in this process');
      return false;
    }
    const result = await gateWith(undefined, context.intentId, held.mutating);
    if (!result.ok) {
      log(`pilot: write refused: ${result.reason}`);
      if (acquired) releaseHeld();
      return false;
    }
    if (context.action === 'execute') {
      if (!held.mutating) {
        try {
          host.beginMutation();
        } catch {
          log('pilot: write refused: backup marker could not be made durable');
          if (acquired) releaseHeld();
          return false;
        }
        held.mutating = true;
      } else if (context.intentId) {
        // Second authorization of the same execute, immediately before the Fortnox write.
        try {
          const row = (await stagedDatabase())
            .prepare('SELECT state FROM staged_calls WHERE id=?')
            .get(context.intentId);
          if (row?.state === 'executing')
            appendJournal(journalCtx, { kind: 'source', stagedId: context.intentId, at: now() });
        } catch {
          log('pilot: write refused: dispatch journal could not be written');
          return false;
        }
      }
    }
    return true;
  }

  const RECONCILE =
    'read-only reconciliation against Fortnox and Accounted is required before any write ' +
    '(see docs/pilot-host.md, "Restore and the dispatch journal"); there is no automatic override';
  const EXPECTED_OPERATION: Record<string, string> = {
    fortnox_create_customer: 'createCustomer',
    fortnox_create_invoice: 'createInvoice',
  };
  function stagedTool(record: unknown): string | undefined {
    try {
      const tool = (decode(String(record)) as { tool?: unknown }).tool;
      return typeof tool === 'string' ? tool : undefined;
    } catch {
      return undefined;
    }
  }
  /** Fail closed when the journal shows a dispatch that the databases do not (or no longer) show. */
  async function journalProblem(): Promise<string | undefined> {
    if (initializationRefused) return `${initializationRefused}; not re-initializing; ${RECONCILE}`;
    if (databaseMissingAtStartup)
      return `pilot-id exists but staged.sqlite or queue/shadow.sqlite was missing at startup; ${RECONCILE}`;
    const state = verifyJournal(journalCtx);
    if (!state.ok) return `${state.reason}; ${RECONCILE}`;
    const rows = (await stagedDatabase()).prepare('SELECT id,state,record FROM staged_calls').all();
    const stagedCalls = new Map(
      rows.map((row) => [
        String(row.id),
        { state: String(row.state), tool: stagedTool(row.record) },
      ]),
    );
    for (const entry of state.entries) {
      if (entry.kind === 'refused') {
        const refused = host.queue.get(entry.intentId);
        if (!refused || !isOperatorRefused(refused))
          return `journaled operator refusal ${entry.intentId} is ${refused?.state ?? 'absent'} in the queue (rollback?); ${RECONCILE}`;
        continue;
      }
      if (entry.kind === 'source') {
        const call = stagedCalls.get(entry.stagedId);
        if (call?.state !== 'executing' && call?.state !== 'unknown' && call?.state !== 'completed')
          return `journaled Fortnox write ${entry.stagedId} is ${call?.state ?? 'absent'} in the staged database (rollback?); ${RECONCILE}`;
        if (call.state === 'completed') {
          // A completed write must still have its queue receipt, for the expected operation.
          const receipt = host.queue.get(`${entry.stagedId}:0`);
          const expected = call.tool === undefined ? undefined : EXPECTED_OPERATION[call.tool];
          if (
            !receipt ||
            expected === undefined ||
            receipt.operation !== expected ||
            receipt.state === 'prepared' ||
            receipt.state === 'source_in_flight'
          )
            return `completed Fortnox write ${entry.stagedId} has no matching queue record (rollback?); ${RECONCILE}`;
        }
        continue;
      }
      const record = host.queue.get(entry.intentId);
      if (!record || record.requestHash !== entry.requestHash)
        return `journaled Accounted dispatch ${entry.intentId} is absent from the queue (rollback?); ${RECONCILE}`;
      // retry_wait is legitimate only if that very attempt was recorded as not dispatched.
      if (
        record.state === 'pending' ||
        (record.state === 'retry_wait' && (record.targetAttempts ?? 0) < entry.attempt)
      )
        return `journaled Accounted dispatch ${entry.intentId} is ${record.state} in the queue (rollback?); ${RECONCILE}`;
    }
    return undefined;
  }

  /** Intents with a `refused` journal entry whose queue record still shows the operator refusal. */
  function operatorRefusedIds(): ReadonlySet<string> {
    const state = verifyJournal(journalCtx);
    const ids = new Set<string>();
    if (!state.ok) return ids;
    for (const entry of state.entries) {
      if (entry.kind !== 'refused') continue;
      const record = host.queue.get(entry.intentId);
      if (record && isOperatorRefused(record)) ids.add(entry.intentId);
    }
    return ids;
  }

  const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  /** The newest backup must have a manifest whose sha256 values match its files. */
  function backupProblem(): string | undefined {
    if (!existsSync(backupsRoot)) return undefined;
    const newest = readdirSync(backupsRoot).sort(byName).at(-1);
    if (newest === undefined) return undefined;
    const dir = join(backupsRoot, newest);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        files?: Record<string, { sha256?: string; bytes?: number }>;
      };
      for (const name of ['staged.sqlite', 'shadow.sqlite']) {
        const entry = manifest.files?.[name];
        const content = readFileSync(join(dir, name));
        if (
          !entry ||
          entry.bytes !== content.length ||
          entry.sha256 !== createHash('sha256').update(content).digest('hex')
        )
          return `the newest backup ${newest} does not match its manifest; run \`backup\``;
      }
    } catch {
      return `the newest backup ${newest} is missing its manifest or files; run \`backup\``;
    }
    return undefined;
  }

  async function gateWith(
    exceptId?: string,
    stagedExclude?: string,
    ownMarker = false,
    exceptStates?: readonly string[],
  ): Promise<GateResult> {
    const failures: string[] = [];
    let oldest: Extract<GateResult, { ok: false }>['oldest'];
    const queueGate = checkWriteGate({
      queue: host.queue,
      stagedStatus: await stagedCounts(stagedExclude),
      now,
      // Re-read from disk on every check: another process may have begun a mutation.
      storageOk: ownMarker || !existsSync(markerPath),
      exceptId,
      ...(exceptStates ? { exceptStates } : {}),
      operatorRefused: operatorRefusedIds(),
    });
    if (!queueGate.ok) {
      failures.push(queueGate.reason);
      oldest = queueGate.oldest;
    }
    const journal = await journalProblem();
    if (journal) failures.push(journal);
    const backup = backupProblem();
    if (backup) failures.push(backup);
    if (needsAck)
      failures.push(
        'queue differs from the last acknowledged state (restore or outside change); run `status` to acknowledge',
      );
    if (failures.length === 0) {
      const company = await checkFortnoxCompany(deps.fortnox, config.sourceCompany);
      if (!company.ok) failures.push(company.reason);
    }
    return failures.length ? { ok: false, reason: failures.join('; '), oldest } : { ok: true };
  }

  // Checked BEFORE the opener below can silently create an empty database.
  const databaseMissingAtStartup =
    existsSync(pilotIdPath(directory)) && (!existsSync(stagedPath) || !existsSync(queuePath));
  const staged = await createStagedServer({
    transport: deps.fortnox,
    directory,
    binding,
    actorId: 'pilot-operator',
    revision: config.revision,
    maxPreparationAgeMs: MAX_PREPARATION_MS,
    authorize: (context) => authorize(context),
    preflight: ({ operation, args }) => {
      const reason = preflightStagedCall(
        {
          binding,
          adapterFor: (name) => host.adapterFor(name),
          resolveIdentity: (resource, sourceId) => host.queue.resolveIdentity(resource, sourceId),
          now,
        },
        operation,
        args,
      );
      if (reason !== undefined) log(`pilot: write refused: preflight: ${reason}`);
      return reason;
    },
    now,
  });
  const queue = staged.queue;

  const master = new AccountedMasterDataAdapter(binding, deps.accounted);
  const articles = new AccountedArticleLinkAdapter(config.targetCompany, deps.accounted);
  const invoices = new AccountedInvoiceDraftAdapter(
    binding,
    (kind, id) => queue.resolveIdentity(kind, id),
    deps.accounted,
  );

  async function backupLocked(): Promise<BackupResult> {
    let dir: string | undefined;
    try {
      mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      for (let n = 0; n < 20 && !dir; n++) {
        const candidate = join(backupsRoot, n === 0 ? stamp : `${stamp}-${n}`);
        try {
          mkdirSync(candidate, { mode: 0o700 });
          dir = candidate;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!dir) throw new Error('no free backup directory');
      const { DatabaseSync } = await import('node:sqlite');
      const files: Record<string, { sha256: string; bytes: number }> = {};
      for (const [name, source] of [
        ['staged.sqlite', stagedPath],
        ['shadow.sqlite', queuePath],
      ] as const) {
        const destination = join(dir, name);
        const db = new DatabaseSync(source);
        try {
          db.exec('PRAGMA busy_timeout=5000');
          db.prepare('VACUUM INTO ?').run(destination);
        } finally {
          db.close();
        }
        chmodSync(destination, 0o600);
        const check = new DatabaseSync(destination);
        try {
          if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
            throw new Error('backup integrity check failed');
        } finally {
          check.close();
        }
        const content = readFileSync(destination);
        files[name] = {
          sha256: createHash('sha256').update(content).digest('hex'),
          bytes: content.length,
        };
      }
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ version: 1, createdAt: now(), files }, null, 2), {
        mode: 0o600,
      });
      chmodSync(manifest, 0o600);
      // Durable before success: files and manifest, then the backup directory and its parent, and
      // only then the pending marker (and the marker's directory).
      for (const file of [join(dir, 'staged.sqlite'), join(dir, 'shadow.sqlite'), manifest]) {
        const fd = openSync(file, 'r+');
        try {
          fsync(fd);
        } finally {
          closeSync(fd);
        }
      }
      fsyncDirectory(dir, fsync);
      fsyncDirectory(backupsRoot, fsync);
      rmSync(markerPath, { force: true });
      fsyncDirectory(directory, fsync);
      return { ok: true, directory: dir };
    } catch (error) {
      try {
        writeFileSync(markerPath, String(now()), { mode: 0o600 });
      } catch {
        // marker may already exist; the gate keeps refusing until a backup succeeds
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      const reason = `backup failed (${code ?? (error instanceof Error ? error.name : 'Error')})`;
      log(`pilot: ${reason}; further writes are refused until a backup succeeds`);
      return { ok: false, reason };
    }
  }

  const host: PilotHost = {
    config,
    directory,
    queue,
    staged,
    operations: createFortnoxOperations(deps.fortnox),
    now,
    osUser,
    log,
    adapterFor(operation) {
      if (operation === 'createCustomer' || operation === 'baselineCustomer') return master;
      if (operation === 'baselineArticle') return articles;
      if (operation === 'createInvoice') return invoices;
      return undefined;
    },
    checkGate: (exceptId, exceptStates) => gateWith(exceptId, undefined, false, exceptStates),
    isStorageOk: () => !existsSync(markerPath) && backupProblem() === undefined,
    withLock,
    journalTarget(record) {
      try {
        appendJournal(journalCtx, {
          kind: 'target',
          intentId: record.id,
          requestHash: record.requestHash,
          attempt: record.targetAttempts ?? 0,
          at: now(),
        });
      } catch {
        throw new PilotNotDispatchedError('dispatch journal could not be written');
      }
    },
    journalRefused(intentId) {
      appendJournal(journalCtx, { kind: 'refused', intentId, at: now() });
    },
    beginMutation() {
      // Durable before the mutation proceeds; any failure throws and the caller refuses.
      writeFileSync(markerPath, String(now()), { mode: 0o600 });
      chmodSync(markerPath, 0o600);
      const fd = openSync(markerPath, 'r+');
      try {
        fsync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(directory, fsync);
    },
    async afterMutation() {
      try {
        recordState();
      } catch {
        log('pilot: could not record the queue state; further writes are refused');
        return { ok: false, reason: 'queue state could not be recorded' };
      }
      return backupLocked();
    },
    async backup() {
      try {
        return await withLock('backup', backupLocked);
      } catch (error) {
        if (error instanceof PilotLockError) return { ok: false, reason: error.message };
        throw error;
      }
    },
    acknowledge() {
      needsAck = false;
      recordState();
    },
    wrapTransport(inner) {
      /** In-flight requests (any method) by client id; the lock is keyed on the server-made token. */
      const inFlight = new Map<
        string | number,
        { token: string; tool: 'staged_execute' | 'staged_prepare' | undefined }
      >();
      const wrapped: Transport = {
        start: () => inner.start(),
        close: () => inner.close(),
        async send(message: JSONRPCMessage, options) {
          const response = message as { id?: string | number; result?: unknown; error?: unknown };
          if (response.id !== undefined && ('result' in response || 'error' in response)) {
            const entry = inFlight.get(response.id);
            // Duplicates are rejected on arrival, so this is the one entry of that request.
            inFlight.delete(response.id);
            if (entry?.tool && held?.owner === `request:${entry.token}`) {
              // Only the request that took the lock (and began the mutation) backs up, under it.
              try {
                if (entry.tool === 'staged_execute' && held.mutating) await host.afterMutation();
              } finally {
                releaseHeld();
              }
            }
          }
          return inner.send(message, options);
        },
        set onmessage(handler) {
          inner.onmessage = handler
            ? (message, extra) => {
                const request = message as {
                  id?: string | number;
                  method?: string;
                  params?: { name?: string };
                };
                if (request.id !== undefined && request.method !== undefined) {
                  if (inFlight.has(request.id)) {
                    // Never reaches the handler; sent on the inner transport so the original
                    // request's bookkeeping and lock are untouched.
                    void inner.send({
                      jsonrpc: '2.0',
                      id: request.id,
                      error: { code: -32600, message: 'Duplicate in-flight request id' },
                    });
                    return;
                  }
                  // Every request with an id is registered, whatever its method.
                  const name = request.params?.name;
                  const tool =
                    request.method === 'tools/call' &&
                    (name === 'staged_execute' || name === 'staged_prepare')
                      ? name
                      : undefined;
                  const token = randomUUID();
                  inFlight.set(request.id, { token, tool });
                  requestScope.run({ token }, () => handler(message, extra));
                  return;
                }
                handler(message, extra);
              }
            : undefined;
        },
        get onmessage() {
          return inner.onmessage;
        },
        set onclose(handler) {
          inner.onclose = handler;
        },
        get onclose() {
          return inner.onclose;
        },
        set onerror(handler) {
          inner.onerror = handler;
        },
        get onerror() {
          return inner.onerror;
        },
        get sessionId() {
          return inner.sessionId;
        },
        setProtocolVersion: inner.setProtocolVersion?.bind(inner),
      };
      return wrapped;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await staged.close();
      } finally {
        stagedDb?.close();
      }
    },
  };

  // Startup state: a leftover marker means a mutation began and no backup completed after it.
  if (existsSync(markerPath))
    log('pilot: a previous mutation has no completed backup; run `backup`');
  let acknowledged: string | undefined;
  try {
    acknowledged = (JSON.parse(readFileSync(ackPath, 'utf8')) as { fingerprint?: string })
      .fingerprint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') acknowledged = 'unreadable';
  }
  const current = fingerprint();
  const empty = host.queue.snapshot().length === 0;
  // Initialization (genesis + head record + pilot-id) only for a directory with no pilot-id, no
  // journal and empty databases. Anything else is judged by the gate, never repaired here.
  if (
    empty &&
    !existsSync(pilotIdPath(directory)) &&
    !existsSync(journalPath(directory)) &&
    (await stagedDatabase()).prepare('SELECT id FROM staged_calls LIMIT 1').all().length === 0
  )
    try {
      initializeJournal(journalCtx, now(), binding);
    } catch (error) {
      if (!(error instanceof PilotRegistryError)) throw error;
      initializationRefused = error.message;
    }
  needsAck = acknowledged === undefined ? !empty : acknowledged !== current;
  if (needsAck) log('pilot: queue differs from the last acknowledged state; run `status`');
  return host;
}
