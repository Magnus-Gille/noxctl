import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('MCP startup profile binding', () => {
  let tmpHome: string;
  let cfgDir: string;
  let activePointerFile: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origProfileEnv: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-mcp-profile-'));
    cfgDir = path.join(tmpHome, '.fortnox-mcp');
    activePointerFile = path.join(cfgDir, 'active-profile');

    origHome = process.env['HOME'];
    origUserProfile = process.env['USERPROFILE'];
    origProfileEnv = process.env['NOXCTL_PROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    delete process.env['NOXCTL_PROFILE'];
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    if (origUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = origUserProfile;
    if (origProfileEnv === undefined) delete process.env['NOXCTL_PROFILE'];
    else process.env['NOXCTL_PROFILE'] = origProfileEnv;

    await fs.rm(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('resolveStartupProfile', () => {
    it('returns default when no env or pointer is set', async () => {
      const { resolveStartupProfile } = await import('../src/index.js');
      await expect(resolveStartupProfile()).resolves.toBe('default');
    });

    it('prefers NOXCTL_PROFILE over pointer', async () => {
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(activePointerFile, 'pointed\n');
      process.env['NOXCTL_PROFILE'] = 'envwin';
      const { resolveStartupProfile } = await import('../src/index.js');
      await expect(resolveStartupProfile()).resolves.toBe('envwin');
    });

    it('falls back to pointer when env is unset', async () => {
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(activePointerFile, 'pointed\n');
      const { resolveStartupProfile } = await import('../src/index.js');
      await expect(resolveStartupProfile()).resolves.toBe('pointed');
    });

    it('falls back to default when pointer contains an invalid name', async () => {
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(activePointerFile, 'has space\n');
      const { resolveStartupProfile } = await import('../src/index.js');
      await expect(resolveStartupProfile()).resolves.toBe('default');
    });

    it('falls back to default when NOXCTL_PROFILE is invalid', async () => {
      process.env['NOXCTL_PROFILE'] = 'bad name!';
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { resolveStartupProfile } = await import('../src/index.js');
      await expect(resolveStartupProfile()).resolves.toBe('default');
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe('bindStartupProfile', () => {
    it('binds the provided profile via setResolvedProfile', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { bindStartupProfile } = await import('../src/index.js');
      const { getResolvedProfile } = await import('../src/auth.js');

      const profile = await bindStartupProfile({ profile: 'bound' });
      expect(profile).toBe('bound');
      expect(getResolvedProfile()).toBe('bound');
    });

    it('writes a stderr banner when profile is non-default', async () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      const { bindStartupProfile } = await import('../src/index.js');
      await bindStartupProfile({ profile: 'staging' });

      expect(writes.some((w) => w.includes('[profile: staging]'))).toBe(true);
    });

    it('does not write a banner for the default profile', async () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      const { bindStartupProfile } = await import('../src/index.js');
      await bindStartupProfile({ profile: 'default' });

      expect(writes.some((w) => w.includes('[profile:'))).toBe(false);
    });

    it('resolves from env/pointer when no profile option is given', async () => {
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(activePointerFile, 'pointed\n');
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const { bindStartupProfile } = await import('../src/index.js');
      const { getResolvedProfile } = await import('../src/auth.js');

      const profile = await bindStartupProfile();
      expect(profile).toBe('pointed');
      expect(getResolvedProfile()).toBe('pointed');
    });
  });
});
