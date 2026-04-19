import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PROFILE, validateProfileName } from './profile-name.js';

function configDir(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || os.homedir() || '~',
    '.fortnox-mcp',
  );
}

function profilesIndexFile(): string {
  return path.join(configDir(), 'profiles.json');
}

function activePointerFile(): string {
  return path.join(configDir(), 'active-profile');
}

export const PROFILE_INDEX_SCHEMA_VERSION = 1;

export interface ProfileIndexEntry {
  name: string;
  tenant_id?: string;
  company_name?: string;
  created_at: string;
  schema_version: 2;
}

export interface ProfileIndex {
  schema_version: typeof PROFILE_INDEX_SCHEMA_VERSION;
  profiles: ProfileIndexEntry[];
}

export type ProfileSource = 'flag' | 'env' | 'pointer' | 'default';

export interface ResolvedProfile {
  name: string;
  source: ProfileSource;
}

function emptyIndex(): ProfileIndex {
  return { schema_version: PROFILE_INDEX_SCHEMA_VERSION, profiles: [] };
}

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
}

async function atomicWrite(target: string, contents: string, mode = 0o600): Promise<void> {
  await ensureConfigDir();
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, contents, { mode });
  await fs.rename(tmp, target);
}

export async function readProfileIndex(): Promise<ProfileIndex> {
  try {
    const raw = await fs.readFile(profilesIndexFile(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProfileIndex>;
    if (!parsed || !Array.isArray(parsed.profiles)) return emptyIndex();
    return {
      schema_version: PROFILE_INDEX_SCHEMA_VERSION,
      profiles: parsed.profiles,
    };
  } catch {
    return emptyIndex();
  }
}

export async function writeProfileIndex(idx: ProfileIndex): Promise<void> {
  await atomicWrite(profilesIndexFile(), JSON.stringify(idx, null, 2) + '\n');
}

export async function upsertProfile(entry: ProfileIndexEntry): Promise<void> {
  validateProfileName(entry.name);
  const idx = await readProfileIndex();
  const existing = idx.profiles.findIndex((p) => p.name === entry.name);
  if (existing >= 0) {
    idx.profiles[existing] = { ...idx.profiles[existing], ...entry };
  } else {
    idx.profiles.push(entry);
  }
  await writeProfileIndex(idx);
}

export async function removeProfile(name: string): Promise<void> {
  validateProfileName(name);
  const idx = await readProfileIndex();
  const before = idx.profiles.length;
  idx.profiles = idx.profiles.filter((p) => p.name !== name);
  if (idx.profiles.length !== before) {
    await writeProfileIndex(idx);
  }
}

export async function readActivePointer(): Promise<string | null> {
  try {
    const raw = await fs.readFile(activePointerFile(), 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return validateProfileName(trimmed);
  } catch {
    return null;
  }
}

export async function writeActivePointer(name: string): Promise<void> {
  const validated = validateProfileName(name);
  await atomicWrite(activePointerFile(), `${validated}\n`);
}

export async function deleteActivePointer(): Promise<void> {
  try {
    await fs.rm(activePointerFile(), { force: true });
  } catch {
    // ignore
  }
}

export interface ResolveInputs {
  flag?: string | null | undefined;
  env?: string | null | undefined;
  pointer?: string | null | undefined;
}

export function resolveProfile(inputs: ResolveInputs): ResolvedProfile {
  if (inputs.flag) {
    return { name: validateProfileName(inputs.flag), source: 'flag' };
  }
  if (inputs.env) {
    return { name: validateProfileName(inputs.env), source: 'env' };
  }
  if (inputs.pointer) {
    return { name: validateProfileName(inputs.pointer), source: 'pointer' };
  }
  return { name: DEFAULT_PROFILE, source: 'default' };
}

export const paths = {
  get configDir(): string {
    return configDir();
  },
  get profilesIndexFile(): string {
    return profilesIndexFile();
  },
  get activePointerFile(): string {
    return activePointerFile();
  },
};
