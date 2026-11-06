/**
 * Append-only dispatch journal (NOX-214), kept OUTSIDE the backed-up databases. Backups never copy
 * it and a restore never touches it, so a restored older database can be compared with what was
 * really dispatched. Entries are written (and fsynced) immediately before the external write.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export type JournalEntry =
  | { kind: 'target'; intentId: string; requestHash: string; attempt: number; at: number }
  | { kind: 'source'; stagedId: string; at: number };

const journalDir = (directory: string) => join(directory, 'journal');
export const journalPath = (directory: string) => join(journalDir(directory), 'dispatch.jsonl');

/** Creates an empty journal if (and only if) it does not exist. */
export function ensureJournal(directory: string): void {
  mkdirSync(journalDir(directory), { recursive: true, mode: 0o700 });
  chmodSync(journalDir(directory), 0o700);
  try {
    closeSync(openSync(journalPath(directory), 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Never creates the file: a missing journal while state exists is a refusal, not a fresh start. */
export function appendJournal(directory: string, entry: JournalEntry): void {
  const path = journalPath(directory);
  if (!existsSync(path)) throw new Error('dispatch journal is missing');
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** undefined = missing. Throws when unreadable or malformed. */
export function readJournal(directory: string): JournalEntry[] | undefined {
  const path = journalPath(directory);
  if (!existsSync(path)) return undefined;
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (
      entry.kind === 'target' &&
      typeof entry.intentId === 'string' &&
      typeof entry.requestHash === 'string' &&
      Number.isSafeInteger(entry.attempt)
    )
      entries.push(entry as unknown as JournalEntry);
    else if (entry.kind === 'source' && typeof entry.stagedId === 'string')
      entries.push(entry as unknown as JournalEntry);
    else throw new Error('malformed journal entry');
  }
  return entries;
}
