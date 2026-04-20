import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  DEFAULT_PROFILE,
  LEGACY_KEYCHAIN_ACCOUNT,
  keychainAccount,
  sanitizeForFilename,
  validateProfileName,
} from './profile-name.js';
import { configDir } from './config-paths.js';

function legacyCredentialsFile(): string {
  return path.join(configDir(), 'credentials.json');
}
function legacyWindowsCredentialsFile(): string {
  return path.join(configDir(), 'credentials.dpapi');
}
const SERVICE_NAME = 'fortnox-mcp';

function normalizeProfile(profile: string): { normalized: string; isDefault: boolean } {
  const validated = validateProfileName(profile).toLowerCase();
  return { normalized: validated, isDefault: validated === DEFAULT_PROFILE };
}

function windowsCredentialsFile(profile: string): string {
  return path.join(configDir(), `credentials.${sanitizeForFilename(profile)}.dpapi`);
}

// Dual-write to the legacy slot during the 0.2.x compatibility window so an
// older 0.1 binary can still read credentials written by this one. Flip to
// `false` in 0.3.0 and delete the legacy reader branch below.
// REMOVE IN 0.3.0
export const LEGACY_DUAL_WRITE = true;

export type LoadSource =
  | 'new'
  | 'legacy'
  | 'both-new-preferred'
  | 'both-legacy-preferred'
  | 'legacy-plaintext'
  | null;

export interface LoadCredentialBlobResult {
  blob: string | null;
  source: LoadSource;
  // The raw legacy-slot blob when it was observed (including when the new slot
  // was preferred by pickHigher). Callers driving migration of index metadata
  // should seed from this rather than `blob`, since the two copies may have
  // drifted. null when no legacy slot existed on this load.
  legacyBlob: string | null;
}

export interface SaveCredentialOptions {
  // When true AND LEGACY_DUAL_WRITE AND the profile resolves to `default`,
  // the blob is also written to the legacy keychain account / credentials.dpapi
  // file. Callers set this only when a legacy blob was observed during the most
  // recent load, to avoid creating empty legacy slots for fresh installs.
  alsoWriteLegacy?: boolean;
}

interface ParsedMeta {
  schema: number;
  epoch: number;
}

function parseBlobMeta(blob: string): ParsedMeta | null {
  try {
    const parsed = JSON.parse(blob) as {
      schema_version?: unknown;
      last_write_epoch?: unknown;
    };
    const schema = typeof parsed.schema_version === 'number' ? parsed.schema_version : 1;
    const epoch = typeof parsed.last_write_epoch === 'number' ? parsed.last_write_epoch : 0;
    return { schema, epoch };
  } catch {
    return null;
  }
}

function pickHigher(
  newBlob: string,
  legacyBlob: string,
): { blob: string; picked: 'new' | 'legacy' } {
  const nMeta = parseBlobMeta(newBlob);
  const lMeta = parseBlobMeta(legacyBlob);
  if (nMeta && !lMeta) return { blob: newBlob, picked: 'new' };
  if (!nMeta && lMeta) return { blob: legacyBlob, picked: 'legacy' };
  if (!nMeta && !lMeta) return { blob: newBlob, picked: 'new' };
  const n = nMeta!;
  const l = lMeta!;
  if (n.schema > l.schema) return { blob: newBlob, picked: 'new' };
  if (l.schema > n.schema) return { blob: legacyBlob, picked: 'legacy' };
  if (n.epoch > l.epoch) return { blob: newBlob, picked: 'new' };
  if (l.epoch > n.epoch) return { blob: legacyBlob, picked: 'legacy' };
  return { blob: newBlob, picked: 'new' };
}

function decodeHexIfNeeded(value: string): string {
  // macOS `security -w` returns hex-encoded output when the password
  // contains control characters (e.g. newlines from pretty-printed JSON).
  // Detect this and decode back to the original string.
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      const decoded = Buffer.from(value, 'hex').toString('utf-8');
      if (decoded.startsWith('{')) return decoded;
    } catch {
      // not valid hex — return as-is
    }
  }
  return value;
}

function loadMacSecret(account: string): string | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w'],
      { encoding: 'utf-8' },
    ).trim();
    return decodeHexIfNeeded(raw);
  } catch {
    return null;
  }
}

function saveMacSecret(account: string, secret: string): void {
  // macOS `security add-generic-password -w` requires the password as a CLI
  // argument, which is briefly visible via `ps`. Instead, use an inline Swift
  // script that reads the secret from stdin and writes to the Keychain via
  // the Security framework — the secret never appears in process arguments.
  const scriptPath = path.join(os.tmpdir(), `noxctl-keychain-${process.pid}.swift`);

  // account is either LEGACY_KEYCHAIN_ACCOUNT ("default") or `profile:<validated>`.
  // Validation in profile-name.ts restricts the character set so embedding is safe.
  const swiftScript = `
import Foundation
import Security

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let password = String(data: data, encoding: .utf8) else { exit(1) }

let service = "${SERVICE_NAME}"
let account = "${account}"

let deleteQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]
SecItemDelete(deleteQuery as CFDictionary)

let pwData = password.data(using: String.Encoding.utf8)!
let addQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
  kSecValueData as String: pwData
]
let status = SecItemAdd(addQuery as CFDictionary, nil)
if status != errSecSuccess { exit(1) }
`;

  try {
    fsSync.writeFileSync(scriptPath, swiftScript, { mode: 0o600 });

    const result = spawnSync('swift', [scriptPath], {
      input: secret,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Swift keychain helper failed');
    }
  } catch {
    // Fallback to security CLI if Swift is unavailable or fails
    execFileSync('security', [
      'add-generic-password',
      '-a',
      account,
      '-s',
      SERVICE_NAME,
      '-w',
      secret,
      '-U',
    ]);
  } finally {
    try {
      fsSync.unlinkSync(scriptPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

function loadLinuxSecret(account: string): string | null {
  try {
    return execFileSync('secret-tool', ['lookup', 'service', SERVICE_NAME, 'account', account], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function saveLinuxSecret(account: string, secret: string): void {
  execFileSync(
    'secret-tool',
    ['store', '--label=Fortnox MCP credentials', 'service', SERVICE_NAME, 'account', account],
    { input: secret },
  );
}

function loadWindowsSecret(file: string): string | null {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `if (-not (Test-Path '${file}')) { exit 0 }`,
          `$protected = [Convert]::FromBase64String([IO.File]::ReadAllText('${file}'))`,
          '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
          '[Text.Encoding]::UTF8.GetString($bytes)',
        ].join('; '),
      ],
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return null;
  }
}

function saveWindowsSecret(file: string, secret: string): void {
  // Read the secret from stdin instead of embedding it in the PowerShell
  // command string, which would be visible via `ps` / Task Manager.
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        `[IO.Directory]::CreateDirectory('${configDir()}') | Out-Null`,
        '$plain = [Console]::In.ReadToEnd()',
        '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
        '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
        `[IO.File]::WriteAllText('${file}', [Convert]::ToBase64String($protected), [Text.Encoding]::UTF8)`,
      ].join('; '),
    ],
    { input: secret, encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to save credentials: ${result.stderr || 'unknown error'}`);
  }
}

async function loadLegacyPlaintextSecret(): Promise<string | null> {
  try {
    return await fs.readFile(legacyCredentialsFile(), 'utf-8');
  } catch {
    return null;
  }
}

async function removeLegacyPlaintextSecret(): Promise<void> {
  try {
    await fs.rm(legacyCredentialsFile(), { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function loadFromBackend(account: string, windowsFile: string): string | null {
  if (process.platform === 'darwin') return loadMacSecret(account);
  if (process.platform === 'win32') return loadWindowsSecret(windowsFile);
  return loadLinuxSecret(account);
}

export async function loadCredentialBlob(
  profile: string = DEFAULT_PROFILE,
): Promise<LoadCredentialBlobResult> {
  const { normalized, isDefault } = normalizeProfile(profile);

  if (!isDefault) {
    const blob = loadFromBackend(keychainAccount(normalized), windowsCredentialsFile(normalized));
    return { blob, source: blob ? 'new' : null, legacyBlob: null };
  }

  const newBlob = loadFromBackend(keychainAccount(normalized), windowsCredentialsFile(normalized));
  const legacyBlob = loadFromBackend(LEGACY_KEYCHAIN_ACCOUNT, legacyWindowsCredentialsFile());

  if (newBlob && legacyBlob) {
    const { blob, picked } = pickHigher(newBlob, legacyBlob);
    return {
      blob,
      source: picked === 'new' ? 'both-new-preferred' : 'both-legacy-preferred',
      legacyBlob,
    };
  }
  if (newBlob) return { blob: newBlob, source: 'new', legacyBlob: null };
  if (legacyBlob) return { blob: legacyBlob, source: 'legacy', legacyBlob };

  const plaintext = await loadLegacyPlaintextSecret();
  if (plaintext) return { blob: plaintext, source: 'legacy-plaintext', legacyBlob: plaintext };
  return { blob: null, source: null, legacyBlob: null };
}

function writeToBackend(account: string, windowsFile: string, secret: string): void {
  if (process.platform === 'darwin') {
    saveMacSecret(account, secret);
  } else if (process.platform === 'win32') {
    saveWindowsSecret(windowsFile, secret);
  } else {
    saveLinuxSecret(account, secret);
  }
}

export async function saveCredentialBlob(
  secret: string,
  profile: string = DEFAULT_PROFILE,
  options: SaveCredentialOptions = {},
): Promise<void> {
  const { normalized, isDefault } = normalizeProfile(profile);

  // Primary write: always the new per-profile slot (profile:<name> or
  // credentials.<name>.dpapi). For default this is `profile:default` /
  // `credentials.default.dpapi`.
  writeToBackend(keychainAccount(normalized), windowsCredentialsFile(normalized), secret);

  // Compatibility dual-write: for the default profile only, and only when the
  // caller observed a legacy blob during load. This keeps an older 0.1 binary
  // functional during the 0.2.x window without silently creating a legacy slot
  // for users who never had one. Best-effort — a failure here must not break
  // the auth flow, since the authoritative new-slot write already succeeded.
  // REMOVE IN 0.3.0.
  if (LEGACY_DUAL_WRITE && isDefault && options.alsoWriteLegacy) {
    try {
      writeToBackend(LEGACY_KEYCHAIN_ACCOUNT, legacyWindowsCredentialsFile(), secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: could not mirror credentials to legacy slot: ${msg}`);
    }
  }

  if (isDefault) {
    await removeLegacyPlaintextSecret();
  }
}

function deleteMacSecret(account: string): boolean {
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', SERVICE_NAME]);
    return true;
  } catch {
    return false;
  }
}

function deleteLinuxSecret(account: string): boolean {
  try {
    execFileSync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', account]);
    return true;
  } catch {
    return false;
  }
}

async function deleteWindowsSecret(file: string): Promise<boolean> {
  try {
    await fs.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function deleteAtAccount(account: string, windowsFile: string): Promise<boolean> {
  if (process.platform === 'darwin') return deleteMacSecret(account);
  if (process.platform === 'win32') return deleteWindowsSecret(windowsFile);
  return deleteLinuxSecret(account);
}

export async function deleteCredentialBlob(profile: string = DEFAULT_PROFILE): Promise<boolean> {
  const { normalized, isDefault } = normalizeProfile(profile);

  if (isDefault) {
    const legacyDeleted = await deleteAtAccount(
      LEGACY_KEYCHAIN_ACCOUNT,
      legacyWindowsCredentialsFile(),
    );
    const newDeleted = await deleteAtAccount(
      keychainAccount(normalized),
      windowsCredentialsFile(normalized),
    );
    await removeLegacyPlaintextSecret();
    return legacyDeleted || newDeleted;
  }

  return deleteAtAccount(keychainAccount(normalized), windowsCredentialsFile(normalized));
}
