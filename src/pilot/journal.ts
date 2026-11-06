/**
 * Append-only, hash-chained dispatch journal (NOX-214), kept OUTSIDE the backed-up databases.
 * Backups never copy it and a restore never touches it, so a restored older database can be compared
 * with what was really dispatched. Entries are written (and fsynced) immediately before the external
 * write.
 *
 * Integrity: the first line is a genesis `{kind:'genesis',pilotId,createdAt}`; every later line
 * carries `seq` (1, 2, ...) and `prev` (sha256 of the previous raw line). An independent head record
 * `{pilotId,seq,hash}` of the last line lives OUTSIDE the state directory (see `headRecordPath`), so
 * an empty, truncated or replaced journal cannot pass as complete history.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JournalEntry =
  | { kind: 'target'; intentId: string; requestHash: string; attempt: number; at: number }
  | { kind: 'source'; stagedId: string; at: number };
export type ChainedEntry = JournalEntry & { seq: number; prev: string };
export interface HeadRecord {
  pilotId: string;
  seq: number;
  hash: string;
}
export type Fsync = (fd: number) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const journalDir = (directory: string) => join(directory, 'journal');
export const journalPath = (directory: string) => join(journalDir(directory), 'dispatch.jsonl');
export const pilotIdPath = (directory: string) => join(directory, 'pilot-id');
export const defaultHeadDir = () =>
  join(homedir(), 'Library', 'Application Support', 'noxctl-pilot');
export const headRecordPath = (headDir: string, pilotId: string) =>
  join(headDir, `${pilotId}.head.json`);

export interface JournalContext {
  directory: string;
  headDir: string;
  fsync?: Fsync;
}

export function fsyncDirectory(path: string, fsync: Fsync = fsyncSync): void {
  const fd = openSync(path, 'r');
  try {
    fsync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Reads the pilot id; undefined when the file is absent. Throws when present but invalid. */
export function readPilotId(directory: string): string | undefined {
  const path = pilotIdPath(directory);
  if (!existsSync(path)) return undefined;
  const id = readFileSync(path, 'utf8').trim();
  if (!UUID.test(id)) throw new Error('pilot-id is malformed');
  return id;
}

/** Atomic, durable private file in the head directory (temp, fsync, rename, fsync directory). */
function writeHeadDirFile(ctx: JournalContext, path: string, content: string): void {
  const fsync = ctx.fsync ?? fsyncSync;
  mkdirSync(ctx.headDir, { recursive: true, mode: 0o700 });
  chmodSync(ctx.headDir, 0o700);
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, content);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  fsyncDirectory(ctx.headDir, fsync);
}
function writeHead(ctx: JournalContext, head: HeadRecord): void {
  writeHeadDirFile(ctx, headRecordPath(ctx.headDir, head.pilotId), JSON.stringify(head));
}

export class PilotRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PilotRegistryError';
  }
}
export interface PilotBinding {
  sourceCompany: string;
  targetCompany: string;
}
interface RegistryEntry extends PilotBinding {
  directory: string;
  pilotId: string;
}
export const registryPath = (headDir: string) => join(headDir, 'registry.json');

/**
 * Durable registry next to the head records: which pilot id was created for which (real) state
 * directory and binding. Consulted before initialization so that losing the state directory cannot
 * start a second pilot for the same directory or binding.
 */
function readRegistry(headDir: string): RegistryEntry[] {
  let text: string;
  try {
    text = readFileSync(registryPath(headDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PilotRegistryError('pilot registry is unreadable');
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('shape');
    return parsed.entries as RegistryEntry[];
  } catch {
    throw new PilotRegistryError('pilot registry is malformed');
  }
}

/**
 * First initialization of a pilot directory: head record, then genesis journal, then pilot-id.
 * Throws when pilot-id or the journal already exists (never re-initializes).
 */
export function initializeJournal(ctx: JournalContext, now: number, binding: PilotBinding): string {
  const fsync = ctx.fsync ?? fsyncSync;
  const { directory } = ctx;
  if (existsSync(pilotIdPath(directory)) || existsSync(journalPath(directory)))
    throw new Error('pilot directory is already initialized');
  const real = realpathSync(directory);
  const entries = readRegistry(ctx.headDir);
  if (
    entries.some(
      (e) =>
        e.directory === real ||
        (e.sourceCompany === binding.sourceCompany && e.targetCompany === binding.targetCompany),
    )
  )
    throw new PilotRegistryError(
      'a pilot was already registered for this state directory or binding',
    );
  const pilotId = randomUUID();
  writeHeadDirFile(
    ctx,
    registryPath(ctx.headDir),
    JSON.stringify({ version: 1, entries: [...entries, { directory: real, ...binding, pilotId }] }),
  );
  const genesis = JSON.stringify({ kind: 'genesis', pilotId, createdAt: now });
  writeHead(ctx, { pilotId, seq: 0, hash: sha256(genesis) });
  mkdirSync(journalDir(directory), { recursive: true, mode: 0o700 });
  chmodSync(journalDir(directory), 0o700);
  const fd = openSync(journalPath(directory), 'wx', 0o600);
  try {
    writeSync(fd, `${genesis}\n`);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(journalDir(directory), fsync);
  const idFd = openSync(pilotIdPath(directory), 'wx', 0o600);
  try {
    writeSync(idFd, pilotId);
    fsync(idFd);
  } finally {
    closeSync(idFd);
  }
  chmodSync(pilotIdPath(directory), 0o600);
  fsyncDirectory(directory, fsync);
  return pilotId;
}

export type JournalState =
  | { ok: true; entries: ChainedEntry[]; last: { seq: number; hash: string } }
  | { ok: false; reason: string };

/**
 * Verifies genesis, pilot id, seq/prev chain and the independent head record. The journal and the
 * head record are never created here.
 */
export function verifyJournal(ctx: JournalContext): JournalState {
  const { directory } = ctx;
  let pilotId: string | undefined;
  try {
    pilotId = readPilotId(directory);
  } catch {
    return { ok: false, reason: 'pilot-id is malformed' };
  }
  if (!pilotId) return { ok: false, reason: 'pilot-id is missing' };
  const path = journalPath(directory);
  if (!existsSync(path)) return { ok: false, reason: 'dispatch journal is missing' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'dispatch journal is unreadable' };
  }
  if (text.length === 0) return { ok: false, reason: 'dispatch journal is empty' };
  const raw = text.split('\n');
  if (raw.pop() !== '') return { ok: false, reason: 'dispatch journal ends in a partial line' };
  const entries: ChainedEntry[] = [];
  let prevHash = '';
  let seq = -1;
  for (const [index, line] of raw.entries()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `dispatch journal line ${index} is malformed` };
    }
    if (index === 0) {
      if (entry.kind !== 'genesis' || entry.pilotId !== pilotId)
        return { ok: false, reason: 'dispatch journal lacks a valid genesis for this pilot' };
    } else {
      if (entry.seq !== index || entry.prev !== prevHash)
        return { ok: false, reason: `dispatch journal chain is broken at line ${index}` };
      const valid =
        (entry.kind === 'target' &&
          typeof entry.intentId === 'string' &&
          typeof entry.requestHash === 'string' &&
          Number.isSafeInteger(entry.attempt)) ||
        (entry.kind === 'source' && typeof entry.stagedId === 'string');
      if (!valid) return { ok: false, reason: `dispatch journal line ${index} is malformed` };
      entries.push(entry as unknown as ChainedEntry);
    }
    prevHash = sha256(line);
    seq = index;
  }
  let head: Partial<HeadRecord>;
  try {
    head = JSON.parse(readFileSync(headRecordPath(ctx.headDir, pilotId), 'utf8')) as HeadRecord;
  } catch {
    return { ok: false, reason: 'journal head record is missing or unreadable' };
  }
  if (head.pilotId !== pilotId || head.seq !== seq || head.hash !== prevHash)
    return { ok: false, reason: 'dispatch journal does not match its head record (truncated?)' };
  return { ok: true, entries, last: { seq, hash: prevHash } };
}

/**
 * Appends a chained line, fsyncs it, then advances the head record. Never creates the journal and
 * refuses to extend one that does not verify.
 */
export function appendJournal(ctx: JournalContext, entry: JournalEntry): void {
  const state = verifyJournal(ctx);
  if (!state.ok) throw new Error(state.reason);
  const fsync = ctx.fsync ?? fsyncSync;
  const seq = state.last.seq + 1;
  const line = JSON.stringify({ ...entry, seq, prev: state.last.hash });
  const fd = openSync(journalPath(ctx.directory), 'a');
  try {
    writeSync(fd, `${line}\n`);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  writeHead(ctx, { pilotId: readPilotId(ctx.directory)!, seq, hash: sha256(line) });
}
