/**
 * Unpublished pilot host (NOX-214). Binds one Fortnox company to one Accounted company, opens the
 * staged server, and owns the write gate, backups and restore acknowledgement. Nothing here runs
 * automatically: every Accounted write is an explicit operator command.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { canonicalEncode } from '../shadow/codec.js';
import {
  AccountedMasterDataAdapter,
  type AccountedRequestCallback,
} from '../shadow/accounted-adapter.js';
import { AccountedArticleLinkAdapter } from '../shadow/article-link-adapter.js';
import { AccountedInvoiceDraftAdapter } from '../shadow/invoice-draft-adapter.js';
import type { ShadowQueue } from '../shadow/queue.js';
import type { ShadowAdapter } from '../shadow/types.js';
import { createStagedServer, type StagedServer } from '../staged-server.js';
import { checkFortnoxCompany, checkWriteGate, type GateResult } from './gate.js';

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
  checkGate(exceptId?: string): Promise<GateResult>;
  isStorageOk(): boolean;
  /** Written before any mutation; removed only by a successful backup. */
  beginMutation(): void;
  /** Records the queue state and takes a backup. Never throws; failure flips the storage flag. */
  afterMutation(): Promise<BackupResult>;
  backup(): Promise<BackupResult>;
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
  const directory = resolve(config.directory);
  const binding = { sourceCompany: config.sourceCompany, targetCompany: config.targetCompany };
  const markerPath = join(directory, 'backup-pending');
  const ackPath = join(directory, 'ack.json');
  const stagedPath = join(directory, 'staged.sqlite');
  const queuePath = join(directory, 'queue', 'shadow.sqlite');
  const backupsRoot = join(directory, 'backups');
  let storageOk = true;
  let needsAck = false;
  let closed = false;
  let stagedDb: DatabaseSync | undefined;

  async function stagedCounts(excludeId?: string): Promise<{ executing: number; unknown: number }> {
    if (!stagedDb) {
      const { DatabaseSync } = await import('node:sqlite');
      stagedDb = new DatabaseSync(stagedPath);
      stagedDb.exec('PRAGMA busy_timeout=5000');
    }
    const rows = stagedDb
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

  async function authorize(context: { action: string; intentId?: string }): Promise<boolean> {
    // Reads of local durable state stay available while writes are refused.
    if (context.action === 'get' || context.action === 'list' || context.action === 'status')
      return true;
    const result = await gateWith(undefined, context.intentId);
    if (!result.ok) {
      log(`pilot: write refused: ${result.reason}`);
      return false;
    }
    if (context.action === 'execute') host.beginMutation();
    return true;
  }

  async function gateWith(exceptId?: string, stagedExclude?: string): Promise<GateResult> {
    const failures: string[] = [];
    let oldest: Extract<GateResult, { ok: false }>['oldest'];
    const queueGate = checkWriteGate({
      queue: host.queue,
      stagedStatus: await stagedCounts(stagedExclude),
      now,
      storageOk,
      exceptId,
    });
    if (!queueGate.ok) {
      failures.push(queueGate.reason);
      oldest = queueGate.oldest;
    }
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

  const staged = await createStagedServer({
    transport: deps.fortnox,
    directory,
    binding,
    actorId: 'pilot-operator',
    revision: config.revision,
    maxPreparationAgeMs: MAX_PREPARATION_MS,
    authorize: (context) => authorize(context),
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

  async function backup(): Promise<BackupResult> {
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
      rmSync(markerPath, { force: true });
      storageOk = true;
      return { ok: true, directory: dir };
    } catch (error) {
      storageOk = false;
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
    checkGate: (exceptId) => gateWith(exceptId),
    isStorageOk: () => storageOk,
    beginMutation() {
      writeFileSync(markerPath, String(now()), { mode: 0o600 });
      chmodSync(markerPath, 0o600);
    },
    async afterMutation() {
      try {
        recordState();
      } catch {
        storageOk = false;
        log('pilot: could not record the queue state; further writes are refused');
        return { ok: false, reason: 'queue state could not be recorded' };
      }
      return backup();
    },
    backup,
    acknowledge() {
      needsAck = false;
      recordState();
    },
    wrapTransport(inner) {
      const executing = new Set<string | number>();
      const wrapped: Transport = {
        start: () => inner.start(),
        close: () => inner.close(),
        async send(message: JSONRPCMessage, options) {
          const response = message as { id?: string | number; result?: unknown; error?: unknown };
          if (response.id !== undefined && ('result' in response || 'error' in response)) {
            if (executing.delete(response.id)) await host.afterMutation();
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
                if (
                  request.id !== undefined &&
                  request.method === 'tools/call' &&
                  request.params?.name === 'staged_execute'
                )
                  executing.add(request.id);
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
  storageOk = !existsSync(markerPath);
  if (!storageOk) log('pilot: a previous mutation has no completed backup; run `backup`');
  let acknowledged: string | undefined;
  try {
    acknowledged = (JSON.parse(readFileSync(ackPath, 'utf8')) as { fingerprint?: string })
      .fingerprint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') acknowledged = 'unreadable';
  }
  const current = fingerprint();
  const empty = host.queue.snapshot().length === 0;
  needsAck = acknowledged === undefined ? !empty : acknowledged !== current;
  if (needsAck) log('pilot: queue differs from the last acknowledged state; run `status`');
  return host;
}
