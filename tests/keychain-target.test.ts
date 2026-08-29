import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const childProcess = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const fsSync = vi.hoisted(() => ({
  default: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('node:child_process', () => childProcess);
vi.mock('node:fs', () => fsSync);

import {
  KeychainLockedError,
  KeychainAccessError,
  ChallengeResponseError,
  dedicatedKeychainPath,
  loginKeychainPath,
  challengeFilePath,
  activeKeychainPath,
  isDedicatedModeActive,
  readDedicatedSecret,
  generateChallenge,
  readChallenge,
  writeChallenge,
  ykmanAvailable,
  yubikeyPresent,
  computeChallengeResponse,
  createDedicatedKeychain,
  unlockDedicatedKeychain,
  keychainLockState,
  setLockOnSleep,
  lockKeychain,
  deleteLoginSecret,
} from '../src/keychain-target.js';

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_KEYCHAIN_ENV = process.env.NOXCTL_KEYCHAIN_PATH;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  childProcess.spawnSync.mockReset();
  childProcess.execFileSync.mockReset();
  fsSync.default.writeFileSync.mockReset();
  fsSync.default.unlinkSync.mockReset();
  fsSync.default.existsSync.mockReset();
  fsSync.default.existsSync.mockReturnValue(false);
  fsSync.default.readFileSync.mockReset();
  fsSync.default.mkdirSync.mockReset();
  delete process.env.NOXCTL_KEYCHAIN_PATH;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
  if (ORIGINAL_KEYCHAIN_ENV === undefined) delete process.env.NOXCTL_KEYCHAIN_PATH;
  else process.env.NOXCTL_KEYCHAIN_PATH = ORIGINAL_KEYCHAIN_ENV;
});

describe('paths', () => {
  // These are macOS keychain paths, but the builders are pure path joins that run
  // anywhere — compare on normalized separators so the suite is platform-agnostic.
  const posix = (p: string) => p.replace(/\\/g, '/');

  it('dedicatedKeychainPath ends with fortnox-mcp.keychain-db under Library/Keychains', () => {
    expect(posix(dedicatedKeychainPath())).toMatch(/Library\/Keychains\/fortnox-mcp\.keychain-db$/);
  });

  it('loginKeychainPath ends with login.keychain-db under Library/Keychains', () => {
    expect(posix(loginKeychainPath())).toMatch(/Library\/Keychains\/login\.keychain-db$/);
  });

  it('challengeFilePath ends with keychain-challenge', () => {
    expect(challengeFilePath()).toMatch(/keychain-challenge$/);
  });
});

describe('activeKeychainPath precedence', () => {
  it('honors the NOXCTL_KEYCHAIN_PATH env override above everything', () => {
    process.env.NOXCTL_KEYCHAIN_PATH = '/tmp/override.keychain-db';
    setPlatform('linux');
    expect(activeKeychainPath()).toBe('/tmp/override.keychain-db');
    expect(isDedicatedModeActive()).toBe(true);
  });

  it('ignores a blank/whitespace override', () => {
    process.env.NOXCTL_KEYCHAIN_PATH = '   ';
    setPlatform('darwin');
    fsSync.default.existsSync.mockReturnValue(false);
    expect(activeKeychainPath()).toBeNull();
  });

  it('returns null on non-darwin without an override', () => {
    setPlatform('linux');
    expect(activeKeychainPath()).toBeNull();
    expect(isDedicatedModeActive()).toBe(false);
  });

  it('returns the dedicated path on darwin when the challenge file marks it configured', () => {
    setPlatform('darwin');
    fsSync.default.existsSync.mockReturnValue(true);
    expect(activeKeychainPath()).toBe(dedicatedKeychainPath());
  });

  it('does not fall back when the configured keychain file is hidden by a sandbox', () => {
    setPlatform('darwin');
    fsSync.default.existsSync.mockImplementation((p: string) => p === challengeFilePath());
    expect(activeKeychainPath()).toBe(dedicatedKeychainPath());
    expect(isDedicatedModeActive()).toBe(true);
  });

  it('returns null on darwin when the challenge file is missing (half-created keychain)', () => {
    setPlatform('darwin');
    fsSync.default.existsSync.mockImplementation((p: string) => p === dedicatedKeychainPath());
    expect(activeKeychainPath()).toBeNull();
  });
});

describe('challenge file helpers', () => {
  it('generateChallenge returns 64 hex chars (32 bytes)', () => {
    const c = generateChallenge();
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(generateChallenge()).not.toBe(c);
  });

  it('readChallenge trims and returns the stored value', () => {
    fsSync.default.readFileSync.mockReturnValue('  abc123\n');
    expect(readChallenge()).toBe('abc123');
  });

  it('readChallenge returns null for an empty file', () => {
    fsSync.default.readFileSync.mockReturnValue('   \n');
    expect(readChallenge()).toBeNull();
  });

  it('readChallenge returns null when the file is missing', () => {
    fsSync.default.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readChallenge()).toBeNull();
  });

  it('writeChallenge creates the config dir and writes with a trailing newline at mode 0600', () => {
    writeChallenge('deadbeef');
    expect(fsSync.default.mkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
    expect(fsSync.default.writeFileSync).toHaveBeenCalledWith(
      challengeFilePath(),
      'deadbeef\n',
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

describe('ykman availability probes', () => {
  it('ykmanAvailable is true when `ykman --version` exits 0', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: 'YubiKey Manager 5.9.1' });
    expect(ykmanAvailable()).toBe(true);
  });

  it('ykmanAvailable is false when ykman is missing', () => {
    childProcess.spawnSync.mockReturnValue({ status: 127, stdout: '' });
    expect(ykmanAvailable()).toBe(false);
  });

  it('yubikeyPresent is true when `ykman list` exits 0 with output', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: 'YubiKey 5 NFC [OTP+FIDO+CCID]' });
    expect(yubikeyPresent()).toBe(true);
  });

  it('yubikeyPresent is false when no key is listed', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '   ' });
    expect(yubikeyPresent()).toBe(false);
  });
});

describe('computeChallengeResponse', () => {
  it('returns the 40-hex response on a successful tap', () => {
    const resp = 'a'.repeat(40);
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: `  ${resp}\n` });
    expect(computeChallengeResponse('cafe')).toBe(resp);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'ykman',
      ['otp', 'calculate', '2', 'cafe'],
      expect.anything(),
    );
  });

  it('throws ChallengeResponseError when ykman is not installed (ENOENT)', () => {
    childProcess.spawnSync.mockReturnValue({ error: { code: 'ENOENT' } });
    expect(() => computeChallengeResponse('cafe')).toThrow(ChallengeResponseError);
  });

  it('throws ChallengeResponseError on a missed touch (non-zero exit)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(() => computeChallengeResponse('cafe')).toThrow(/missed touch/i);
  });

  it('throws ChallengeResponseError on unexpected (non-40-hex) output', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: 'not-hex' });
    expect(() => computeChallengeResponse('cafe')).toThrow(ChallengeResponseError);
  });
});

describe('createDedicatedKeychain', () => {
  it('returns "created" when SecKeychainCreate succeeds (exit 0)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    expect(createDedicatedKeychain('/tmp/k.keychain-db', 'pw')).toBe('created');
  });

  it('returns "exists" when the keychain is already there (exit 4)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 4 });
    expect(createDedicatedKeychain('/tmp/k.keychain-db', 'pw')).toBe('exists');
  });

  it('throws on any other failure', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1 });
    expect(() => createDedicatedKeychain('/tmp/k.keychain-db', 'pw')).toThrow();
  });
});

describe('unlockDedicatedKeychain', () => {
  it('succeeds on exit 0', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    expect(() => unlockDedicatedKeychain('/tmp/k.keychain-db', 'pw')).not.toThrow();
  });

  it('throws "not found" on exit 3', () => {
    childProcess.spawnSync.mockReturnValue({ status: 3 });
    expect(() => unlockDedicatedKeychain('/tmp/k.keychain-db', 'pw')).toThrow(/not found/i);
  });

  it('throws "wrong response" on exit 2', () => {
    childProcess.spawnSync.mockReturnValue({ status: 2 });
    expect(() => unlockDedicatedKeychain('/tmp/k.keychain-db', 'pw')).toThrow(/wrong response/i);
  });
});

describe('keychainLockState', () => {
  it.each(['unlocked', 'locked', 'missing'] as const)('maps swift output "%s"', (state) => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: `${state}\n` });
    expect(keychainLockState('/tmp/k.keychain-db')).toBe(state);
  });

  it('falls back to "missing" on unexpected output', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: 'garbage' });
    expect(keychainLockState('/tmp/k.keychain-db')).toBe('missing');
  });
});

describe('readDedicatedSecret', () => {
  it('decodes base64 stdout on exit 0', () => {
    const secret = JSON.stringify({ client_id: 'x' });
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(secret, 'utf-8').toString('base64'),
    });
    expect(readDedicatedSecret('profile:default', '/tmp/k.keychain-db')).toBe(secret);
  });

  it('throws KeychainLockedError on exit 2 (locked / interaction not allowed)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 2, stdout: '' });
    expect(() => readDedicatedSecret('profile:default', '/tmp/k.keychain-db')).toThrow(
      KeychainLockedError,
    );
  });

  it('returns null on exit 3 (item absent)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 3, stdout: '' });
    expect(readDedicatedSecret('profile:default', '/tmp/k.keychain-db')).toBeNull();
  });

  it('throws KeychainAccessError when the configured keychain cannot be opened', () => {
    childProcess.spawnSync.mockReturnValue({ status: 4, stdout: '', stderr: 'open failed' });
    expect(() => readDedicatedSecret('profile:default', '/tmp/k.keychain-db')).toThrow(
      KeychainAccessError,
    );
  });

  it('passes account and keychain path as argv (not interpolated)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 3, stdout: '' });
    readDedicatedSecret('profile:weird name', '/tmp/odd path.keychain-db');
    const call = childProcess.spawnSync.mock.calls[0]!;
    expect(call[0]).toBe('swift');
    expect(call[1]).toEqual([
      expect.stringContaining('.swift'),
      'profile:weird name',
      '/tmp/odd path.keychain-db',
    ]);
  });
});

describe('security CLI wrappers', () => {
  it('setLockOnSleep calls `security set-keychain-settings -l <path>`', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    setLockOnSleep('/tmp/k.keychain-db');
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'security',
      ['set-keychain-settings', '-l', '/tmp/k.keychain-db'],
      expect.anything(),
    );
  });

  it('setLockOnSleep throws when `security` exits non-zero (no silent success)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, stderr: 'SecKeychainSetSettings failed' });
    expect(() => setLockOnSleep('/tmp/k.keychain-db')).toThrow(/set-keychain-settings failed/i);
  });

  it('setLockOnSleep throws when `security` cannot be spawned', () => {
    childProcess.spawnSync.mockReturnValue({ error: new Error('ENOENT'), status: null });
    expect(() => setLockOnSleep('/tmp/k.keychain-db')).toThrow(/ENOENT/);
  });

  it('lockKeychain calls `security lock-keychain <path>`', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    lockKeychain('/tmp/k.keychain-db');
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'security',
      ['lock-keychain', '/tmp/k.keychain-db'],
      expect.anything(),
    );
  });

  it('lockKeychain throws when `security` exits non-zero (no false "locked" report)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, stderr: 'could not lock' });
    expect(() => lockKeychain('/tmp/k.keychain-db')).toThrow(/lock-keychain failed/i);
  });

  it('deleteLoginSecret targets the login keychain explicitly and reports success via exit 0', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    expect(deleteLoginSecret('profile:default')).toBe(true);
    const call = childProcess.spawnSync.mock.calls[0]!;
    expect(call[0]).toBe('security');
    expect(call[1]).toEqual([
      'delete-generic-password',
      '-a',
      'profile:default',
      '-s',
      'fortnox-mcp',
      loginKeychainPath(),
    ]);
  });

  it('deleteLoginSecret returns false when nothing matched (non-zero exit)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 44 });
    expect(deleteLoginSecret('profile:none')).toBe(false);
  });
});

describe('YubiKey serial enrollment (#33)', () => {
  it('listYubikeySerials parses one serial per line', async () => {
    const { listYubikeySerials } = await import('../src/keychain-target.js');
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '12345678\n36014135\n' });
    expect(listYubikeySerials()).toEqual(['12345678', '36014135']);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'ykman',
      ['list', '--serials'],
      expect.anything(),
    );
  });

  it('listYubikeySerials returns [] when ykman fails', async () => {
    const { listYubikeySerials } = await import('../src/keychain-target.js');
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(listYubikeySerials()).toEqual([]);
  });

  it('enrolledSerialFilePath ends with keychain-serial', async () => {
    const { enrolledSerialFilePath } = await import('../src/keychain-target.js');
    expect(enrolledSerialFilePath()).toMatch(/keychain-serial$/);
  });

  it('readEnrolledSerial returns the trimmed file content or null', async () => {
    const { readEnrolledSerial } = await import('../src/keychain-target.js');
    fsSync.default.readFileSync.mockReturnValue(' 12345678\n');
    expect(readEnrolledSerial()).toBe('12345678');
    fsSync.default.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readEnrolledSerial()).toBeNull();
  });

  it('writeEnrolledSerial persists the serial under the config dir', async () => {
    const { writeEnrolledSerial, enrolledSerialFilePath } =
      await import('../src/keychain-target.js');
    writeEnrolledSerial('12345678');
    expect(fsSync.default.writeFileSync).toHaveBeenCalledWith(
      enrolledSerialFilePath(),
      '12345678\n',
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});

describe('diagnoseSerialMismatch (#33)', () => {
  it('is silent when no serial was enrolled', async () => {
    const { diagnoseSerialMismatch } = await import('../src/keychain-target.js');
    expect(diagnoseSerialMismatch(null, ['12345678'])).toBeNull();
  });

  it('is silent when the enrolled key is present', async () => {
    const { diagnoseSerialMismatch } = await import('../src/keychain-target.js');
    expect(diagnoseSerialMismatch('12345678', ['12345678', '99999999'])).toBeNull();
  });

  it('names both serials when a different key is present', async () => {
    const { diagnoseSerialMismatch } = await import('../src/keychain-target.js');
    const msg = diagnoseSerialMismatch('12345678', ['36014135']);
    expect(msg).toContain('12345678');
    expect(msg).toContain('36014135');
    expect(msg).toMatch(/different key/i);
  });

  it('reports when no key is present at all', async () => {
    const { diagnoseSerialMismatch } = await import('../src/keychain-target.js');
    const msg = diagnoseSerialMismatch('12345678', []);
    expect(msg).toContain('12345678');
    expect(msg).toMatch(/no yubikey/i);
  });
});

describe('computeChallengeResponse error rephrasing (#33)', () => {
  it('explains an unprogrammed slot instead of passing through ykman wording', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Error: Cannot perform challenge-response on an empty slot.\n',
    });
    expect(() => computeChallengeResponse('cafe')).toThrow(/slot 2 is not programmed/i);
  });

  it('rephrases the misleading "Failed to write" error as a missed touch', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr:
        'ERROR: Failed to write to the YubiKey. Make sure the device does not have restricted access.\n',
    });
    expect(() => computeChallengeResponse('cafe')).toThrow(/missed touch/i);
  });
});
