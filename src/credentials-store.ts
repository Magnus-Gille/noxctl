import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const CREDENTIALS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.fortnox-mcp',
);
const LEGACY_CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
const WINDOWS_CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.dpapi');
const SERVICE_NAME = 'fortnox-mcp';
const ACCOUNT_NAME = 'default';

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

function loadMacSecret(): string | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', ACCOUNT_NAME, '-s', SERVICE_NAME, '-w'],
      { encoding: 'utf-8' },
    ).trim();
    return decodeHexIfNeeded(raw);
  } catch {
    return null;
  }
}

function saveMacSecret(secret: string): void {
  // macOS `security add-generic-password -w` requires the password as a CLI
  // argument, which is briefly visible via `ps`. Instead, use an inline Swift
  // script that reads the secret from stdin and writes to the Keychain via
  // the Security framework — the secret never appears in process arguments.
  const fsSync = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const scriptPath = path.join(os.tmpdir(), `noxctl-keychain-${process.pid}.swift`);

  const swiftScript = `
import Foundation
import Security

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let password = String(data: data, encoding: .utf8) else { exit(1) }

let service = "${SERVICE_NAME}"
let account = "${ACCOUNT_NAME}"

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
      ACCOUNT_NAME,
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

function loadLinuxSecret(): string | null {
  try {
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return null;
  }
}

function saveLinuxSecret(secret: string): void {
  execFileSync(
    'secret-tool',
    ['store', '--label=Fortnox MCP credentials', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
    { input: secret },
  );
}

function loadWindowsSecret(): string | null {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          `if (-not (Test-Path '${WINDOWS_CREDENTIALS_FILE}')) { exit 0 }`,
          `$protected = [Convert]::FromBase64String([IO.File]::ReadAllText('${WINDOWS_CREDENTIALS_FILE}'))`,
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

function saveWindowsSecret(secret: string): void {
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
        `[IO.File]::WriteAllText('${WINDOWS_CREDENTIALS_FILE}', [Convert]::ToBase64String($protected), [Text.Encoding]::UTF8)`,
      ].join('; '),
    ],
    { input: secret, encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to save credentials: ${result.stderr || 'unknown error'}`);
  }
}

async function loadLegacySecret(): Promise<string | null> {
  try {
    return await fs.readFile(LEGACY_CREDENTIALS_FILE, 'utf-8');
  } catch {
    return null;
  }
}

async function removeLegacySecret(): Promise<void> {
  try {
    await fs.rm(LEGACY_CREDENTIALS_FILE, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

export async function loadCredentialBlob(): Promise<string | null> {
  if (process.platform === 'darwin') return loadMacSecret() ?? (await loadLegacySecret());
  if (process.platform === 'win32') return loadWindowsSecret() ?? (await loadLegacySecret());
  return loadLinuxSecret() ?? (await loadLegacySecret());
}

export async function saveCredentialBlob(secret: string): Promise<void> {
  if (process.platform === 'darwin') {
    saveMacSecret(secret);
  } else if (process.platform === 'win32') {
    saveWindowsSecret(secret);
  } else {
    saveLinuxSecret(secret);
  }

  await removeLegacySecret();
}

function deleteMacSecret(): boolean {
  try {
    execFileSync('security', ['delete-generic-password', '-a', ACCOUNT_NAME, '-s', SERVICE_NAME]);
    return true;
  } catch {
    return false;
  }
}

function deleteLinuxSecret(): boolean {
  try {
    execFileSync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME]);
    return true;
  } catch {
    return false;
  }
}

async function deleteWindowsSecret(): Promise<boolean> {
  try {
    await fs.rm(WINDOWS_CREDENTIALS_FILE, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function deleteCredentialBlob(): Promise<boolean> {
  let deleted = false;

  if (process.platform === 'darwin') deleted = deleteMacSecret();
  else if (process.platform === 'win32') deleted = await deleteWindowsSecret();
  else deleted = deleteLinuxSecret();

  // Also clean up legacy file if it exists
  await removeLegacySecret();

  return deleted;
}
