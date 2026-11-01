import { describe, expect, it, vi } from 'vitest';
import { checkGateway, fileReport, main } from '../scripts/file-plane-ticket.mjs';

const GATEWAY_URL = 'https://gateway.test';
const TOKEN = 'tgw_SECRET-token-value_0123456789';
const NOW = () => new Date('2026-11-02T08:00:00Z');

type OpenTicket = { key: string; title: string };
type Call = { tool: string; args: Record<string, unknown>; init: RequestInit; url: string };

/**
 * A stand-in for the ticket gateway's REST surface. `open` is the set of open `api-drift`
 * tickets; creating a ticket adds to it, so a second run sees the first run's ticket.
 */
function fakeGateway(options: { open?: OpenTicket[]; pageSize?: number } = {}) {
  const open: OpenTicket[] = [...(options.open ?? [])];
  const calls: Call[] = [];
  let nextNumber = 300;

  const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit) => {
    const tool = String(url).split('/api/v1/tools/')[1];
    const args = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ tool, args, init, url: String(url) });

    switch (tool) {
      case 'project_meta':
        return json({
          project: { identifier: 'NOX' },
          labels: [{ name: 'bug' }, { name: 'api-drift' }],
        });
      case 'ticket_search': {
        const size = options.pageSize ?? 100;
        const offset = args.cursor ? Number(args.cursor) : 0;
        const page = open.slice(offset, offset + size);
        const more = offset + size < open.length;
        return json({
          tickets: page,
          total: open.length,
          next_cursor: more ? String(offset + size) : null,
        });
      }
      case 'ticket_create': {
        const key = `NOX-${nextNumber++}`;
        open.push({ key, title: String(args.title) });
        return json({ key, url: 'https://plane.private.test/gille/browse/' + key });
      }
      case 'ticket_comment':
        return json({ key: args.key, comment_id: 'c1' });
      default:
        return json({ error: 'not_found', message: 'Unknown tool' }, 404);
    }
  });

  return { fetchImpl, calls, open, tools: () => calls.map((c) => c.tool) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(gateway: ReturnType<typeof fakeGateway>) {
  return {
    url: GATEWAY_URL,
    token: TOKEN,
    fetchImpl: gateway.fetchImpl as unknown as typeof fetch,
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => out.join('') + err.join(''),
  };
}

const environment = (extra: Record<string, string> = {}) => ({
  TICKET_GATEWAY_URL: GATEWAY_URL,
  TICKET_GATEWAY_TOKEN: TOKEN,
  DIFF_SUMMARY: 'DRIFT-SUMMARY',
  ...extra,
});

describe('gateway requests', () => {
  it('sends the token only in the Authorization header', async () => {
    const gateway = fakeGateway();
    await checkGateway(client(gateway));

    const [call] = gateway.calls;
    expect(call.url).toBe(`${GATEWAY_URL}/api/v1/tools/project_meta`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(call.url).not.toContain(TOKEN);
    expect(String(call.init.body)).not.toContain(TOKEN);
  });

  it('does not follow redirects, so the token cannot be forwarded elsewhere', async () => {
    const gateway = fakeGateway();
    await checkGateway(client(gateway));

    expect(gateway.calls[0].init.redirect).toBe('manual');
    expect(gateway.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['plain http', 'http://gateway.test'],
    ['embedded credentials', 'https://user:pass@gateway.test'],
    ['not a URL', 'gateway.test'],
  ])('refuses a gateway URL with %s', async (_label, url) => {
    const gateway = fakeGateway();
    await expect(
      checkGateway({ url, token: TOKEN, fetchImpl: gateway.fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/TICKET_GATEWAY_URL/);
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a redirect (for example a Cloudflare Access login) without following it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://login.test/?t=${TOKEN}` },
        }),
    );
    const failure = await checkGateway({
      url: GATEWAY_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('302');
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).not.toContain('login.test');
  });

  it('keeps the token, the URL and gateway message text out of error messages', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'invalid_argument', message: `bad ${TOKEN} at ${GATEWAY_URL}` }, 400),
    );
    const failure = await checkGateway({
      url: GATEWAY_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);

    expect(failure.message).toMatch(/project_meta.*400.*invalid_argument/);
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).not.toContain('gateway.test');
  });

  it('keeps secrets out of network failures too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed: ${GATEWAY_URL} Authorization: Bearer ${TOKEN}`);
    });
    const failure = await checkGateway({
      url: GATEWAY_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);

    expect(failure.message).toMatch(/project_meta/);
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.message).not.toContain('gateway.test');
  });

  it('rejects a non-JSON answer instead of treating it as success', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>proxy</html>', { status: 200 }));
    await expect(
      checkGateway({
        url: GATEWAY_URL,
        token: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/project_meta.*not JSON/);
  });
});

describe('gateway check', () => {
  it('passes when the NOX project has the api-drift label', async () => {
    const gateway = fakeGateway();
    await expect(checkGateway(client(gateway))).resolves.toBeUndefined();
    expect(gateway.calls[0].args).toEqual({ project: 'NOX' });
  });

  it('fails when the api-drift label is missing, so a later report cannot fail', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ project: { identifier: 'NOX' }, labels: [{ name: 'bug' }] }),
    );
    await expect(
      checkGateway({
        url: GATEWAY_URL,
        token: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/api-drift/);
  });

  it('fails when the project is not the expected one', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ project: { identifier: 'OTHER' }, labels: [{ name: 'api-drift' }] }),
    );
    await expect(
      checkGateway({
        url: GATEWAY_URL,
        token: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/NOX/);
  });
});

describe('spec-drift report', () => {
  const unrelated: OpenTicket[] = [
    { key: 'NOX-5', title: 'MCP write schema drift' },
    { key: 'NOX-6', title: 'Fortnox API spec fetch failed (2026-09-01)' },
  ];

  it('creates one labelled NOX ticket when no drift ticket is open', async () => {
    const gateway = fakeGateway({ open: unrelated });
    const result = await fileReport(client(gateway), 'drift', {
      summary: 'DRIFT-SUMMARY',
      now: NOW,
    });

    expect(result).toEqual({ action: 'created', key: 'NOX-300' });
    expect(gateway.tools()).toEqual(['ticket_search', 'ticket_create']);
    expect(gateway.calls[0].args).toMatchObject({
      project: 'NOX',
      state: 'open',
      labels: ['api-drift'],
      limit: 100,
    });
    const create = gateway.calls[1].args;
    expect(create).toMatchObject({
      project: 'NOX',
      title: 'Fortnox API spec changed (2026-11-02)',
      labels: ['api-drift'],
    });
    expect(create.description).toContain('DRIFT-SUMMARY');
    expect(create.description).toContain('npm run check:api');
  });

  it('comments on the open drift ticket instead of opening another', async () => {
    const gateway = fakeGateway({
      open: [...unrelated, { key: 'NOX-42', title: 'Fortnox API spec changed (2026-09-21)' }],
    });
    const result = await fileReport(client(gateway), 'drift', {
      summary: 'DRIFT-SUMMARY',
      now: NOW,
    });

    expect(result).toEqual({ action: 'commented', key: 'NOX-42' });
    expect(gateway.tools()).toEqual(['ticket_search', 'ticket_comment']);
    expect(gateway.calls[1].args.key).toBe('NOX-42');
    expect(gateway.calls[1].args.body).toContain(
      'Still differs from the committed fingerprint on 2026-11-02',
    );
    expect(gateway.calls[1].args.body).toContain('DRIFT-SUMMARY');
  });

  it('files one ticket across two runs, not two', async () => {
    const gateway = fakeGateway();
    const first = await fileReport(client(gateway), 'drift', { summary: 'one', now: NOW });
    const second = await fileReport(client(gateway), 'drift', {
      summary: 'two',
      now: () => new Date('2026-11-09T08:00:00Z'),
    });

    expect(first.action).toBe('created');
    expect(second).toEqual({ action: 'commented', key: first.key });
    expect(gateway.tools().filter((t) => t === 'ticket_create')).toHaveLength(1);
  });

  it('finds the open ticket on a later page of results', async () => {
    const filler = Array.from({ length: 5 }, (_, i) => ({
      key: `NOX-${10 + i}`,
      title: `Unrelated ${i}`,
    }));
    const gateway = fakeGateway({
      open: [...filler, { key: 'NOX-77', title: 'Fortnox API spec changed (2026-09-21)' }],
      pageSize: 2,
    });
    const result = await fileReport(client(gateway), 'drift', { summary: 'S', now: NOW });

    expect(result).toEqual({ action: 'commented', key: 'NOX-77' });
    expect(
      gateway.calls.filter((c) => c.tool === 'ticket_search').map((c) => c.args.cursor),
    ).toEqual([undefined, '2', '4']);
  });

  it('refuses to create a ticket when a search over several pages finds nothing', async () => {
    // Results are ordered by last update and paged by offset, so a ticket that is updated
    // between two requests can move past the cursor unseen. A miss over several pages is
    // therefore not proof that no ticket is open, and creating one could duplicate it.
    const filler = Array.from({ length: 5 }, (_, i) => ({
      key: `NOX-${10 + i}`,
      title: `Unrelated ${i}`,
    }));
    const gateway = fakeGateway({ open: filler, pageSize: 2 });

    await expect(fileReport(client(gateway), 'drift', { summary: 'S', now: NOW })).rejects.toThrow(
      /ticket_search.*several pages/,
    );
    expect(gateway.tools()).not.toContain('ticket_create');
    expect(gateway.tools()).not.toContain('ticket_comment');
  });

  it('refuses to create a ticket when the search never ends', async () => {
    const fetchImpl = vi.fn(async () => json({ tickets: [], next_cursor: 'again' }));
    await expect(
      fileReport(
        { url: GATEWAY_URL, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch },
        'drift',
        { summary: 'S', now: NOW },
      ),
    ).rejects.toThrow(/several pages/);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it('still creates the ticket when one page holds every open ticket', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      key: `NOX-${1000 + i}`,
      title: `Unrelated ${i}`,
    }));
    const gateway = fakeGateway({ open: fullPage });
    const result = await fileReport(client(gateway), 'drift', { summary: 'S', now: NOW });

    expect(result.action).toBe('created');
    expect(gateway.tools()).toEqual(['ticket_search', 'ticket_create']);
  });

  it('fails instead of silently passing when the search answer has no ticket list', async () => {
    const fetchImpl = vi.fn(async () => json({ unexpected: true }));
    await expect(
      fileReport(
        { url: GATEWAY_URL, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch },
        'drift',
        { summary: 'S', now: NOW },
      ),
    ).rejects.toThrow(/ticket_search.*unexpected/);
  });

  it('fails when the created ticket comes back without a NOX key', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith('ticket_search')
        ? json({ tickets: [], next_cursor: null })
        : json({ ok: true }),
    );
    await expect(
      fileReport(
        { url: GATEWAY_URL, token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch },
        'drift',
        { summary: 'S', now: NOW },
      ),
    ).rejects.toThrow(/ticket_create.*unexpected/);
  });
});

describe('fetch-failure report', () => {
  it('creates a fetch-failure ticket when none is open', async () => {
    const gateway = fakeGateway({
      open: [{ key: 'NOX-9', title: 'Fortnox API spec changed (2026-09-21)' }],
    });
    const result = await fileReport(client(gateway), 'fetch-error', {
      summary: 'HTTP 429',
      now: NOW,
    });

    expect(result).toEqual({ action: 'created', key: 'NOX-300' });
    expect(gateway.calls[1].args).toMatchObject({
      project: 'NOX',
      title: 'Fortnox API spec fetch failed (2026-11-02)',
      labels: ['api-drift'],
    });
    expect(gateway.calls[1].args.description).toContain('HTTP 429');
  });

  it.each([
    'Fortnox API spec fetch failed (2026-09-01)',
    'API DRIFT CHECK broken',
    'API drift check broken: Fortnox apidocs returns HTTP 429 (since 2026-03-30)',
  ])('comments on the existing failure ticket %j', async (title) => {
    const gateway = fakeGateway({ open: [{ key: 'NOX-39', title }] });
    const result = await fileReport(client(gateway), 'fetch-error', {
      summary: 'HTTP 429',
      now: NOW,
    });

    expect(result).toEqual({ action: 'commented', key: 'NOX-39' });
    expect(gateway.calls[1].args.body).toContain('Still failing on 2026-11-02');
  });
});

describe('write-schema report', () => {
  const flags = (changed: boolean, error: boolean) => ({
    summary: 'SCHEMA-SUMMARY',
    changed,
    error,
    now: NOW,
  });

  it('files drift and audit failure under their own titles', async () => {
    const drift = fakeGateway();
    await fileReport(client(drift), 'schema', flags(true, false));
    expect(drift.calls[1].args).toMatchObject({
      project: 'NOX',
      title: 'MCP write schema drift',
      labels: ['api-drift'],
    });

    const failed = fakeGateway();
    await fileReport(client(failed), 'schema', flags(false, true));
    expect(failed.calls[1].args).toMatchObject({
      project: 'NOX',
      title: 'MCP write schema audit failed',
      labels: ['api-drift'],
    });
    expect(String(failed.calls[1].args.description)).toContain('SCHEMA-SUMMARY');
  });

  it('matches the title exactly, so drift and failure tickets stay separate', async () => {
    const gateway = fakeGateway({
      open: [{ key: 'NOX-8', title: 'MCP write schema audit failed' }],
    });
    const result = await fileReport(client(gateway), 'schema', flags(true, false));
    expect(result).toEqual({ action: 'created', key: 'NOX-300' });
  });

  it('comments on the open ticket with the same title', async () => {
    const gateway = fakeGateway({ open: [{ key: 'NOX-204', title: 'MCP write schema drift' }] });
    const result = await fileReport(client(gateway), 'schema', flags(true, false));

    expect(result).toEqual({ action: 'commented', key: 'NOX-204' });
    expect(gateway.calls[1].args.body).toContain('Detected again on 2026-11-02.');
    expect(gateway.calls[1].args.body).toContain('SCHEMA-SUMMARY');
  });

  it.each([
    [true, true],
    [false, false],
  ])('refuses ambiguous outcome changed=%s error=%s', async (changed, error) => {
    const gateway = fakeGateway();
    await expect(fileReport(client(gateway), 'schema', flags(changed, error))).rejects.toThrow(
      /exactly one/,
    );
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('command line', () => {
  it('fails visibly when the token secret is missing, without contacting the gateway', async () => {
    const gateway = fakeGateway();
    const terminal = io();
    const code = await main(['file', 'drift'], environment({ TICKET_GATEWAY_TOKEN: '' }), {
      ...terminal,
      fetchImpl: gateway.fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(code).toBe(1);
    expect(terminal.text()).toContain('TICKET_GATEWAY_TOKEN');
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });

  it('fails visibly when the URL secret is missing', async () => {
    const gateway = fakeGateway();
    const terminal = io();
    const code = await main(['check'], environment({ TICKET_GATEWAY_URL: '' }), {
      ...terminal,
      fetchImpl: gateway.fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(code).toBe(1);
    expect(terminal.text()).toContain('TICKET_GATEWAY_URL');
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });

  it('prints the ticket key but neither the token nor the gateway or Plane address', async () => {
    const gateway = fakeGateway();
    const terminal = io();
    const code = await main(['file', 'drift'], environment(), {
      ...terminal,
      fetchImpl: gateway.fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(code).toBe(0);
    expect(terminal.text()).toContain('NOX-300');
    expect(terminal.text()).not.toContain(TOKEN);
    expect(terminal.text()).not.toContain('gateway.test');
    expect(terminal.text()).not.toContain('plane.private.test');
  });

  it('reads the report text and outcome flags from the environment', async () => {
    const gateway = fakeGateway();
    const code = await main(
      ['file', 'schema'],
      environment({
        SCHEMA_AUDIT_SUMMARY: 'AUDIT-TEXT',
        SCHEMA_AUDIT_CHANGED: 'false',
        SCHEMA_AUDIT_ERROR: 'true',
      }),
      { ...io(), fetchImpl: gateway.fetchImpl as unknown as typeof fetch, now: NOW },
    );

    expect(code).toBe(0);
    expect(gateway.calls[1].args).toMatchObject({ title: 'MCP write schema audit failed' });
    expect(gateway.calls[1].args.description).toContain('AUDIT-TEXT');
  });

  it('exits non-zero and leaks nothing when the gateway rejects the request', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'invalid_token', error_description: `no ${TOKEN}` }, 401),
    );
    const terminal = io();
    const code = await main(['file', 'drift'], environment(), {
      ...terminal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(code).toBe(1);
    expect(terminal.text()).toContain('401');
    expect(terminal.text()).not.toContain(TOKEN);
    expect(terminal.text()).not.toContain('gateway.test');
  });

  it('exits 2 on a usage error', async () => {
    const gateway = fakeGateway();
    const terminal = io();
    for (const argv of [[], ['file'], ['file', 'unknown'], ['bogus']]) {
      const code = await main(argv, environment(), {
        ...terminal,
        fetchImpl: gateway.fetchImpl as unknown as typeof fetch,
        now: NOW,
      });
      expect(code).toBe(2);
    }
    expect(gateway.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('unexpected failures', () => {
  it('reduces an error this script did not build to its type', async () => {
    const fetchImpl = vi.fn(async () => undefined);
    const terminal = io();
    const code = await main(['check'], environment(), {
      ...terminal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(code).toBe(1);
    expect(terminal.text()).toBe('Unexpected error (TypeError)\n');
  });
});
