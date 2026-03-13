import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  const encoded = Buffer.from(secret, 'utf-8').toString('base64');
  execFileSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      `[IO.Directory]::CreateDirectory('${CREDENTIALS_DIR}') | Out-Null`,
      `$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
      '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      `[IO.File]::WriteAllText('${WINDOWS_CREDENTIALS_FILE}', [Convert]::ToBase64String($protected), [Text.Encoding]::UTF8)`,
    ].join('; '),
  ]);
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
