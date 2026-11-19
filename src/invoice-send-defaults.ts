import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { configDir } from './config-paths.js';
import { validateProfileName } from './profile-name.js';

/**
 * Per-profile defaults for sending customer invoices through noxctl.
 *
 * Stored locally (never in Fortnox and never in the repository) so that no
 * personal address is hard-coded. Keyed by the canonical (lower-case) profile
 * name, so one company's copy address never leaks into another profile.
 *
 * Only a default BCC lives here on purpose. Subject and body are
 * customer-specific and are therefore only ever given per send, so they can
 * never apply to every customer by accident.
 */
export interface InvoiceSendDefaults {
  bcc?: string;
}

interface InvoiceSendDefaultsFile {
  schema_version: 1;
  profiles: Record<string, InvoiceSendDefaults>;
}

const SINGLE_EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function invoiceSendDefaultsFile(): string {
  return path.join(configDir(), 'invoice-send-defaults.json');
}

export function validateBccAddress(address: string): string {
  const trimmed = address.trim();
  if (!SINGLE_EMAIL.test(trimmed)) {
    throw new Error(`Not a single email address: "${trimmed}". Give exactly one address.`);
  }
  return trimmed;
}

function profileKey(profile: string): string {
  return validateProfileName(profile).toLowerCase();
}

async function readFile(): Promise<InvoiceSendDefaultsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(invoiceSendDefaultsFile(), 'utf-8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { schema_version: 1, profiles: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InvoiceSendDefaultsFile>;
    if (!parsed || typeof parsed.profiles !== 'object' || parsed.profiles === null) {
      throw new Error('missing "profiles"');
    }
    return { schema_version: 1, profiles: parsed.profiles };
  } catch (err) {
    // Degrading to "no defaults" would silently send invoices without the copy
    // the user configured, so surface the problem instead.
    throw new Error(
      `Could not read ${invoiceSendDefaultsFile()} (invoice-send-defaults): ${
        err instanceof Error ? err.message : String(err)
      }. Fix or remove the file.`,
    );
  }
}

async function writeFile(data: InvoiceSendDefaultsFile): Promise<void> {
  const target = invoiceSendDefaultsFile();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function readInvoiceSendDefaults(profile: string): Promise<InvoiceSendDefaults> {
  const data = await readFile();
  const key = profileKey(profile);
  const entry = Object.hasOwn(data.profiles, key) ? data.profiles[key] : undefined;
  if (!entry || typeof entry.bcc !== 'string' || !entry.bcc) return {};
  return { bcc: entry.bcc };
}

export async function setInvoiceDefaultBcc(profile: string, address: string): Promise<string> {
  const bcc = validateBccAddress(address);
  const key = profileKey(profile);
  const data = await readFile();
  const existing = Object.hasOwn(data.profiles, key) ? data.profiles[key] : {};
  data.profiles[key] = { ...existing, bcc };
  await writeFile(data);
  return bcc;
}

export async function clearInvoiceDefaultBcc(profile: string): Promise<void> {
  const key = profileKey(profile);
  const data = await readFile();
  if (!Object.hasOwn(data.profiles, key)) return;
  const { bcc: _, ...rest } = data.profiles[key];
  if (Object.keys(rest).length === 0) delete data.profiles[key];
  else data.profiles[key] = rest;
  await writeFile(data);
}
