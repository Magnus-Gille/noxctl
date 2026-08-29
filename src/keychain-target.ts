import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { configDir } from './config-paths.js';

const SERVICE_NAME = 'fortnox-mcp';

// OTP slot programmed for HMAC-SHA1 challenge-response. Slot 2 is the
// conventional "long-press / second" slot and is what `noxctl keychain init`
// expects the user to have programmed with `ykman otp chalresp --generate --touch 2`.
export const CR_SLOT = '2';

// Thrown when the dedicated keychain exists but is locked. Distinct from
// "no credentials" so callers can tell the user to run `noxctl keychain unlock`
// (tap the YubiKey) rather than `noxctl init`.
export class KeychainLockedError extends Error {
  constructor(
    message = 'Fortnox keychain is locked — run `noxctl keychain unlock` (tap your YubiKey)',
  ) {
    super(message);
    this.name = 'KeychainLockedError';
  }
}

// Thrown when the dedicated keychain is configured but cannot be inspected in
// the current execution context (for example from a sandbox that cannot see
// the user's keychain file). This is deliberately distinct from both a locked
// keychain and an absent credential item: callers must fail closed rather than
// recommend replacing credentials whose existence cannot be determined.
export class KeychainAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainAccessError';
  }
}

// Thrown when a challenge-response operation fails — most often a missed touch
// (ykman reports "Failed to write to the YubiKey" when the tap window lapses).
export class ChallengeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeResponseError';
  }
}

export function dedicatedKeychainPath(): string {
  const home = process.env.HOME || os.homedir() || '~';
  return path.join(home, 'Library', 'Keychains', 'fortnox-mcp.keychain-db');
}

export function loginKeychainPath(): string {
  const home = process.env.HOME || os.homedir() || '~';
  return path.join(home, 'Library', 'Keychains', 'login.keychain-db');
}

export function challengeFilePath(): string {
  return path.join(configDir(), 'keychain-challenge');
}

// Resolve which keychain credential operations should target.
//   1. NOXCTL_KEYCHAIN_PATH env override (used by tests and power users).
//   2. darwin only: the challenge file marks the dedicated keychain configured.
//   3. otherwise null — caller falls back to the login keychain (legacy behavior).
// The challenge file is the durable configuration marker. Once it exists we
// must keep targeting the dedicated keychain even when the current execution
// context cannot see the keychain file; falling back to the login keychain
// would cross the configured protection boundary. A keychain file without a
// challenge remains a half-created setup and does not divert reads.
export function activeKeychainPath(): string | null {
  const override = process.env.NOXCTL_KEYCHAIN_PATH;
  if (override && override.trim()) return override;
  if (process.platform !== 'darwin') return null;
  if (fsSync.existsSync(challengeFilePath())) {
    return dedicatedKeychainPath();
  }
  return null;
}

export function isDedicatedModeActive(): boolean {
  return activeKeychainPath() !== null;
}

function decodeBase64(value: string): string {
  return Buffer.from(value.trim(), 'base64').toString('utf-8');
}

// Read a generic-password secret from a specific keychain WITHOUT triggering
// the macOS GUI unlock dialog. With challenge-response we cannot type the
// keychain password into that dialog, so on a locked keychain we must fail
// fast (KeychainLockedError) instead of popping an un-fillable prompt.
//
// SecKeychainSetUserInteractionAllowed(false) makes a locked keychain return
// errSecInteractionNotAllowed rather than prompting. Account and keychain path
// are passed as argv (not string-interpolated) so an odd path can't break or
// inject into the Swift source. Returns null when the item is absent.
export function readDedicatedSecret(account: string, keychainPath: string): string | null {
  const swiftScript = `
import Foundation
import Security

let service = "${SERVICE_NAME}"
let account = CommandLine.arguments[1]
let kcPath = CommandLine.arguments[2]

var kc: SecKeychain?
let openStatus = SecKeychainOpen(kcPath, &kc)
if openStatus != errSecSuccess || kc == nil { exit(4) }

SecKeychainSetUserInteractionAllowed(false)

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
  kSecMatchSearchList as String: [kc!],
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne
]
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
if status == errSecSuccess, let data = item as? Data {
  FileHandle.standardOutput.write(data.base64EncodedData())
  exit(0)
}
if status == errSecInteractionNotAllowed || status == errSecAuthFailed { exit(2) }
if status == errSecItemNotFound { exit(3) }
exit(4)
`;
  const scriptPath = path.join(os.tmpdir(), `noxctl-kcread-${process.pid}.swift`);
  try {
    fsSync.writeFileSync(scriptPath, swiftScript, { mode: 0o600 });
    const result = spawnSync('swift', [scriptPath, account, keychainPath], { encoding: 'utf-8' });
    if (result.error) {
      throw new KeychainAccessError(
        `Fortnox keychain at ${keychainPath} could not be inspected (${result.error.message})`,
      );
    }
    if (result.status === 0) return decodeBase64(result.stdout);
    if (result.status === 2) throw new KeychainLockedError();
    if (result.status === 3) return null;
    const detail = (result.stderr || '').trim() || `helper exit ${result.status ?? 'unknown'}`;
    throw new KeychainAccessError(
      `Fortnox keychain at ${keychainPath} could not be inspected (${detail})`,
    );
  } finally {
    try {
      fsSync.unlinkSync(scriptPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

// The fixed challenge is NOT a secret — the secret lives inside the YubiKey.
// It's a stable random value so the same key always derives the same keychain
// password. 32 bytes -> 64 hex chars; `ykman otp calculate` wants hex.
export function generateChallenge(): string {
  return randomBytes(32).toString('hex');
}

export function readChallenge(): string | null {
  try {
    const raw = fsSync.readFileSync(challengeFilePath(), 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeChallenge(challengeHex: string): void {
  fsSync.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(challengeFilePath(), `${challengeHex}\n`, { mode: 0o600 });
}

export function enrolledSerialFilePath(): string {
  return path.join(configDir(), 'keychain-serial');
}

// Serial of the YubiKey the keychain was enrolled against. Persisted at init
// so unlock can tell "wrong/unenrolled key present" apart from "missed tap" —
// the two failure modes produce indistinguishable ykman errors otherwise.
export function readEnrolledSerial(): string | null {
  try {
    const raw = fsSync.readFileSync(enrolledSerialFilePath(), 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeEnrolledSerial(serial: string): void {
  fsSync.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(enrolledSerialFilePath(), `${serial}\n`, { mode: 0o600 });
}

export function listYubikeySerials(): string[] {
  const r = spawnSync('ykman', ['list', '--serials'], { encoding: 'utf-8' });
  if (r.status !== 0) return [];
  return (r.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function diagnoseSerialMismatch(
  enrolledSerial: string | null,
  presentSerials: string[],
): string | null {
  if (!enrolledSerial) return null;
  if (presentSerials.includes(enrolledSerial)) return null;
  if (presentSerials.length === 0) {
    return `No YubiKey detected. The keychain was enrolled against YubiKey serial ${enrolledSerial} — insert that key and re-run.`;
  }
  return (
    `Keychain was enrolled against YubiKey serial ${enrolledSerial}, but serial ` +
    `${presentSerials.join(', ')} is currently present — this is a different key. ` +
    `Insert the enrolled key, or re-enroll this one (program slot 2 with ` +
    '`ykman otp chalresp --generate --touch 2`, then re-run `noxctl keychain init`).'
  );
}

export function ykmanAvailable(): boolean {
  const r = spawnSync('ykman', ['--version'], { encoding: 'utf-8' });
  return r.status === 0;
}

export function yubikeyPresent(): boolean {
  const r = spawnSync('ykman', ['list'], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

// Ask the YubiKey (OTP slot CR_SLOT) to HMAC the fixed challenge. Touch is
// required, so ykman's "Touch your YubiKey..." prompt is inherited to the
// terminal. A missed tap exits non-zero ("Failed to write to the YubiKey").
// The 40-hex response is the keychain password — returned, never logged.
export function computeChallengeResponse(challengeHex: string): string {
  const r = spawnSync('ykman', ['otp', 'calculate', CR_SLOT, challengeHex], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new ChallengeResponseError('ykman not found — install it with `brew install ykman`');
  }
  if (r.status !== 0) {
    // ykman's own wording is misleading here: "Failed to write to the
    // YubiKey... restricted access" is what a touch timeout produces, and
    // "empty slot" means this key was never enrolled. Translate both.
    const stderr = (r.stderr || '').toString();
    if (/empty slot/i.test(stderr)) {
      throw new ChallengeResponseError(
        `Slot ${CR_SLOT} is not programmed on this YubiKey — it is not the enrolled key ` +
          '(or its slot was wiped). Program it with `ykman otp chalresp --generate --touch 2` ' +
          'or insert the enrolled key.',
      );
    }
    throw new ChallengeResponseError(
      'Challenge-response failed. This is usually a missed touch — re-run and tap the key firmly when it blinks.' +
        (stderr.trim() ? `\n(ykman said: ${stderr.trim()})` : ''),
    );
  }
  const response = (r.stdout || '').trim();
  if (!/^[0-9a-fA-F]{40}$/.test(response)) {
    throw new ChallengeResponseError(
      `Unexpected challenge-response output (expected 40 hex chars)`,
    );
  }
  return response;
}

function runSwift(script: string, args: string[], input?: string): number {
  const scriptPath = path.join(os.tmpdir(), `noxctl-kc-${process.pid}-${Date.now()}.swift`);
  try {
    fsSync.writeFileSync(scriptPath, script, { mode: 0o600 });
    const r = spawnSync('swift', [scriptPath, ...args], {
      input,
      encoding: 'utf-8',
      stdio: input === undefined ? 'pipe' : ['pipe', 'pipe', 'pipe'],
    });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    try {
      fsSync.unlinkSync(scriptPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

// Create a file-based keychain at keychainPath with the given password (fed via
// stdin, never argv). Returns 'created', or 'exists' if one is already there.
export function createDedicatedKeychain(
  keychainPath: string,
  password: string,
): 'created' | 'exists' {
  const script = `
import Foundation
import Security

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let password = String(data: data, encoding: .utf8) else { exit(1) }
let kcPath = CommandLine.arguments[1]
let pwBytes = Array(password.utf8)
var kc: SecKeychain?
let status = SecKeychainCreate(kcPath, UInt32(pwBytes.count), pwBytes, false, nil, &kc)
if status == errSecDuplicateKeychain { exit(4) }
if status != errSecSuccess { exit(1) }
`;
  const code = runSwift(script, [keychainPath], password);
  if (code === 4) return 'exists';
  if (code !== 0) throw new Error('Failed to create keychain');
  return 'created';
}

// Unlock the keychain with the given password (fed via stdin). Throws on a
// wrong password (e.g. a different YubiKey or re-programmed slot).
export function unlockDedicatedKeychain(keychainPath: string, password: string): void {
  const script = `
import Foundation
import Security

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let password = String(data: data, encoding: .utf8) else { exit(1) }
let kcPath = CommandLine.arguments[1]
var kc: SecKeychain?
if SecKeychainOpen(kcPath, &kc) != errSecSuccess || kc == nil { exit(3) }
let pwBytes = Array(password.utf8)
let status = SecKeychainUnlock(kc!, UInt32(pwBytes.count), pwBytes, true)
if status != errSecSuccess { exit(2) }
`;
  const code = runSwift(script, [keychainPath], password);
  if (code === 3)
    throw new Error(`Keychain not found at ${keychainPath} — run \`noxctl keychain init\``);
  if (code !== 0) {
    throw new Error(
      'Unlock failed — wrong response. Is this the YubiKey you set up, with slot 2 intact?',
    );
  }
}

export type LockState = 'locked' | 'unlocked' | 'missing';

export function keychainLockState(keychainPath: string): LockState {
  const script = `
import Foundation
import Security

let kcPath = CommandLine.arguments[1]
var kc: SecKeychain?
if SecKeychainOpen(kcPath, &kc) != errSecSuccess || kc == nil { print("missing"); exit(0) }
var st: SecKeychainStatus = 0
if SecKeychainGetStatus(kc!, &st) != errSecSuccess { print("missing"); exit(0) }
if (st & SecKeychainStatus(kSecUnlockStateStatus)) != 0 { print("unlocked") } else { print("locked") }
`;
  const scriptPath = path.join(os.tmpdir(), `noxctl-kcstat-${process.pid}.swift`);
  try {
    fsSync.writeFileSync(scriptPath, script, { mode: 0o600 });
    const r = spawnSync('swift', [scriptPath, keychainPath], { encoding: 'utf-8' });
    const out = (r.stdout || '').trim();
    if (out === 'unlocked' || out === 'locked' || out === 'missing') return out;
    return 'missing';
  } finally {
    try {
      fsSync.unlinkSync(scriptPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

// Lock when the system sleeps, no idle timeout. This is the per-session secret:
// one tap on wake, open until next sleep.
export function setLockOnSleep(keychainPath: string): void {
  const r = spawnSync('security', ['set-keychain-settings', '-l', keychainPath], {
    encoding: 'utf-8',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `security set-keychain-settings failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`,
    );
  }
}

export function lockKeychain(keychainPath: string): void {
  const r = spawnSync('security', ['lock-keychain', keychainPath], { encoding: 'utf-8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `security lock-keychain failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`,
    );
  }
}

// Delete a generic-password from the LOGIN keychain specifically. The login
// keychain path is passed explicitly so this never touches the dedicated
// keychain even if SecKeychainCreate added it to the session search list.
// Used by `noxctl keychain seal` to remove the pre-migration login copies.
// Returns true if an item was deleted (exit 0), false if none matched.
export function deleteLoginSecret(account: string): boolean {
  const r = spawnSync(
    'security',
    ['delete-generic-password', '-a', account, '-s', SERVICE_NAME, loginKeychainPath()],
    { encoding: 'utf-8' },
  );
  return r.status === 0;
}
