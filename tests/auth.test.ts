import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const credentialStore = vi.hoisted(() => ({
  loadCredentialBlob: vi.fn(),
  saveCredentialBlob: vi.fn(),
}));

const profilesModule = vi.hoisted(() => ({
  upsertProfile: vi.fn(),
  migrateLegacyIfNeeded: vi.fn(),
  readProfileIndex: vi.fn(),
}));

vi.mock('../src/credentials-store.js', () => credentialStore);
vi.mock('../src/profiles.js', () => profilesModule);

import {
  loadCredentials,
  saveCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  getTokenViaClientCredentials,
  getValidToken,
  fetchTenantId,
  fetchCompanyNameSafe,
  buildAuthorizationUrl,
  escapeHtml,
  setResolvedProfile,
  getResolvedProfile,
  CREDENTIAL_SCHEMA_VERSION,
  __resetLegacyObservedForDefault,
  type FortnoxCredentials,
} from '../src/auth.js';

function blobResult(
  blob: string | null,
  source:
    | 'new'
    | 'legacy'
    | 'both-new-preferred'
    | 'both-legacy-preferred'
    | 'legacy-plaintext'
    | null = blob ? 'new' : null,
  legacyBlob: string | null = source === 'legacy' || source === 'legacy-plaintext' ? blob : null,
) {
  return { blob, source, legacyBlob };
}

const mockCredentials: FortnoxCredentials = {
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: Date.now() + 3600 * 1000,
};

const mockCredentialsWithTenant: FortnoxCredentials = {
  ...mockCredentials,
  tenant_id: '12345',
};

describe('auth', () => {
  beforeEach(() => {
    setResolvedProfile('default');
    __resetLegacyObservedForDefault();
    profilesModule.readProfileIndex.mockResolvedValue({ schema_version: 1, profiles: [] });
    profilesModule.migrateLegacyIfNeeded.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    credentialStore.loadCredentialBlob.mockReset();
    credentialStore.saveCredentialBlob.mockReset();
    profilesModule.upsertProfile.mockReset();
    profilesModule.migrateLegacyIfNeeded.mockReset();
    profilesModule.readProfileIndex.mockReset();
    setResolvedProfile('default');
    __resetLegacyObservedForDefault();
  });

  describe('loadCredentials', () => {
    it('returns null when no credentials are stored', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(blobResult(null));
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    it('returns parsed credentials from secure storage', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      const creds = await loadCredentials();
      expect(creds).toEqual(mockCredentials);
    });

    it('returns credentials with tenant_id when present', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentialsWithTenant)),
      );
      const creds = await loadCredentials();
      expect(creds?.tenant_id).toBe('12345');
    });

    it('invokes migrateLegacyIfNeeded when legacy slot is observed for default', async () => {
      const blob = JSON.stringify(mockCredentials);
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(blobResult(blob, 'legacy'));
      await loadCredentials();
      expect(profilesModule.migrateLegacyIfNeeded).toHaveBeenCalledWith(blob);
    });

    it('seeds migration from the legacy blob, not the selected new blob, on drift', async () => {
      const newBlob = JSON.stringify({ ...mockCredentials, tenant_id: undefined });
      const legacyBlob = JSON.stringify({ ...mockCredentials, tenant_id: '12345' });
      credentialStore.loadCredentialBlob.mockResolvedValueOnce({
        blob: newBlob,
        source: 'both-new-preferred',
        legacyBlob,
      });
      await loadCredentials();
      expect(profilesModule.migrateLegacyIfNeeded).toHaveBeenCalledWith(legacyBlob);
    });

    it('does not invoke migrateLegacyIfNeeded when only the new slot exists', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials), 'new'),
      );
      await loadCredentials();
      expect(profilesModule.migrateLegacyIfNeeded).not.toHaveBeenCalled();
    });

    it('does not invoke migrateLegacyIfNeeded for non-default profiles', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials), 'new'),
      );
      await loadCredentials('demo');
      expect(profilesModule.migrateLegacyIfNeeded).not.toHaveBeenCalled();
    });
  });

  describe('saveCredentials', () => {
    it('stamps schema_version and last_write_epoch', async () => {
      const before = Date.now();
      await saveCredentials(mockCredentials);
      const after = Date.now();

      expect(credentialStore.saveCredentialBlob).toHaveBeenCalledTimes(1);
      const [payload, profile] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      const parsed = JSON.parse(payload as string) as FortnoxCredentials;
      expect(parsed.schema_version).toBe(CREDENTIAL_SCHEMA_VERSION);
      expect(parsed.last_write_epoch).toBeGreaterThanOrEqual(before);
      expect(parsed.last_write_epoch).toBeLessThanOrEqual(after);
      expect(parsed.access_token).toBe(mockCredentials.access_token);
      expect(profile).toBe('default');
    });

    it('threads an explicit profile through to the store', async () => {
      await saveCredentials(mockCredentials, 'demo');
      const [, profile] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect(profile).toBe('demo');
    });

    it('uses the resolved profile when no profile argument is given', async () => {
      setResolvedProfile('work');
      await saveCredentials(mockCredentials);
      const [, profile] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect(profile).toBe('work');
    });

    it('does not set alsoWriteLegacy for fresh default-profile installs', async () => {
      await saveCredentials(mockCredentials);
      const [, , options] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect((options as { alsoWriteLegacy?: boolean } | undefined)?.alsoWriteLegacy).toBeFalsy();
    });

    it('sets alsoWriteLegacy=true for default after a legacy slot was observed', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials), 'legacy'),
      );
      await loadCredentials();
      await saveCredentials(mockCredentials);

      const [, , options] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect((options as { alsoWriteLegacy?: boolean }).alsoWriteLegacy).toBe(true);
    });

    it('never sets alsoWriteLegacy for non-default profiles', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials), 'legacy'),
      );
      await loadCredentials(); // observes legacy for default
      await saveCredentials(mockCredentials, 'demo');

      const [, profile, options] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect(profile).toBe('demo');
      expect((options as { alsoWriteLegacy?: boolean }).alsoWriteLegacy).toBe(false);
    });

    it('sets alsoWriteLegacy after observing both-new-preferred', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials), 'both-new-preferred'),
      );
      await loadCredentials();
      await saveCredentials(mockCredentials);

      const [, , options] = credentialStore.saveCredentialBlob.mock.calls[0]!;
      expect((options as { alsoWriteLegacy?: boolean }).alsoWriteLegacy).toBe(true);
    });
  });

  describe('profile resolution', () => {
    it('defaults to "default"', () => {
      expect(getResolvedProfile()).toBe('default');
    });

    it('setResolvedProfile rejects invalid names', () => {
      expect(() => setResolvedProfile('not valid')).toThrow();
      expect(getResolvedProfile()).toBe('default');
    });

    it('setResolvedProfile updates the module state', () => {
      setResolvedProfile('demo');
      expect(getResolvedProfile()).toBe('demo');
    });
  });

  describe('loadCredentials with profile', () => {
    it('threads explicit profile through to the store', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      await loadCredentials('demo');
      expect(credentialStore.loadCredentialBlob).toHaveBeenCalledWith('demo');
    });

    it('falls back to the resolved profile when no argument is given', async () => {
      setResolvedProfile('work');
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      await loadCredentials();
      expect(credentialStore.loadCredentialBlob).toHaveBeenCalledWith('work');
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('exchanges authorization code for tokens', async () => {
      const mockResponse = {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await exchangeCodeForTokens('auth-code', 'http://localhost:9876/callback', {
        clientId: 'cid',
        clientSecret: 'csecret',
      });

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://apps.fortnox.se/oauth-v1/token',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws on failed token exchange', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(
        exchangeCodeForTokens('bad-code', 'http://localhost:9876/callback', {
          clientId: 'cid',
          clientSecret: 'csecret',
        }),
      ).rejects.toThrow('Token exchange failed (400)');
    });
  });

  describe('getTokenViaClientCredentials', () => {
    it('gets token using client credentials and tenant_id', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'cc-access-token',
            expires_in: 3600,
          }),
      });

      const result = await getTokenViaClientCredentials(mockCredentialsWithTenant);
      expect(result.access_token).toBe('cc-access-token');
      expect(result.tenant_id).toBe('12345');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://apps.fortnox.se/oauth-v1/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            TenantId: '12345',
          }),
        }),
      );
    });

    it('throws when no tenant_id is available', async () => {
      await expect(getTokenViaClientCredentials(mockCredentials)).rejects.toThrow(
        'No tenant_id available',
      );
    });

    it('throws on failed client credentials request', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await expect(getTokenViaClientCredentials(mockCredentialsWithTenant)).rejects.toThrow(
        'Client credentials token request failed (403)',
      );
    });
  });

  describe('refreshAccessToken', () => {
    it('refreshes and saves new credentials', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'refreshed-access',
            refresh_token: 'refreshed-refresh',
            expires_in: 3600,
          }),
      });

      const result = await refreshAccessToken(mockCredentials);
      expect(result.access_token).toBe('refreshed-access');
      expect(result.refresh_token).toBe('refreshed-refresh');
      expect(credentialStore.saveCredentialBlob).toHaveBeenCalled();
    });

    it('throws on failed refresh', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(refreshAccessToken(mockCredentials)).rejects.toThrow(
        'Token refresh failed (401)',
      );
    });
  });

  describe('fetchTenantId', () => {
    it('returns DatabaseNumber from company info', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            CompanyInformation: { DatabaseNumber: '98765' },
          }),
      });

      const tenantId = await fetchTenantId('some-token');
      expect(tenantId).toBe('98765');
    });

    it('returns undefined on API error', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      const tenantId = await fetchTenantId('bad-token');
      expect(tenantId).toBeUndefined();
    });

    it('returns undefined when DatabaseNumber is missing', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ CompanyInformation: {} }),
      });

      const tenantId = await fetchTenantId('some-token');
      expect(tenantId).toBeUndefined();
    });
  });

  describe('getValidToken', () => {
    it('throws when not authenticated', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(blobResult(null));
      await expect(getValidToken()).rejects.toThrow('Not authenticated');
    });

    it('tags the not-authenticated error with profile when non-default', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(blobResult(null));
      await expect(getValidToken('staging')).rejects.toThrow(
        /\[profile: staging\].*noxctl init --profile staging/,
      );
    });

    it('omits the profile tag for the default profile', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(blobResult(null));
      try {
        await getValidToken();
        expect.unreachable();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('[profile:');
        expect(message).toContain('noxctl init');
      }
    });

    it('returns existing token when not expired', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      const token = await getValidToken();
      expect(token).toBe('test-access-token');
    });

    it('uses client credentials when tenant_id is available and token expired', async () => {
      const expiring = { ...mockCredentialsWithTenant, expires_at: Date.now() + 60 * 1000 };
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(expiring)),
      );

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'cc-fresh-token',
            expires_in: 3600,
          }),
      });

      const token = await getValidToken();
      expect(token).toBe('cc-fresh-token');
    });

    it('falls back to refresh token when client credentials fails', async () => {
      const expiring = { ...mockCredentialsWithTenant, expires_at: Date.now() + 60 * 1000 };
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(expiring)),
      );

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: () => Promise.resolve('Forbidden'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'refresh-fallback-token',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
        });

      const token = await getValidToken();
      expect(token).toBe('refresh-fallback-token');
    });

    it('refreshes token when about to expire (no tenant_id)', async () => {
      const expiringSoon = { ...mockCredentials, expires_at: Date.now() + 60 * 1000 };
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(expiringSoon)),
      );

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'fresh-token',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
          }),
      });

      const token = await getValidToken();
      expect(token).toBe('fresh-token');
    });

    it('reads credentials under the explicit profile', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      await getValidToken('demo');
      expect(credentialStore.loadCredentialBlob).toHaveBeenCalledWith('demo');
    });

    it('reads credentials under the resolved profile when no arg', async () => {
      setResolvedProfile('work');
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        blobResult(JSON.stringify(mockCredentials)),
      );
      await getValidToken();
      expect(credentialStore.loadCredentialBlob).toHaveBeenCalledWith('work');
    });
  });

  describe('fetchCompanyNameSafe', () => {
    it('returns CompanyName when present', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ CompanyInformation: { CompanyName: 'Acme AB' } }),
      });
      await expect(fetchCompanyNameSafe('tok')).resolves.toBe('Acme AB');
    });

    it('returns undefined on non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(fetchCompanyNameSafe('tok')).resolves.toBeUndefined();
    });

    it('swallows thrown errors', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('network down'));
      await expect(fetchCompanyNameSafe('tok')).resolves.toBeUndefined();
    });
  });

  describe('buildAuthorizationUrl', () => {
    it('includes a caller-supplied state token', () => {
      const url = new URL(
        buildAuthorizationUrl(
          { clientId: 'cid', clientSecret: 'secret' },
          'http://localhost:9876/callback',
          'csrf-token',
        ),
      );

      expect(url.searchParams.get('state')).toBe('csrf-token');
    });

    it('adds service account mode when requested', () => {
      const url = new URL(
        buildAuthorizationUrl(
          { clientId: 'cid', clientSecret: 'secret', serviceAccount: true },
          'http://localhost:9876/callback',
          'csrf-token',
        ),
      );

      expect(url.searchParams.get('account_type')).toBe('service');
    });
  });

  describe('escapeHtml', () => {
    it('escapes attacker-controlled HTML in callback responses', () => {
      expect(escapeHtml('<script>alert("x")</script>')).toBe(
        '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
      );
    });
  });
});
