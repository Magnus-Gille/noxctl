import { describe, it, expect, vi, afterEach } from 'vitest';

const credentialStore = vi.hoisted(() => ({
  loadCredentialBlob: vi.fn(),
  saveCredentialBlob: vi.fn(),
  CredentialStoreAccessError: class CredentialStoreAccessError extends Error {},
}));
const profilesModule = vi.hoisted(() => ({
  upsertProfile: vi.fn(),
  migrateLegacyIfNeeded: vi.fn(),
  readProfileIndex: vi.fn(),
}));
const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('../src/credentials-store.js', () => credentialStore);
vi.mock('../src/profiles.js', () => profilesModule);
vi.mock('node:child_process', () => childProcess);

import { runOAuthSetup, invalidScopeGuidance, SCOPES, ARCHIVE_SCOPE } from '../src/auth.js';

const SECRET = 'super-secret-value-xyz';
const config = { clientId: 'client-abc', clientSecret: SECRET };

async function callbackFor(query: string): Promise<void> {
  // Retry until the callback server is listening.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://localhost:9876/callback?${query}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error('callback server never came up');
}

describe('invalid_scope guidance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists scopes and portal checks without secrets or URLs', () => {
    const text = invalidScopeGuidance(`${SCOPES} ${ARCHIVE_SCOPE}`);
    for (const s of `${SCOPES} ${ARCHIVE_SCOPE}`.split(' ')) expect(text).toContain(s);
    expect(text).toMatch(/Client ID/);
    expect(text).toMatch(/redirect/i);
    expect(text).toContain('http://localhost:9876/callback');
    expect(text).not.toMatch(/https?:\/\/apps\.fortnox/);
  });

  it('prints guidance on an invalid_scope callback and preserves credentials', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.join(' '));
      });
    }
    const scopes = `${SCOPES} ${ARCHIVE_SCOPE}`;
    const p = runOAuthSetup(config, 'default', scopes);
    const rejected = expect(p).rejects.toThrow(/invalid_scope/);
    // Wait for the pre-existing startup lines (manual-fallback URL) so that
    // only output emitted in response to the error callback is inspected.
    for (let i = 0; i < 50 && !logs.some((l) => l.includes('Waiting for authentication')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const startupCount = logs.length;
    const authUrl = logs.join('\n').match(/https:\/\/\S+/)?.[0];
    expect(authUrl).toBeDefined();
    const generatedState = new URL(authUrl!).searchParams.get('state');
    expect(generatedState).toBeTruthy();

    await callbackFor('error=invalid_scope&error_description=unsupported&state=STATE123');
    await rejected;

    const guidance = logs.slice(startupCount).join('\n');
    expect(guidance.length).toBeGreaterThan(0);
    expect(guidance).not.toContain(generatedState!);
    expect(guidance).not.toContain(authUrl!);
    expect(guidance).not.toMatch(/https:\/\//);
    expect(guidance).toContain('archive');
    expect(guidance).toContain('costcenter');
    expect(guidance).not.toContain(SECRET);
    expect(guidance).not.toContain('STATE123');
    expect(guidance).not.toMatch(/client_id=/);
    expect(credentialStore.saveCredentialBlob).not.toHaveBeenCalled();
    expect(profilesModule.upsertProfile).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1); // no retry
  });

  it('prints no scope guidance for other errors', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const p = runOAuthSetup(config, 'default', SCOPES);
    const rejected = expect(p).rejects.toThrow(/access_denied/);
    await callbackFor('error=access_denied');
    await rejected;
    expect(logs.join('\n')).not.toMatch(/Client ID/);
  });
});
