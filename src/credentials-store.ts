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
} from './profile-name.js';

const CREDENTIALS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.fortnox-mcp',
);
const LEGACY_CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
const LEGACY_WINDOWS_CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.dpapi');
const SERVICE_NAME = 'fortnox-mcp';

function windowsCredentialsFile(profile: string): string {
  return path.join(CREDENTIALS_DIR, `credentials.${sanitizeForFilename(profile)}.dpapi`);
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
        `[IO.Directory]::CreateDirectory('${CREDENTIALS_DIR}') | Out-Null`,
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
    return await fs.readFile(LEGACY_CREDENTIALS_FILE, 'utf-8');
  } catch {
    return null;
  }
}

async function removeLegacyPlaintextSecret(): Promise<void> {
  try {
    await fs.rm(LEGACY_CREDENTIALS_FILE, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function loadPlatformSecret(account: string, legacyWindowsFile?: string): string | null {
  if (process.platform === 'darwin') return loadMacSecret(account);
  if (process.platform === 'win32') {
    const file = legacyWindowsFile ?? windowsCredentialsFile(stripProfilePrefix(account));
    return loadWindowsSecret(file);
  }
  return loadLinuxSecret(account);
}

function stripProfilePrefix(account: string): string {
  return account.startsWith('profile:') ? account.slice('profile:'.length) : account;
}

function parseSchemaVersion(blob: string): number {
  try {
    const parsed = JSON.parse(blob) as { schema_version?: unknown };
    if (typeof parsed.schema_version === 'number' && Number.isFinite(parsed.schema_version)) {
      return parsed.schema_version;
    }
  } catch {
    // unparseable blob → treat as v1 so a newer peer wins
  }
  return 1;
}

function pickHigherSchema(newBlob: string | null, legacyBlob: string | null): string | null {
  if (newBlob && legacyBlob) {
    const newV = parseSchemaVersion(newBlob);
    const legacyV = parseSchemaVersion(legacyBlob);
    return newV >= legacyV ? newBlob : legacyBlob;
  }
  return newBlob ?? legacyBlob;
}

export async function loadCredentialBlob(
  profile: string = DEFAULT_PROFILE,
): Promise<string | null> {
  const newAccount = keychainAccount(profile);

  if (profile === DEFAULT_PROFILE) {
    let newBlob: string | null;
    let legacyBlob: string | null;

    if (process.platform === 'win32') {
      newBlob = loadWindowsSecret(windowsCredentialsFile(profile));
      legacyBlob = loadWindowsSecret(LEGACY_WINDOWS_CREDENTIALS_FILE);
    } else {
      newBlob = loadPlatformSecret(newAccount);
      legacyBlob = loadPlatformSecret(LEGACY_KEYCHAIN_ACCOUNT);
    }

    const picked = pickHigherSchema(newBlob, legacyBlob);
    if (picked) return picked;

    return loadLegacyPlaintextSecret();
  }

  // Non-default profiles: no legacy fallback.
  if (process.platform === 'win32') {
    return loadWindowsSecret(windowsCredentialsFile(profile));
  }
  return loadPlatformSecret(newAccount);
}

export async function saveCredentialBlob(
  secret: string,
  profile: string = DEFAULT_PROFILE,
): Promise<void> {
  // Chunk A preserves current write behavior for the default profile: we keep
  // writing to the legacy account so existing single-profile installs continue
  // to work unchanged. Chunk C will switch default writes to the new location
  // with dual-write-to-legacy.
  const useLegacyLocation = profile === DEFAULT_PROFILE;
  const account = useLegacyLocation ? LEGACY_KEYCHAIN_ACCOUNT : keychainAccount(profile);

  if (process.platform === 'darwin') {
    saveMacSecret(account, secret);
  } else if (process.platform === 'win32') {
    const file = useLegacyLocation
      ? LEGACY_WINDOWS_CREDENTIALS_FILE
      : windowsCredentialsFile(profile);
    saveWindowsSecret(file, secret);
  } else {
    saveLinuxSecret(account, secret);
  }

  if (useLegacyLocation) {
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
  let deleted = false;

  if (profile === DEFAULT_PROFILE) {
    const legacyDeleted = await deleteAtAccount(
      LEGACY_KEYCHAIN_ACCOUNT,
      LEGACY_WINDOWS_CREDENTIALS_FILE,
    );
    const newDeleted = await deleteAtAccount(
      keychainAccount(profile),
      windowsCredentialsFile(profile),
    );
    deleted = legacyDeleted || newDeleted;
    await removeLegacyPlaintextSecret();
  } else {
    deleted = await deleteAtAccount(keychainAccount(profile), windowsCredentialsFile(profile));
  }

  return deleted;
}
