import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  CredentialStoreAccessError,
  loadCredentialBlob,
  saveCredentialBlob,
  type LoadSource,
} from './credentials-store.js';
import { KeychainLockedError } from './keychain-target.js';
import { DEFAULT_PROFILE, validateProfileName } from './profile-name.js';
import {
  migrateLegacyIfNeeded,
  readProfileIndex,
  upsertProfile,
  type ProfileSource,
} from './profiles.js';

const FORTNOX_AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth';
const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
const CALLBACK_HOST = '127.0.0.1';
const AUTH_REQUEST_TIMEOUT_MS = 30_000;

function authFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  });
}

// Every endpoint family noxctl implements must appear here or in one of the
// opt-in sets below: Fortnox only grants what the authorize request asks for, so
// a missing token means `403 Har inte behörighet för scope` at call time even
// when the app has the permission enabled (#95). `payment`, `project`,
// `costcenter` and `price` are scopes of their own — they are not covered by
// `invoice`. Every scope here is satisfied by the Bokföring, Kundfaktura or
// Order licences the pre-existing defaults already required, so adding them
// cannot make authorization impossible for a company that could authorize before.
export const SCOPES =
  'article customer invoice payment supplier supplierinvoice bookkeeping companyinformation settings project costcenter price inbox connectfile';

// Offers and orders. Opt-in for the same reason as salary: Fortnox's scope table
// requires the *Order* licence for both, which a Bokföring + Kundfaktura company
// does not have — requesting them unconditionally would make `noxctl init`
// impossible for those companies rather than merely degrading two features.
// `noxctl init --with-orders` (or FORTNOX_WITH_ORDERS=1) appends them.
export const ORDER_SCOPES = 'offer order';

// The scope set as it stood before offers/orders/projects/cost centers/prices
// were added — i.e. what noxctl 0.3.0–0.6.1 requested. Credentials written before
// the `scopes` field existed (pre-0.4.0) recorded no scope string, and renewing
// those against the current SCOPES would silently ask for scopes their Fortnox app
// was never granted. A rejected client-credentials renewal falls back to the
// refresh token, which service-account installs do not rotate and which Fortnox
// expires after 45 days — so widening the fallback can break an untouched
// installation. Never change this constant; it records history, not intent.
//
// Known gap: 0.2.0 predates `inbox`/`connectfile` too, so a credential that old is
// still widened by those two. That is unchanged behaviour — it has been true since
// 0.3.0 shipped — and is not worth a speculative rejection-and-retry path; such an
// installation should re-run `noxctl init`.
export const LEGACY_SCOPES =
  'article customer invoice payment supplier supplierinvoice bookkeeping companyinformation settings inbox connectfile';

// The "Lön" (salary/payroll) scope. Opt-in only: requesting it at authorize
// time fails for users whose Fortnox app integration does not have the Lön
// permission enabled, so it is never part of the default SCOPES. `noxctl init
// --with-salary` (or FORTNOX_WITH_SALARY=1) appends it and the granted scope
// string is persisted per-profile (see FortnoxCredentials.scopes) so the
// client-credentials refresh re-requests the same set.
export const SALARY_SCOPE = 'salary';

/**
 * Effective scope string for a profile: the granted set if recorded, else the
 * frozen LEGACY_SCOPES — what a credential predating the `scopes` field was
 * actually consented to. Re-running `noxctl init` records the current set.
 */
export function effectiveScopes(
  creds: Pick<FortnoxCredentials, 'scopes'> | null | undefined,
): string {
  return creds?.scopes ?? LEGACY_SCOPES;
}

export const CREDENTIAL_SCHEMA_VERSION = 2;

export interface FortnoxCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tenant_id?: string;
  company_name?: string;
  // The OAuth scope string granted at authorization time. Optional for
  // backward compatibility: credentials written before this field existed fall
  // back to LEGACY_SCOPES, not the current set. Recorded so the
  // client-credentials refresh re-requests exactly what was granted (e.g. the
  // opt-in `salary` scope).
  scopes?: string;
  schema_version?: number;
  last_write_epoch?: number;
}

export interface FortnoxAppConfig {
  clientId: string;
  clientSecret: string;
  serviceAccount?: boolean;
}

// Module-global resolved profile. This assumes a single-tenant process model
// (one CLI invocation or one MCP stdio connection per Node process). Hosting
// multiple Fortnox MCP servers in the same process is not supported — every
// instance would share this state. Revisit if the MCP SDK grows request-local
// context that handlers can read.
let resolvedProfile: string = DEFAULT_PROFILE;
let resolvedProfileSource: ProfileSource = 'default';

// Token endpoints may rotate refresh tokens, so concurrent requests for the
// same profile must share one refresh and one credential-store write. Profile
// names are case-insensitive throughout the storage layer.
const tokenRefreshes = new Map<string, Promise<string>>();

// Whether the legacy (pre-0.2) credential slot was observed on the most recent
// successful load of the default profile. Set only by loadCredentials; read by
// saveCredentials to decide whether to dual-write during the 0.2.x window.
let legacyObservedForDefault = false;

export function setResolvedProfile(name: string, source: ProfileSource = 'default'): void {
  resolvedProfile = validateProfileName(name);
  resolvedProfileSource = source;
}

export function getResolvedProfile(): string {
  return resolvedProfile;
}

export function getResolvedProfileSource(): ProfileSource {
  return resolvedProfileSource;
}

// Test-only: reset module-level observation state between cases.
export function __resetLegacyObservedForDefault(): void {
  legacyObservedForDefault = false;
}

function profileOrResolved(profile?: string): string {
  return profile ?? resolvedProfile;
}

function sourceForProfile(profile: string): ProfileSource | 'explicit' {
  return profile.toLowerCase() === resolvedProfile.toLowerCase()
    ? resolvedProfileSource
    : 'explicit';
}

function credentialContext(profile: string): string {
  return `profile "${profile}" (source: ${sourceForProfile(profile)})`;
}

function inaccessibleRecovery(profile: string): string {
  return (
    `Run \`noxctl keychain status\` and, if needed, \`noxctl keychain unlock\` in an ` +
    `unsandboxed terminal, then retry with \`--profile ${profile}\`. An already-running MCP ` +
    `server remains pinned to the profile selected at startup; changing the active profile ` +
    `pointer will not retarget it, so restart that MCP process after correcting the profile.`
  );
}

export type CredentialState = 'available' | 'missing' | 'locked' | 'inaccessible';

export interface CredentialInspection {
  state: CredentialState;
  profile: string;
  source: ProfileSource | 'explicit';
  credentials: FortnoxCredentials | null;
  detail: string;
}

export class CredentialAccessError extends Error {
  constructor(
    public readonly profile: string,
    public readonly source: ProfileSource | 'explicit',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialAccessError';
  }
}

function isDefaultProfile(name: string): boolean {
  return name.toLowerCase() === DEFAULT_PROFILE;
}

function profileTag(name: string): string {
  return isDefaultProfile(name) ? '' : `[profile: ${name}] `;
}

function legacySlotExists(source: LoadSource): boolean {
  return (
    source === 'legacy' ||
    source === 'both-new-preferred' ||
    source === 'both-legacy-preferred' ||
    source === 'legacy-plaintext'
  );
}

export async function inspectCredentials(profile?: string): Promise<CredentialInspection> {
  const target = profileOrResolved(profile);
  const source = sourceForProfile(target);
  let result: { blob: string | null; source: LoadSource; legacyBlob: string | null };
  try {
    result = await loadCredentialBlob(target);
  } catch (err) {
    if (err instanceof KeychainLockedError) {
      return {
        state: 'locked',
        profile: target,
        source,
        credentials: null,
        detail: `Credential state: locked for ${credentialContext(target)} — ${err.message}`,
      };
    }
    const reason =
      err instanceof CredentialStoreAccessError || err instanceof Error ? err.message : String(err);
    return {
      state: 'inaccessible',
      profile: target,
      source,
      credentials: null,
      detail: `Credential state: inaccessible for ${credentialContext(target)} — ${reason}. ${inaccessibleRecovery(target)}`,
    };
  }

  if (isDefaultProfile(target) && legacySlotExists(result.source)) {
    legacyObservedForDefault = true;
    // Best-effort seeding of the profile index for pre-0.2 installs. Seed from
    // the raw legacy blob — not result.blob, which may be the new slot if
    // pickHigher preferred it and would lose legacy-only metadata on drift.
    // A failure here must not break auth — Chunk D's `doctor` will surface it.
    try {
      await migrateLegacyIfNeeded(result.legacyBlob);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        state: 'inaccessible',
        profile: target,
        source,
        credentials: null,
        detail: `Credential state: inaccessible for ${credentialContext(target)} — legacy profile metadata could not be inspected (${reason}). ${inaccessibleRecovery(target)}`,
      };
    }
  }

  if (!result.blob) {
    let registered = false;
    try {
      const index = await readProfileIndex();
      registered = index.profiles.some(
        (entry) => entry.name.toLowerCase() === target.toLowerCase(),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        state: 'inaccessible',
        profile: target,
        source,
        credentials: null,
        detail: `Credential state: inaccessible for ${credentialContext(target)} — the profile index could not be read (${reason}). ${inaccessibleRecovery(target)}`,
      };
    }
    if (registered) {
      return {
        state: 'inaccessible',
        profile: target,
        source,
        credentials: null,
        detail: `Credential state: inaccessible for ${credentialContext(target)} — the registered profile exists, but credential lookup returned no item in this execution context. ${inaccessibleRecovery(target)}`,
      };
    }
    return {
      state: 'missing',
      profile: target,
      source,
      credentials: null,
      detail: `Credential state: missing for ${credentialContext(target)}. Run ${
        isDefaultProfile(target) ? '`noxctl init`' : `\`noxctl init --profile ${target}\``
      } to connect your Fortnox account.`,
    };
  }
  try {
    return {
      state: 'available',
      profile: target,
      source,
      credentials: JSON.parse(result.blob) as FortnoxCredentials,
      detail: `Credential state: available for ${credentialContext(target)}`,
    };
  } catch {
    return {
      state: 'inaccessible',
      profile: target,
      source,
      credentials: null,
      detail: `Credential state: inaccessible for ${credentialContext(target)} — the stored credential blob could not be parsed. ${inaccessibleRecovery(target)}`,
    };
  }
}

export async function loadCredentials(profile?: string): Promise<FortnoxCredentials | null> {
  const inspected = await inspectCredentials(profile);
  if (inspected.state === 'available') return inspected.credentials;
  if (inspected.state === 'missing') return null;
  if (inspected.state === 'locked') throw new KeychainLockedError(inspected.detail);
  throw new CredentialAccessError(inspected.profile, inspected.source, inspected.detail);
}

export async function saveCredentials(creds: FortnoxCredentials, profile?: string): Promise<void> {
  const target = profileOrResolved(profile);
  const stamped: FortnoxCredentials = {
    ...creds,
    schema_version: CREDENTIAL_SCHEMA_VERSION,
    last_write_epoch: Date.now(),
  };
  await saveCredentialBlob(JSON.stringify(stamped), target, {
    alsoWriteLegacy: isDefaultProfile(target) && legacyObservedForDefault,
  });
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

  const response = await authFetch(FORTNOX_TOKEN_URL, {
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
  profile?: string,
): Promise<FortnoxCredentials> {
  const tag = profileTag(profileOrResolved(profile));
  if (!creds.tenant_id) {
    throw new Error(`${tag}No tenant_id available — cannot use client credentials flow`);
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: effectiveScopes(creds),
  });

  const response = await authFetch(FORTNOX_TOKEN_URL, {
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
    throw new Error(`${tag}Client credentials token request failed (${response.status}): ${text}`);
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

  await saveCredentials(updated, profile);
  return updated;
}

export async function refreshAccessToken(
  creds: FortnoxCredentials,
  profile?: string,
): Promise<FortnoxCredentials> {
  const tag = profileTag(profileOrResolved(profile));
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });

  const response = await authFetch(FORTNOX_TOKEN_URL, {
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
    throw new Error(`${tag}Token refresh failed (${response.status}): ${text}`);
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

  await saveCredentials(updated, profile);
  return updated;
}

export async function getValidToken(profile?: string): Promise<string> {
  const target = profileOrResolved(profile);
  const creds = await loadCredentials(target);
  if (!creds) {
    const initCmd = isDefaultProfile(target)
      ? '`noxctl init`'
      : `\`noxctl init --profile ${target}\``;
    throw new Error(
      `[profile: ${target}, source: ${sourceForProfile(target)}] Not authenticated. Run ${initCmd} to connect your Fortnox account.`,
    );
  }

  // Token still valid — use it
  if (Date.now() <= creds.expires_at - 5 * 60 * 1000) {
    return creds.access_token;
  }

  const refreshKey = target.toLowerCase();
  const existing = tokenRefreshes.get(refreshKey);
  if (existing) return existing;

  const refresh = (async (): Promise<string> => {
    // Prefer client credentials when tenant_id is available (no refresh token
    // rotation). Retain the refresh-token fallback for existing profiles whose
    // service-account setup is unavailable or revoked.
    if (creds.tenant_id) {
      try {
        const refreshed = await getTokenViaClientCredentials(creds, target);
        return refreshed.access_token;
      } catch {
        // Fall through to refresh_token flow
      }
    }

    const refreshed = await refreshAccessToken(creds, target);
    return refreshed.access_token;
  })();

  tokenRefreshes.set(refreshKey, refresh);
  try {
    return await refresh;
  } finally {
    // Do not delete a newer refresh that could have been installed after this
    // one settled (defensive; normal execution never overlaps them).
    if (tokenRefreshes.get(refreshKey) === refresh) tokenRefreshes.delete(refreshKey);
  }
}

export async function fetchTenantId(accessToken: string): Promise<string | undefined> {
  const response = await authFetch('https://api.fortnox.se/3/companyinformation', {
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

export async function fetchCompanyNameSafe(accessToken: string): Promise<string | undefined> {
  try {
    const response = await authFetch('https://api.fortnox.se/3/companyinformation', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      CompanyInformation?: { CompanyName?: string };
    };
    return data.CompanyInformation?.CompanyName;
  } catch {
    return undefined;
  }
}

/**
 * Command that opens `url` in the platform's default browser.
 *
 * Windows deliberately avoids `cmd /c start`: cmd.exe treats every unescaped
 * `&` in the query string as a command separator, so Fortnox received an
 * authorization URL truncated at the first parameter — no redirect_uri, scope,
 * state, response_type or access_type — and rejected it (#95). PowerShell takes
 * the URL as a single quoted argument instead.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] };
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process '${url.replace(/'/g, "''")}'`,
      ],
    };
  }
  return { file: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  const { file, args } = browserOpenCommand(process.platform, url);
  try {
    // stdio is discarded: a failed launcher otherwise scribbles over the
    // manual-copy URL that the caller prints either way.
    execFileSync(file, args, { stdio: 'ignore' });
  } catch {
    // Ignored — the caller always prints the URL for manual copy-paste.
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
  scopes: string = SCOPES,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    response_type: 'code',
    access_type: 'offline',
  });

  if (config.serviceAccount) {
    params.set('account_type', 'service');
  }

  return `${FORTNOX_AUTH_URL}?${params.toString()}`;
}

export async function runOAuthSetup(
  config: FortnoxAppConfig,
  profile: string = DEFAULT_PROFILE,
  scopes: string = SCOPES,
): Promise<void> {
  const validatedProfile = validateProfileName(profile);
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
          const errorDesc = url.searchParams.get('error_description') || '';
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<h1>Autentisering misslyckades</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(errorDesc)}</p>`,
          );
          server.close();
          finish(new Error(`OAuth error: ${error}${errorDesc ? ` — ${errorDesc}` : ''}`));
          return;
        }

        if (state !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Ogiltig OAuth-state</h1><p>Försök igen från noxctl init.</p>');
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
          const companyName = await fetchCompanyNameSafe(tokens.access_token);

          const creds: FortnoxCredentials = {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
            tenant_id: tenantId,
            company_name: companyName,
            scopes,
          };

          // Preserve the original created_at when re-authenticating an existing
          // profile so the index timestamp reflects first auth, not the most
          // recent one. Upsert BEFORE saveCredentials so a filesystem failure
          // here can't leave a credential blob without a matching index entry —
          // `logout --all` enumerates via the index, so a silent orphan would
          // mean creds in the keychain that bulk-logout can't see.
          const existing = (await readProfileIndex()).profiles.find(
            (p) => p.name.toLowerCase() === validatedProfile.toLowerCase(),
          );
          await upsertProfile({
            name: validatedProfile,
            tenant_id: tenantId,
            company_name: companyName,
            created_at: existing?.created_at ?? new Date().toISOString(),
            schema_version: 2,
          });
          await saveCredentials(creds, validatedProfile);

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
      const authUrl = buildAuthorizationUrl(config, REDIRECT_URI, oauthState, scopes);
      console.log('Opening Fortnox login in your browser...');
      openBrowser(authUrl);
      // Printed unconditionally: if the browser does not open, the callback
      // server may already have been torn down by the time a failure surfaces.
      console.log(`\nIf it does not open, paste this URL into your browser:\n${authUrl}`);
      console.log(`\nWaiting for authentication on http://${CALLBACK_HOST}:${PORT}...`);
    });

    server.on('error', (err) => {
      finish(new Error(`Could not start callback server: ${err.message}`));
    });
  });
}
