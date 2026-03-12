import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  getTokenViaClientCredentials,
  getValidToken,
  fetchTenantId,
  type FortnoxCredentials,
} from '../src/auth.js';

const TEST_CREDS_DIR = path.join(process.env.HOME || '~', '.fortnox-mcp');
const TEST_CREDS_FILE = path.join(TEST_CREDS_DIR, 'credentials.json');

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
  describe('loadCredentials', () => {
    it('returns null when no credentials file exists', async () => {
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    it('returns parsed credentials when file exists', async () => {
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(mockCredentials));
      const creds = await loadCredentials();
      expect(creds).toEqual(mockCredentials);
    });

    it('returns credentials with tenant_id when present', async () => {
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(mockCredentialsWithTenant));
      const creds = await loadCredentials();
      expect(creds?.tenant_id).toBe('12345');
    });
  });

  describe('saveCredentials', () => {
    it('creates directory and writes file with restricted permissions', async () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValueOnce(undefined);
      const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValueOnce(undefined);

      await saveCredentials(mockCredentials);

      expect(mkdirSpy).toHaveBeenCalledWith(TEST_CREDS_DIR, { recursive: true });
      expect(writeSpy).toHaveBeenCalledWith(
        TEST_CREDS_FILE,
        JSON.stringify(mockCredentials, null, 2),
        { mode: 0o600 },
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
    beforeEach(() => {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    });

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

      // Verify TenantId header was sent
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
    beforeEach(() => {
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    });

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
      vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
      await expect(getValidToken()).rejects.toThrow('Not authenticated');
    });

    it('returns existing token when not expired', async () => {
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(mockCredentials));
      const token = await getValidToken();
      expect(token).toBe('test-access-token');
    });

    it('uses client credentials when tenant_id is available and token expired', async () => {
      const expiring = { ...mockCredentialsWithTenant, expires_at: Date.now() + 60 * 1000 };
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(expiring));
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

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
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(expiring));
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

      global.fetch = vi
        .fn()
        // First call: client credentials fails
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: () => Promise.resolve('Forbidden'),
        })
        // Second call: refresh token succeeds
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
      vi.spyOn(fs, 'readFile').mockResolvedValueOnce(JSON.stringify(expiringSoon));
      vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

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

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
