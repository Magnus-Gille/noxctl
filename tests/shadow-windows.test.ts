import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShadowQueue } from '../src/shadow/queue.js';
import { createStagedServer } from '../src/staged-server.js';

// The shadow lane relies on POSIX private directories (0700, owner uid). On Windows it must
// refuse clearly before touching the filesystem instead of failing a permission check.
const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const unsupported = async () => {
  throw new Error('unsupported');
};

describe('shadow lane on Windows', () => {
  const dirs: string[] = [];
  afterEach(() => {
    setPlatform(realPlatform);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function missingDirectory(): string {
    const parent = mkdtempSync(join(tmpdir(), 'noxctl-shadow-win-'));
    dirs.push(parent);
    return join(parent, 'state');
  }

  it('refuses to open the shadow queue and creates nothing', async () => {
    const directory = missingDirectory();
    setPlatform('win32');
    await expect(
      openShadowQueue(directory, {
        sourceCompany: 'fixture-source',
        targetCompany: 'fixture-target',
      }),
    ).rejects.toThrow('Shadow queue is supported on macOS and Linux only');
    expect(existsSync(directory)).toBe(false);
  });

  it('refuses to create the staged server and creates nothing', async () => {
    const directory = missingDirectory();
    setPlatform('win32');
    await expect(
      createStagedServer({
        directory,
        actorId: 'synthetic-owner',
        revision: 'a'.repeat(64),
        maxPreparationAgeMs: 60_000,
        binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
        authorize: async () => true,
        transport: {
          request: unsupported,
          requestWithMetadata: unsupported,
          requestPdf: unsupported,
          requestPdfFromMutation: unsupported,
          requestFile: unsupported,
          fetchAllPages: unsupported,
        },
      }),
    ).rejects.toThrow('Staged server is supported on macOS and Linux only');
    expect(existsSync(directory)).toBe(false);
  });
});
