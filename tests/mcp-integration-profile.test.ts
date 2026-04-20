import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// End-to-end integration: bind a non-default profile via the same helpers
// the MCP stdio startup path uses, connect a real MCP Client/Server pair
// through InMemoryTransport, and verify that a tool-level failure (here:
// unauthenticated — no credentials in tmp HOME) surfaces the profile tag
// through the SDK's error-response path.

describe('MCP profile tag reaches tool responses', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origProfileEnv: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-mcp-integration-'));
    origHome = process.env['HOME'];
    origUserProfile = process.env['USERPROFILE'];
    origProfileEnv = process.env['NOXCTL_PROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    delete process.env['NOXCTL_PROFILE'];

    vi.resetModules();
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

  it('surfaces [profile: staging] in tool error via FortnoxApiError', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Mock the entire credential-load path so we do not hit the user's real
    // macOS keychain (which is user-scoped, not $HOME-scoped) and end up
    // making real network calls. getValidToken returns a fake token, then
    // the mocked fetch forces a 500 so fortnoxRequest constructs a
    // FortnoxApiError — the main chokepoint we want to cover.
    vi.doMock('../src/auth.js', async () => {
      const actual = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js');
      return {
        ...actual,
        getValidToken: vi.fn().mockResolvedValue('fake-token'),
      };
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
      text: () => Promise.resolve(''),
    });

    const { bindStartupProfile, createServer } = await import('../src/index.js');

    await bindStartupProfile({ profile: 'staging' });

    const server = createServer();
    const client = new Client({ name: 'integration-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'fortnox_list_customers',
      arguments: {},
    });

    const content = result.content as { type: string; text: string }[] | undefined;
    const text = content?.[0]?.text ?? '';
    const combined = `${text} ${JSON.stringify(result)}`;
    expect(combined).toContain('[profile: staging]');
  });

  it('omits the profile tag for the default profile', async () => {
    vi.doMock('../src/auth.js', async () => {
      const actual = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js');
      return {
        ...actual,
        getValidToken: vi.fn().mockResolvedValue('fake-token'),
      };
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ ErrorInformation: { message: 'Boom', code: 0 } }),
      text: () => Promise.resolve(''),
    });

    const { bindStartupProfile, createServer } = await import('../src/index.js');

    await bindStartupProfile({ profile: 'default' });

    const server = createServer();
    const client = new Client({ name: 'integration-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'fortnox_list_customers',
      arguments: {},
    });

    const content = result.content as { type: string; text: string }[] | undefined;
    const text = content?.[0]?.text ?? '';
    expect(text).not.toContain('[profile:');
  });
});

// Seam test: the CLI `serve` action must forward the resolved profile name
// into startMcpServer so that a --profile flag isn't silently lost at the
// CLI→MCP boundary. Exercising this without spawning a subprocess keeps CI
// fast and free of stdio-framing flakiness.
describe('CLI → MCP handoff', () => {
  it('bindStartupProfile respects an explicit profile option and skips pointer resolution', async () => {
    vi.resetModules();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Sabotage the pointer so pointer resolution would fail closed if used.
    // If bindStartupProfile honored the explicit option, it should not even
    // read the pointer — so this test must complete without throwing.
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'noxctl-seam-'));
    const cfgDir = path.join(tmpHome, '.fortnox-mcp');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(cfgDir, 'active-profile'), 'has space\n');
    const prevHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;

    try {
      const { bindStartupProfile } = await import('../src/index.js');
      const { getResolvedProfile } = await import('../src/auth.js');

      await expect(bindStartupProfile({ profile: 'from-cli' })).resolves.toBe('from-cli');
      expect(getResolvedProfile()).toBe('from-cli');
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
