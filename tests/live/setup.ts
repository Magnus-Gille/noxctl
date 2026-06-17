/**
 * Shared setup utilities for live (integration) tests.
 *
 * These tests hit the real Fortnox API and require valid credentials to be
 * present in the system keychain.  If credentials are unavailable the entire
 * suite is skipped so the CI pipeline can still pass without secrets.
 */
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { effectiveScopes, loadCredentials, SALARY_SCOPE } from '../../src/auth.js';

/**
 * Returns true when real Fortnox credentials are available in the keychain.
 */
export async function credentialsAvailable(): Promise<boolean> {
  try {
    const creds = await loadCredentials();
    return creds !== null && typeof creds.access_token === 'string';
  } catch {
    return false;
  }
}

/**
 * Returns true when the active profile's credentials were granted the opt-in
 * `salary` (Lön) scope. Payroll live tests skip otherwise, so running the live
 * suite against a non-payroll profile (e.g. the default company) doesn't 403.
 */
export async function salaryScopeAvailable(): Promise<boolean> {
  try {
    const creds = await loadCredentials();
    if (!creds || typeof creds.access_token !== 'string') return false;
    return effectiveScopes(creds).split(' ').includes(SALARY_SCOPE);
  } catch {
    return false;
  }
}

/**
 * Spins up a real (non-mocked) MCP server + client pair over InMemoryTransport.
 * No fetch mocking is applied — all HTTP calls go to the real Fortnox API.
 */
export async function setupLiveClientServer(): Promise<{ client: Client }> {
  const server = createServer();
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

/**
 * Extracts the text content from a tool call result.
 */
export function getText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}
