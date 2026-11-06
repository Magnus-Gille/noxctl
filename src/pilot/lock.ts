/**
 * Cross-process pilot lock (NOX-214). CLI commands and the long-running MCP server share one state
 * directory; every mutation and every backup holds `<directory>/pilot.lock` for its whole duration.
 * The lock is exclusive-create, never waited on and NEVER removed automatically: a stale lock is
 * removed by the operator after confirming that no pilot process is running (see docs/pilot-host.md).
 */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export class PilotLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PilotLockError';
  }
}

export function lockPath(directory: string): string {
  return join(directory, 'pilot.lock');
}

/** Returns a release function (idempotent). Throws PilotLockError when the lock already exists. */
export function acquirePilotLock(directory: string, command: string, now: number): () => void {
  const path = lockPath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let holder = 'unknown holder';
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      holder = `pid ${String(info.pid)}, command ${String(info.command)}, since ${String(info.startedAt)}`;
    } catch {
      // unreadable lock content still blocks
    }
    throw new PilotLockError(
      `another pilot operation holds ${path} (${holder}); it is never removed automatically. ` +
        'If you have confirmed that no pilot process is running, remove the file yourself.',
    );
  }
  try {
    chmodSync(path, 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: now }));
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(path, { force: true });
  };
}
