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
import { activeKeychainPath, KeychainAccessError, readDedicatedSecret } from './keychain-target.js';

function legacyCredentialsFile(): string {
  return path.join(configDir(), 'credentials.json');
}
function legacyWindowsCredentialsFile(): string {
  return path.join(configDir(), 'credentials.dpapi');
}
const SERVICE_NAME = 'fortnox-mcp';

export class CredentialStoreAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialStoreAccessError';
  }
}

function commandFailureDetail(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const e = err as {
    message?: string;
    stderr?: Buffer | string;
    code?: string;
    status?: number;
  };
  const stderr = e.stderr?.toString().trim();
  return stderr || e.message || e.code || `exit ${e.status ?? 'unknown'}`;
}

function isMissingSecretError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { message?: string; stderr?: Buffer | string; status?: number };
  const detail = `${e.message ?? ''}\n${e.stderr?.toString() ?? ''}`;
  return (
    e.status === 44 || /not found|could not be found|no keychain item|no matching/i.test(detail)
  );
}

function isEmptyExitOne(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { stderr?: Buffer | string; status?: number };
  return e.status === 1 && !(e.stderr?.toString().trim() ?? '');
}

function normalizeProfile(profile: string): { normalized: string; isDefault: boolean } {
  const validated = validateProfileName(profile).toLowerCase();
  return { normalized: validated, isDefault: validated === DEFAULT_PROFILE };
}

function windowsCredentialsFile(profile: string): string {
  return path.join(configDir(), `credentials.${sanitizeForFilename(profile)}.dpapi`);
}

// Dual-write to the legacy slot was needed during the 0.2.x compatibility
// window so an older 0.1 binary could still read credentials written by this
// one. That window has passed (shipping 0.4.0+), so new writes go only to the
// per-profile slot. The legacy reader branches (loadCredentialBlob) stay in
// place — removing them is a breaking change for external npm installs still
// on the 0.1.x layout; see docs/legacy-credential-removal-plan.md.
export const LEGACY_DUAL_WRITE = false;

export type LoadSource =
  'new' | 'legacy' | 'both-new-preferred' | 'both-legacy-preferred' | 'legacy-plaintext' | null;

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
  // Dedicated-keychain mode: read prompt-free from the YubiKey-locked keychain.
  // A locked keychain throws KeychainLockedError (propagated so the caller can
  // tell the user to run `noxctl keychain unlock`), not a silent null.
  const dedicated = activeKeychainPath();
  if (dedicated) {
    try {
      return readDedicatedSecret(account, dedicated);
    } catch (err) {
      if (err instanceof KeychainAccessError) {
        throw new CredentialStoreAccessError(err.message);
      }
      throw err;
    }
  }

  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return decodeHexIfNeeded(raw);
  } catch (err) {
    if (isMissingSecretError(err)) return null;
    throw new CredentialStoreAccessError(
      `macOS Keychain could not be inspected (${commandFailureDetail(err)})`,
    );
  }
}

function saveMacSecret(account: string, secret: string): void {
  // macOS `security add-generic-password -w` requires the password as a CLI
  // argument, which is briefly visible via `ps`. Instead, use an inline Swift
  // script that reads the secret from stdin and writes to the Keychain via
  // the Security framework — the secret never appears in process arguments.
  const scriptPath = path.join(os.tmpdir(), `noxctl-keychain-${process.pid}.swift`);

  // In dedicated-keychain mode, target that keychain file; otherwise the
  // default (login) keychain. The path is passed as argv (not interpolated) so
  // an odd path can't break or inject into the Swift source.
  const keychainPath = activeKeychainPath() ?? '';

  // account is either LEGACY_KEYCHAIN_ACCOUNT ("default") or `profile:<validated>`.
  // Validation in profile-name.ts restricts the character set so embedding is safe.
  const swiftScript = `
import Foundation
import Security

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let password = String(data: data, encoding: .utf8) else { exit(1) }

let service = "${SERVICE_NAME}"
let account = "${account}"

let kcPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
var useKeychain: SecKeychain? = nil
if !kcPath.isEmpty {
  var kc: SecKeychain?
  if SecKeychainOpen(kcPath, &kc) == errSecSuccess { useKeychain = kc }
  else { exit(1) }
}

var deleteQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]
if let kc = useKeychain { deleteQuery[kSecMatchSearchList as String] = [kc] }
SecItemDelete(deleteQuery as CFDictionary)

let pwData = password.data(using: String.Encoding.utf8)!
var addQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
  kSecValueData as String: pwData
]
if let kc = useKeychain { addQuery[kSecUseKeychain as String] = kc }
let status = SecItemAdd(addQuery as CFDictionary, nil)
if status != errSecSuccess { exit(1) }
`;

  try {
    fsSync.writeFileSync(scriptPath, swiftScript, { mode: 0o600 });

    const result = spawnSync('swift', [scriptPath, keychainPath], {
      input: secret,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Swift keychain helper failed');
    }
  } catch (err) {
    // Fail closed rather than fall back to `security add-generic-password -w
    // <secret>`: that CLI only accepts the password via the argv `-w` slot
    // (briefly visible to other processes via `ps`) or an interactive prompt,
    // so a fallback would leak the credential into process arguments — exactly
    // what the stdin-based Swift writer above exists to avoid. `swift` ships
    // with the Xcode Command Line Tools, so guide the user to install them.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not store credentials securely: the Swift Keychain helper failed (${detail}). ` +
        `The 'swift' toolchain is required to write credentials without exposing them in ` +
        `process arguments — install the Xcode Command Line Tools with 'xcode-select --install' ` +
        `and try again.`,
    );
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
  } catch (err) {
    // `secret-tool lookup` uses exit 1 with no stderr when no matching item
    // exists. Transport/session failures include diagnostic stderr (and a
    // missing binary reports ENOENT), so those remain inaccessible.
    if (isMissingSecretError(err) || isEmptyExitOne(err)) return null;
    throw new CredentialStoreAccessError(
      `Linux Secret Service could not be inspected (${commandFailureDetail(err)})`,
    );
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
  if (!fsSync.existsSync(file)) return null;
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          // ProtectedData lives in System.Security, which is not preloaded in
          // every PowerShell configuration (#95).
          'Add-Type -AssemblyName System.Security',
          `if (-not (Test-Path '${file}')) { exit 0 }`,
          `$protected = [Convert]::FromBase64String([IO.File]::ReadAllText('${file}'))`,
          '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
          '[Text.Encoding]::UTF8.GetString($bytes)',
        ].join('; '),
      ],
      { encoding: 'utf-8' },
    ).trim();
  } catch (err) {
    throw new CredentialStoreAccessError(
      `Windows DPAPI credential store could not be inspected (${commandFailureDetail(err)})`,
    );
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
        // ProtectedData lives in System.Security, which is not preloaded in
        // every PowerShell configuration (#95).
        'Add-Type -AssemblyName System.Security',
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

  // Compatibility dual-write: disabled now that LEGACY_DUAL_WRITE is false
  // (see its definition above). Kept behind the flag rather than deleted so
  // it can be re-enabled without resurrecting the write-side logic, should
  // that ever be needed. Best-effort — a failure here must not break the auth
  // flow, since the authoritative new-slot write already succeeded.
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
  const keychainPath = activeKeychainPath();
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-a',
      account,
      '-s',
      SERVICE_NAME,
      ...(keychainPath ? [keychainPath] : []),
    ]);
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
    // Deliberately not `{ force: true }`: that resolves for a missing file, so
    // every delete looked successful and `logout --all` reported removing
    // credentials that were never stored. The macOS and Linux backends both
    // report false when there was nothing to remove.
    await fs.rm(file);
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
