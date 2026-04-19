import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readProfileIndex,
  writeProfileIndex,
  upsertProfile,
  removeProfile,
  readActivePointer,
  writeActivePointer,
  deleteActivePointer,
  resolveProfile,
  paths,
} from '../src/profiles.js';

let tmpRoot: string;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-profiles-'));
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
});

afterEach(async () => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveProfile precedence', () => {
  it('returns default when nothing is set', () => {
    expect(resolveProfile({})).toEqual({ name: 'default', source: 'default' });
  });

  it('prefers flag over env over pointer', () => {
    expect(resolveProfile({ flag: 'work', env: 'env-p', pointer: 'point' })).toEqual({
      name: 'work',
      source: 'flag',
    });
    expect(resolveProfile({ env: 'env-p', pointer: 'point' })).toEqual({
      name: 'env-p',
      source: 'env',
    });
    expect(resolveProfile({ pointer: 'point' })).toEqual({
      name: 'point',
      source: 'pointer',
    });
  });

  it('ignores empty strings and treats them as absent', () => {
    expect(resolveProfile({ flag: '', env: '', pointer: 'point' })).toEqual({
      name: 'point',
      source: 'pointer',
    });
  });

  it('throws InvalidProfileNameError on invalid flag', () => {
    expect(() => resolveProfile({ flag: 'bad name!' })).toThrow();
  });
});

describe('profile index I/O', () => {
  it('returns empty index when missing', async () => {
    const idx = await readProfileIndex();
    expect(idx).toEqual({ schema_version: 1, profiles: [] });
  });

  it('round-trips index through write + read', async () => {
    await writeProfileIndex({
      schema_version: 1,
      profiles: [
        {
          name: 'demo',
          tenant_id: '12345',
          company_name: 'Demo AB',
          created_at: '2026-04-19T00:00:00.000Z',
          schema_version: 2,
        },
      ],
    });
    const idx = await readProfileIndex();
    expect(idx.profiles).toHaveLength(1);
    expect(idx.profiles[0]!.name).toBe('demo');
    expect(idx.profiles[0]!.tenant_id).toBe('12345');
  });

  it('upsertProfile inserts then updates by name', async () => {
    await upsertProfile({
      name: 'demo',
      created_at: '2026-04-19T00:00:00.000Z',
      schema_version: 2,
    });
    await upsertProfile({
      name: 'demo',
      created_at: '2026-04-19T00:00:00.000Z',
      company_name: 'Updated AB',
      schema_version: 2,
    });
    const idx = await readProfileIndex();
    expect(idx.profiles).toHaveLength(1);
    expect(idx.profiles[0]!.company_name).toBe('Updated AB');
  });

  it('removeProfile drops the entry', async () => {
    await upsertProfile({
      name: 'demo',
      created_at: '2026-04-19T00:00:00.000Z',
      schema_version: 2,
    });
    await upsertProfile({
      name: 'work',
      created_at: '2026-04-19T00:00:00.000Z',
      schema_version: 2,
    });
    await removeProfile('demo');
    const idx = await readProfileIndex();
    expect(idx.profiles.map((p) => p.name)).toEqual(['work']);
  });

  it('upsertProfile rejects invalid names', async () => {
    await expect(
      upsertProfile({
        name: '../evil',
        created_at: '2026-04-19T00:00:00.000Z',
        schema_version: 2,
      }),
    ).rejects.toThrow();
  });

  it('tolerates a corrupt index file', async () => {
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.writeFile(paths.profilesIndexFile, '{ not json');
    const idx = await readProfileIndex();
    expect(idx).toEqual({ schema_version: 1, profiles: [] });
  });
});

describe('active pointer I/O', () => {
  it('returns null when missing', async () => {
    await expect(readActivePointer()).resolves.toBeNull();
  });

  it('round-trips via writeActivePointer', async () => {
    await writeActivePointer('demo');
    await expect(readActivePointer()).resolves.toBe('demo');
  });

  it('rejects invalid names on write', async () => {
    await expect(writeActivePointer('has space')).rejects.toThrow();
  });

  it('appends a trailing newline on write', async () => {
    await writeActivePointer('work');
    const raw = await fs.readFile(paths.activePointerFile, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(await readActivePointer()).toBe('work');
  });

  it('deleteActivePointer removes the file', async () => {
    await writeActivePointer('demo');
    await deleteActivePointer();
    await expect(readActivePointer()).resolves.toBeNull();
  });

  it('returns null on a corrupt pointer containing an invalid name', async () => {
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.writeFile(paths.activePointerFile, 'has space\n');
    await expect(readActivePointer()).resolves.toBeNull();
  });
});
