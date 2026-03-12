import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidToken,
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

    it('refreshes token when about to expire', async () => {
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
