import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadCredentialBlob, saveCredentialBlob } from './credentials-store.js';

const FORTNOX_AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth';
const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
const CALLBACK_HOST = '127.0.0.1';

const SCOPES = 'customer invoice bookkeeping companyinformation settings';

export interface FortnoxCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tenant_id?: string;
}

export interface FortnoxAppConfig {
  clientId: string;
  clientSecret: string;
  serviceAccount?: boolean;
}

export async function loadCredentials(): Promise<FortnoxCredentials | null> {
  try {
    const data = await loadCredentialBlob();
    if (!data) return null;
    return JSON.parse(data) as FortnoxCredentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: FortnoxCredentials): Promise<void> {
  await saveCredentialBlob(JSON.stringify(creds, null, 2));
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  config: FortnoxAppConfig,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(FORTNOX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

export async function getTokenViaClientCredentials(
  creds: FortnoxCredentials,
): Promise<FortnoxCredentials> {
  if (!creds.tenant_id) {
    throw new Error('No tenant_id available — cannot use client credentials flow');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: SCOPES,
  });

  const response = await fetch(FORTNOX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64'),
      TenantId: creds.tenant_id,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Client credentials token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  const updated: FortnoxCredentials = {
    ...creds,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  await saveCredentials(updated);
  return updated;
}

export async function refreshAccessToken(creds: FortnoxCredentials): Promise<FortnoxCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });

  const response = await fetch(FORTNOX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64'),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: FortnoxCredentials = {
    ...creds,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  await saveCredentials(updated);
  return updated;
}

export async function getValidToken(): Promise<string> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `noxctl setup` to connect your Fortnox account.');
  }

  // Token still valid — use it
  if (Date.now() <= creds.expires_at - 5 * 60 * 1000) {
    return creds.access_token;
  }

  // Prefer client credentials when tenant_id is available (no refresh token management needed)
  if (creds.tenant_id) {
    try {
      const refreshed = await getTokenViaClientCredentials(creds);
      return refreshed.access_token;
    } catch {
      // Fall through to refresh_token flow
    }
  }

  // Fallback: standard refresh token flow
  const refreshed = await refreshAccessToken(creds);
  return refreshed.access_token;
}

export async function fetchTenantId(accessToken: string): Promise<string | undefined> {
  const response = await fetch('https://api.fortnox.se/3/companyinformation', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) return undefined;

  const data = (await response.json()) as {
    CompanyInformation?: { DatabaseNumber?: string };
  };

  return data.CompanyInformation?.DatabaseNumber;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [url]);
    } else if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', url]);
    } else {
      execFileSync('xdg-open', [url]);
    }
  } catch {
    console.log(`\nOpen this URL in your browser:\n${url}\n`);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildAuthorizationUrl(
  config: FortnoxAppConfig,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    response_type: 'code',
    access_type: 'offline',
  });

  if (config.serviceAccount) {
    params.set('account_type', 'service');
  }

  return `${FORTNOX_AUTH_URL}?${params.toString()}`;
}

export async function runOAuthSetup(config: FortnoxAppConfig): Promise<void> {
  const PORT = 9876;
  const REDIRECT_URI = `http://localhost:${PORT}/callback`;
  const oauthState = randomBytes(24).toString('hex');

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Autentisering misslyckades</h1><p>${escapeHtml(error)}</p>`);
          server.close();
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (state !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Ogiltig OAuth-state</h1><p>Försök igen från noxctl setup.</p>');
          server.close();
          finish(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Ingen auktoriseringskod mottagen</h1>');
          server.close();
          finish(new Error('No authorization code received'));
          return;
        }

        try {
          const tokens = await exchangeCodeForTokens(code, REDIRECT_URI, config);

          // Fetch tenant_id for client credentials flow
          console.log('Fetching tenant ID...');
          const tenantId = await fetchTenantId(tokens.access_token);

          const creds: FortnoxCredentials = {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
            tenant_id: tenantId,
          };

          await saveCredentials(creds);

          const tenantMsg = tenantId
            ? ' Client credentials flow enabled.'
            : ' (Tenant ID not found — using refresh token flow.)';

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>Klart!</h1><p>Fortnox MCP är nu kopplat till ditt konto. Du kan stänga den här fliken.</p>',
          );

          console.log(`\nSetup complete! Credentials saved.${tenantMsg}\n`);
          console.log('Register in Claude Code with:');
          console.log('  claude mcp add fortnox -- noxctl serve\n');
          finish();
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          const message = err instanceof Error ? err.message : String(err);
          res.end(`<h1>Något gick fel</h1><p>${escapeHtml(message)}</p>`);
          finish(err instanceof Error ? err : new Error(message));
        } finally {
          server.close();
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(PORT, CALLBACK_HOST, () => {
      const authUrl = buildAuthorizationUrl(config, REDIRECT_URI, oauthState);
      console.log('Opening Fortnox login in your browser...');
      openBrowser(authUrl);
      console.log(`\nWaiting for authentication on http://${CALLBACK_HOST}:${PORT}...`);
    });

    server.on('error', (err) => {
      finish(new Error(`Could not start callback server: ${err.message}`));
    });
  });
}
