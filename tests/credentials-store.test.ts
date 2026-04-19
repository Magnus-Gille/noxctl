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

  it('default profile reads both legacy and new accounts via `security`', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('default');

    const calls = childProcess.execFileSync.mock.calls;
    const accounts = calls
      .filter(([cmd]) => cmd === 'security')
      .map((call) => {
        const args = call[1] as string[];
        const idx = args.indexOf('-a');
        return args[idx + 1];
      });

    expect(accounts).toContain('profile:default');
    expect(accounts).toContain('default');
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

  it('returns null when no credentials exist anywhere', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await loadCredentialBlob('default');
    expect(result).toBeNull();
  });

  it('returns legacy blob when only legacy keychain entry exists', async () => {
    const legacyBlob = JSON.stringify({ client_id: 'legacy' });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'default') return legacyBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toBe(legacyBlob);
  });

  it('returns new blob when only new keychain entry exists', async () => {
    const newBlob = JSON.stringify({ schema_version: 2, client_id: 'new' });
    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'profile:default') return newBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toBe(newBlob);
  });

  it('prefers higher schema_version when both legacy and new exist', async () => {
    const legacyBlob = JSON.stringify({ client_id: 'legacy' }); // v1 (missing)
    const newBlob = JSON.stringify({ schema_version: 2, client_id: 'new' });

    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'default') return legacyBlob;
      if (account === 'profile:default') return newBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toBe(newBlob);
  });

  it('prefers new account on schema tie', async () => {
    const legacyBlob = JSON.stringify({ schema_version: 2, client_id: 'legacy' });
    const newBlob = JSON.stringify({ schema_version: 2, client_id: 'new' });

    childProcess.execFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      const idx = args.indexOf('-a');
      const account = args[idx + 1];
      if (account === 'default') return legacyBlob;
      if (account === 'profile:default') return newBlob;
      throw new Error('not found');
    });

    const result = await loadCredentialBlob('default');
    expect(result).toBe(newBlob);
  });

  it('falls back to legacy plaintext when no keychain entries exist', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockResolvedValue('{"client_id":"plaintext"}');

    const result = await loadCredentialBlob('default');
    expect(result).toBe('{"client_id":"plaintext"}');
  });

  it('does not fall back to legacy plaintext for non-default profiles', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('no keychain item');
    });
    fsPromises.default.readFile.mockResolvedValue('{"client_id":"plaintext"}');

    const result = await loadCredentialBlob('demo');
    expect(result).toBeNull();
  });
});

describe('saveCredentialBlob (darwin)', () => {
  beforeEach(() => {
    setPlatform('darwin');
    // Swift helper returns success, so the security CLI fallback does not run.
    childProcess.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' });
  });

  it('default profile writes to legacy account for backwards compatibility', async () => {
    await saveCredentialBlob('{"x":1}', 'default');

    // Swift script body embeds the account name; inspect the written file.
    const writeCall = fsSync.default.writeFileSync.mock.calls[0];
    expect(writeCall).toBeDefined();
    const scriptBody = writeCall[1] as string;
    expect(scriptBody).toContain('let account = "default"');
    expect(scriptBody).not.toContain('let account = "profile:default"');
  });

  it('non-default profile writes to profile:<name> account', async () => {
    await saveCredentialBlob('{"x":1}', 'demo');

    const scriptBody = fsSync.default.writeFileSync.mock.calls[0][1] as string;
    expect(scriptBody).toContain('let account = "profile:demo"');
  });

  it('sanitizes mixed-case profile names to lowercase in the keychain account', async () => {
    await saveCredentialBlob('{"x":1}', 'Demo');

    // Account name is case-preserving in the profile index but lowercased for
    // filesystem/keychain-account keys.
    const scriptBody = fsSync.default.writeFileSync.mock.calls[0][1] as string;
    expect(scriptBody).toContain('let account = "profile:demo"');
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

  it('writes to account=default for the default profile', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await saveCredentialBlob('{"x":1}', 'default');

    const storeCall = childProcess.execFileSync.mock.calls.find(
      ([cmd, args]) => cmd === 'secret-tool' && (args as string[]).includes('store'),
    );
    expect(storeCall).toBeDefined();
    const args = storeCall![1] as string[];
    const accountIdx = args.indexOf('account');
    expect(args[accountIdx + 1]).toBe('default');
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

  it('reads legacy credentials.dpapi for default profile', async () => {
    childProcess.execFileSync.mockReturnValue('');
    await loadCredentialBlob('default');

    const commands = childProcess.execFileSync.mock.calls
      .filter(([cmd]) => cmd === 'powershell')
      .map((call) => (call[1] as string[]).join(' '));

    expect(commands.some((s) => s.includes('credentials.default.dpapi'))).toBe(true);
    expect(commands.some((s) => /credentials\.dpapi(?![.a-z])/.test(s))).toBe(true);
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
