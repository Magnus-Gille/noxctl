import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

const fsPromises = vi.hoisted(() => ({
  default: {
    readFile: vi.fn(),
    rm: vi.fn(),
  },
}));

const fsSync = vi.hoisted(() => ({
  default: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('node:child_process', () => childProcess);
vi.mock('node:fs/promises', () => fsPromises);
vi.mock('node:fs', () => fsSync);

import {
  loadCredentialBlob,
  saveCredentialBlob,
  deleteCredentialBlob,
} from '../src/credentials-store.js';
import {
  validateProfileName,
  sanitizeForFilename,
  keychainAccount,
  InvalidProfileNameError,
} from '../src/profile-name.js';

const SERVICE_NAME = 'fortnox-mcp';
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
}

beforeEach(() => {
  childProcess.execFileSync.mockReset();
  childProcess.spawnSync.mockReset();
  fsPromises.default.readFile.mockReset();
  fsPromises.default.rm.mockReset();
  fsSync.default.writeFileSync.mockReset();
  fsSync.default.unlinkSync.mockReset();
});

afterEach(() => {
  restorePlatform();
});

describe('validateProfileName', () => {
  it('accepts simple alphanumeric names', () => {
    expect(validateProfileName('default')).toBe('default');
    expect(validateProfileName('demo')).toBe('demo');
    expect(validateProfileName('work42')).toBe('work42');
  });

  it('accepts names with dots, underscores, and dashes', () => {
    expect(validateProfileName('acme.prod')).toBe('acme.prod');
    expect(validateProfileName('my_client')).toBe('my_client');
    expect(validateProfileName('kund-01')).toBe('kund-01');
  });

  it('accepts mixed case and preserves it', () => {
    expect(validateProfileName('Demo')).toBe('Demo');
    expect(validateProfileName('ACME')).toBe('ACME');
  });

  it('rejects empty string', () => {
    expect(() => validateProfileName('')).toThrow(InvalidProfileNameError);
  });

  it('rejects names over 32 chars', () => {
    expect(() => validateProfileName('a'.repeat(33))).toThrow(InvalidProfileNameError);
  });

  it('accepts names exactly 32 chars', () => {
    expect(validateProfileName('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('rejects names starting with non-alphanumeric', () => {
    expect(() => validateProfileName('.hidden')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('-dash')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('_under')).toThrow(InvalidProfileNameError);
  });

  it('rejects path separators and traversal sequences', () => {
    expect(() => validateProfileName('..')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('a/b')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('a\\b')).toThrow(InvalidProfileNameError);
  });

  it('rejects whitespace', () => {
    expect(() => validateProfileName('my profile')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('tab\tname')).toThrow(InvalidProfileNameError);
  });

  it('rejects Windows reserved device names', () => {
    expect(() => validateProfileName('con')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('NUL')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('com1')).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName('LPT9')).toThrow(InvalidProfileNameError);
  });

  it('rejects non-string input', () => {
    expect(() => validateProfileName(undefined)).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName(null)).toThrow(InvalidProfileNameError);
    expect(() => validateProfileName(42)).toThrow(InvalidProfileNameError);
  });
});

describe('sanitizeForFilename', () => {
  it('lowercases the validated name', () => {
    expect(sanitizeForFilename('Demo')).toBe('demo');
    expect(sanitizeForFilename('ACME.Prod')).toBe('acme.prod');
  });

  it('throws on names that would be invalid as profiles', () => {
    expect(() => sanitizeForFilename('con')).toThrow(InvalidProfileNameError);
    expect(() => sanitizeForFilename('../etc')).toThrow(InvalidProfileNameError);
  });
});

describe('keychainAccount', () => {
  it('returns profile:<lowercased> form', () => {
    expect(keychainAccount('default')).toBe('profile:default');
    expect(keychainAccount('Demo')).toBe('profile:demo');
    expect(keychainAccount('acme.prod')).toBe('profile:acme.prod');
  });

  it('throws on invalid names', () => {
    expect(() => keychainAccount('..')).toThrow(InvalidProfileNameError);
  });
});

describe('loadCredentialBlob (darwin)', () => {
  beforeEach(() => {
    setPlatform('darwin');
  });

  it('default profile reads both new and legacy keychain accounts', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('default');

    const accounts = childProcess.execFileSync.mock.calls
      .filter(([cmd]) => cmd === 'security')
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(accounts).toEqual(expect.arrayContaining(['default', 'profile:default']));
  });

  it('non-default profile reads only the profile:<name> account', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('demo');

    const accounts = childProcess.execFileSync.mock.calls
      .filter(([cmd]) => cmd === 'security')
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(accounts).toEqual(['profile:demo']);
  });

  it('treats mixed-case "Default" as the default profile (case-insensitive)', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('Default');

    const accounts = childProcess.execFileSync.mock.calls
      .filter(([cmd]) => cmd === 'security')
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(accounts).toEqual(expect.arrayContaining(['default', 'profile:default']));
  });

  it('returns null with source=null when no credentials exist anywhere', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadCredentialBlob('default');
    expect(result).toEqual({ blob: null, source: null, legacyBlob: null });
  });

  it('returns legacy blob with source=legacy when only legacy keychain entry exists', async () => {
    const legacyBlob = JSON.stringify({ client_id: 'legacy' });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toEqual({ blob: legacyBlob, source: 'legacy', legacyBlob });
  });

  it('returns new blob with source=new and legacyBlob=null when only new keychain entry exists', async () => {
    const newBlob = JSON.stringify({ client_id: 'new' });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toEqual({ blob: newBlob, source: 'new', legacyBlob: null });
  });

  it('exposes legacyBlob alongside the preferred new blob when both exist', async () => {
    const newBlob = JSON.stringify({ schema_version: 3, last_write_epoch: 100, side: 'new' });
    const legacyBlob = JSON.stringify({
      schema_version: 2,
      last_write_epoch: 999,
      side: 'legacy',
      tenant_id: 'only-in-legacy',
    });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result.blob).toBe(newBlob);
    expect(result.legacyBlob).toBe(legacyBlob);
  });

  it('prefers new blob when both exist with equal metadata', async () => {
    const newBlob = JSON.stringify({ schema_version: 2, last_write_epoch: 1000, side: 'new' });
    const legacyBlob = JSON.stringify({
      schema_version: 2,
      last_write_epoch: 1000,
      side: 'legacy',
    });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result.source).toBe('both-new-preferred');
    expect(result.blob).toBe(newBlob);
  });

  it('prefers higher last_write_epoch when schema matches', async () => {
    const newBlob = JSON.stringify({ schema_version: 2, last_write_epoch: 500, side: 'new' });
    const legacyBlob = JSON.stringify({
      schema_version: 2,
      last_write_epoch: 999,
      side: 'legacy',
    });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result.source).toBe('both-legacy-preferred');
    expect(result.blob).toBe(legacyBlob);
  });

  it('prefers higher schema_version even when epoch is older', async () => {
    const newBlob = JSON.stringify({ schema_version: 3, last_write_epoch: 100, side: 'new' });
    const legacyBlob = JSON.stringify({
      schema_version: 2,
      last_write_epoch: 999999,
      side: 'legacy',
    });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result.source).toBe('both-new-preferred');
    expect(result.blob).toBe(newBlob);
  });

  it('falls back to legacy plaintext when no keychain entry exists', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockResolvedValue('{"client_id":"plaintext"}');

    const result = await loadCredentialBlob('default');
    expect(result).toEqual({
      blob: '{"client_id":"plaintext"}',
      source: 'legacy-plaintext',
      legacyBlob: '{"client_id":"plaintext"}',
    });
  });

  it('does not fall back to legacy plaintext for non-default profiles', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockResolvedValue('{"client_id":"plaintext"}');

    const result = await loadCredentialBlob('demo');
    expect(result).toEqual({ blob: null, source: null, legacyBlob: null });
  });
});

describe('saveCredentialBlob (darwin)', () => {
  beforeEach(() => {
    setPlatform('darwin');
    // Swift helper returns success, so the security CLI fallback does not run.
    childProcess.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' });
  });

  function writtenAccounts(): string[] {
    return fsSync.default.writeFileSync.mock.calls
      .map((call) => call[1] as string)
      .flatMap((body) => {
        const match = /let account = "([^"]+)"/.exec(body);
        return match ? [match[1]!] : [];
      });
  }

  it('default profile writes only to the new profile:default account by default', async () => {
    await saveCredentialBlob('{"x":1}', 'default');
    expect(writtenAccounts()).toEqual(['profile:default']);
  });

  it('default profile dual-writes to legacy when alsoWriteLegacy is set', async () => {
    await saveCredentialBlob('{"x":1}', 'default', { alsoWriteLegacy: true });
    expect(writtenAccounts()).toEqual(expect.arrayContaining(['profile:default', 'default']));
    expect(writtenAccounts()).toHaveLength(2);
  });

  it('swallows a legacy-slot write failure when primary write succeeded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Primary (profile:default) write succeeds via the Swift helper; legacy
    // (account=default) write fails at the security CLI fallback.
    childProcess.spawnSync.mockImplementationOnce(() => ({
      status: 0,
      stderr: '',
      stdout: '',
    }));
    childProcess.spawnSync.mockImplementationOnce(() => ({
      status: 1,
      stderr: 'legacy keychain unavailable',
      stdout: '',
    }));
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('security CLI also unavailable');
    });

    await expect(
      saveCredentialBlob('{"x":1}', 'default', { alsoWriteLegacy: true }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/legacy slot/i));
    warnSpy.mockRestore();
  });

  it('non-default profile ignores alsoWriteLegacy', async () => {
    await saveCredentialBlob('{"x":1}', 'demo', { alsoWriteLegacy: true });
    expect(writtenAccounts()).toEqual(['profile:demo']);
  });

  it('non-default profile writes to profile:<name> account', async () => {
    await saveCredentialBlob('{"x":1}', 'demo');
    expect(writtenAccounts()).toEqual(['profile:demo']);
  });

  it('sanitizes mixed-case profile names to lowercase in the keychain account', async () => {
    await saveCredentialBlob('{"x":1}', 'Demo');
    expect(writtenAccounts()).toEqual(['profile:demo']);
  });

  it('treats mixed-case Default as the default profile (case-insensitive)', async () => {
    await saveCredentialBlob('{"x":1}', 'Default', { alsoWriteLegacy: true });
    expect(writtenAccounts()).toEqual(expect.arrayContaining(['profile:default', 'default']));
  });

  it('rejects invalid profile names', async () => {
    await expect(saveCredentialBlob('{"x":1}', '..')).rejects.toThrow(InvalidProfileNameError);
  });

  it('removes legacy plaintext file when saving default profile', async () => {
    fsPromises.default.rm.mockResolvedValue(undefined);
    await saveCredentialBlob('{"x":1}', 'default');
    expect(fsPromises.default.rm).toHaveBeenCalled();
  });
});

describe('deleteCredentialBlob (darwin)', () => {
  beforeEach(() => {
    setPlatform('darwin');
  });

  it('default profile attempts to delete both legacy and new accounts', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await deleteCredentialBlob('default');

    const deleteAccounts = childProcess.execFileSync.mock.calls
      .filter(
        ([cmd, args]) =>
          cmd === 'security' && (args as string[]).includes('delete-generic-password'),
      )
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(deleteAccounts).toContain('default');
    expect(deleteAccounts).toContain('profile:default');
  });

  it('non-default profile deletes only the profile:<name> account', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await deleteCredentialBlob('demo');

    const deleteAccounts = childProcess.execFileSync.mock.calls
      .filter(
        ([cmd, args]) =>
          cmd === 'security' && (args as string[]).includes('delete-generic-password'),
      )
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(deleteAccounts).toEqual(['profile:demo']);
  });

  it('returns true when at least one account was deleted', async () => {
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'default') return '';
      throw new Error('not found');
    });

    const result = await deleteCredentialBlob('default');
    expect(result).toBe(true);
  });
});

describe('Linux secret-tool backend', () => {
  beforeEach(() => {
    setPlatform('linux');
  });

  it('uses account=profile:<name> for non-default profiles', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('demo');

    const call = childProcess.execFileSync.mock.calls.find(([cmd]) => cmd === 'secret-tool');
    expect(call).toBeDefined();
    const args = call![1] as string[];
    const accountIdx = args.indexOf('account');
    expect(args[accountIdx + 1]).toBe('profile:demo');
  });

  it('writes to account=profile:default for the default profile by default', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await saveCredentialBlob('{"x":1}', 'default');

    const storeCalls = childProcess.execFileSync.mock.calls.filter(
      ([cmd, args]) => cmd === 'secret-tool' && (args as string[]).includes('store'),
    );
    const accounts = storeCalls.map((call) => {
      const args = call[1] as string[];
      const idx = args.indexOf('account');
      return args[idx + 1];
    });
    expect(accounts).toEqual(['profile:default']);
  });

  it('dual-writes to legacy account=default when alsoWriteLegacy is set', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await saveCredentialBlob('{"x":1}', 'default', { alsoWriteLegacy: true });

    const storeCalls = childProcess.execFileSync.mock.calls.filter(
      ([cmd, args]) => cmd === 'secret-tool' && (args as string[]).includes('store'),
    );
    const accounts = storeCalls.map((call) => {
      const args = call[1] as string[];
      const idx = args.indexOf('account');
      return args[idx + 1];
    });
    expect(accounts).toEqual(expect.arrayContaining(['profile:default', 'default']));
    expect(accounts).toHaveLength(2);
  });
});

describe('Windows DPAPI backend', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('uses credentials.<name>.dpapi for non-default profiles', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('demo');

    const call = childProcess.execFileSync.mock.calls.find(([cmd]) => cmd === 'powershell');
    expect(call).toBeDefined();
    const script = (call![1] as string[]).join(' ');
    expect(script).toContain('credentials.demo.dpapi');
    expect(script).not.toContain('credentials.dpapi');
  });

  it('reads both new credentials.default.dpapi and legacy credentials.dpapi for default profile', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('default');

    const commands = childProcess.execFileSync.mock.calls
      .filter(([cmd]) => cmd === 'powershell')
      .map((call) => (call[1] as string[]).join(' '));

    expect(commands.some((s) => /credentials\.dpapi(?![.a-z])/.test(s))).toBe(true);
    expect(commands.some((s) => s.includes('credentials.default.dpapi'))).toBe(true);
  });

  it('lowercases mixed-case names in the filename', async () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' });
    await saveCredentialBlob('{"x":1}', 'Demo');

    const call = childProcess.spawnSync.mock.calls.find(([cmd]) => cmd === 'powershell');
    expect(call).toBeDefined();
    const script = (call![1] as string[]).join(' ');
    expect(script).toContain('credentials.demo.dpapi');
  });
});

describe('service name is always fortnox-mcp', () => {
  it('across all profile forms on darwin', async () => {
    setPlatform('darwin');
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('demo');

    for (const call of childProcess.execFileSync.mock.calls) {
      const [cmd, args] = call;
      if (cmd !== 'security') continue;
      const idx = (args as string[]).indexOf('-s');
      expect((args as string[])[idx + 1]).toBe(SERVICE_NAME);
    }
  });
});
