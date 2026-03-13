import { describe, it, expect, vi, afterEach } from 'vitest';

const credentialStore = vi.hoisted(() => ({
  loadCredentialBlob: vi.fn(),
  saveCredentialBlob: vi.fn(),
}));

vi.mock('../src/credentials-store.js', () => credentialStore);

import {
  loadCredentials,
  saveCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  getTokenViaClientCredentials,
  getValidToken,
  fetchTenantId,
  buildAuthorizationUrl,
  escapeHtml,
  type FortnoxCredentials,
} from '../src/auth.js';

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
  afterEach(() => {
    vi.restoreAllMocks();
    credentialStore.loadCredentialBlob.mockReset();
    credentialStore.saveCredentialBlob.mockReset();
  });

  describe('loadCredentials', () => {
    it('returns null when no credentials are stored', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(null);
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    it('returns parsed credentials from secure storage', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(JSON.stringify(mockCredentials));
      const creds = await loadCredentials();
      expect(creds).toEqual(mockCredentials);
    });

    it('returns credentials with tenant_id when present', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(
        JSON.stringify(mockCredentialsWithTenant),
      );
      const creds = await loadCredentials();
      expect(creds?.tenant_id).toBe('12345');
    });
  });

  describe('saveCredentials', () => {
    it('writes credentials to secure storage', async () => {
      await saveCredentials(mockCredentials);

      expect(credentialStore.saveCredentialBlob).toHaveBeenCalledWith(
        JSON.stringify(mockCredentials),
      );
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
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(null);
      await expect(getValidToken()).rejects.toThrow('Not authenticated');
    });

    it('returns existing token when not expired', async () => {
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(JSON.stringify(mockCredentials));
      const token = await getValidToken();
      expect(token).toBe('test-access-token');
    });

    it('uses client credentials when tenant_id is available and token expired', async () => {
      const expiring = { ...mockCredentialsWithTenant, expires_at: Date.now() + 60 * 1000 };
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(JSON.stringify(expiring));

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
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(JSON.stringify(expiring));

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
      credentialStore.loadCredentialBlob.mockResolvedValueOnce(JSON.stringify(expiringSoon));

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
