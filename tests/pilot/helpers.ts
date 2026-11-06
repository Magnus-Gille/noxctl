import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createAccountedClient } from '../../src/pilot/accounted-client.js';
import { createPilotHost, loadPilotConfig, type PilotHost } from '../../src/pilot/host.js';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';

export const COMPANY = '33333333-3333-4333-8333-333333333333';
export const ORIGIN = 'https://accounted.test';
export const ORG = '556000-0000';
export const ARTICLE_UUID = '44444444-4444-4444-8444-444444444441';
export const API_KEY = 'sk-test-SECRET-key-123';
export const BASE_TIME = 1_800_000_000_000;

const roots: string[] = [];
const hosts: PilotHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    try {
      await host.close();
    } catch {
      // host intentionally broken by a crash drill
    }
  }
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'pilot', 'backups'), 0o700);
    } catch {
      // not created
    }
    rmSync(root, { recursive: true, force: true });
  }
});
export function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pilot-'));
  roots.push(root);
  return root;
}

let uuidCounter = 0;
function uuid(): string {
  uuidCounter++;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: string;
}
export interface FakeAccountedOptions {
  companies?: unknown[];
  nextCursor?: string | null;
  articles?: unknown[];
  /** POST is stored by the fake, then the connection fails (client sees a network error). */
  postFailsAfterStore?: boolean;
  postHangs?: boolean;
  redirect?: boolean;
  /** Runs when a POST arrives, before the response. */
  onPost?: () => void;
}
/** Fake Accounted HTTP server behind an injected fetch. */
export function fakeAccounted(options: FakeAccountedOptions = {}) {
  const calls: FakeCall[] = [];
  const customers = new Map<string, Record<string, unknown>>();
  const invoices = new Map<string, Record<string, unknown>>();
  const state = { ...options };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      redirect: init?.redirect,
    });
    if (state.redirect)
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    const path = url.slice(ORIGIN.length);
    if (path === '/api/v1/companies')
      return json(200, {
        data: state.companies ?? [{ id: COMPANY, name: 'Pilot AB' }],
        meta: { next_cursor: state.nextCursor ?? null },
      });
    const base = `/api/v1/companies/${COMPANY}`;
    if (method === 'POST') state.onPost?.();
    if (method === 'POST' && path === `${base}/customers`) {
      const data = { id: uuid(), ...(JSON.parse(String(init!.body)) as object) };
      customers.set(data.id, data);
      if (state.postHangs)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        );
      if (state.postFailsAfterStore) throw new TypeError('fetch failed');
      return json(201, { data });
    }
    if (method === 'POST' && path === `${base}/invoices`) {
      const body = JSON.parse(String(init!.body)) as InvoiceBody;
      const id = uuid();
      invoices.set(id, invoiceReadback(id, body, customers));
      if (state.postHangs)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        );
      if (state.postFailsAfterStore) throw new TypeError('fetch failed');
      return json(201, { data: { id } });
    }
    const customer = path.match(new RegExp(`^${base}/customers/([0-9a-f-]{36})$`));
    if (method === 'GET' && customer) {
      const data = customers.get(customer[1]!);
      return data ? json(200, { data }) : json(404, {});
    }
    const invoice = path.match(new RegExp(`^${base}/invoices/([0-9a-f-]{36})\\?expand=items$`));
    if (method === 'GET' && invoice) {
      const data = invoices.get(invoice[1]!);
      return data ? json(200, { data }) : json(404, {});
    }
    if (method === 'GET' && path === `${base}/articles?include_inactive=true`)
      return json(200, { data: { articles: state.articles ?? [] } });
    return json(404, { error: 'unexpected' });
  }) as typeof fetch;
  return { calls, customers, invoices, state, fetchImpl };
}

interface InvoiceBody {
  customer_id: string;
  items: Array<{
    quantity: number;
    unit_price: number;
    line_type?: string;
    article_id?: string;
  }>;
}
function invoiceReadback(
  id: string,
  body: InvoiceBody,
  customers: Map<string, Record<string, unknown>>,
) {
  const items = body.items.map((item, index, all) => {
    const lineTotal = Math.round(item.quantity * item.unit_price * 100) / 100;
    return {
      id: uuid(),
      sort_order: index,
      ...item,
      line_type: item.line_type ?? 'product',
      article_id: item.article_id ?? null,
      line_total: lineTotal,
      vat_amount: Math.round(lineTotal * 25) / 100,
      discount_percent: 0,
      deduction_type: null,
      deduction_amount: 0,
      dimensions: {},
      ...(all.length === 0 ? {} : {}),
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const vat = items.reduce((sum, item) => sum + item.vat_amount, 0);
  return {
    id,
    ...body,
    status: 'draft',
    invoice_number: null,
    subtotal,
    vat_amount: vat,
    total: subtotal + vat,
    remaining_amount: subtotal + vat,
    subtotal_sek: subtotal,
    vat_amount_sek: vat,
    total_sek: subtotal + vat,
    vat_treatment: 'standard',
    vat_rate: 25,
    paid_amount: 0,
    credited_invoice_id: null,
    deduction_total: 0,
    default_dimensions: {},
    customer: {
      ...(customers.get(body.customer_id) ?? {}),
      id: body.customer_id,
      customer_type: 'swedish_business',
      country: 'SE',
      archived_at: null,
    },
    items,
  };
}

export function configFor(root: string, overrides: Record<string, unknown> = {}) {
  const config = {
    version: 1,
    profile: 'pilot-test',
    directory: join(root, 'pilot'),
    sourceCompany: ORG,
    targetCompany: COMPANY,
    accountedOrigin: ORIGIN,
    keychainService: 'pilot-test-service',
    keychainAccount: 'pilot-test-account',
    revision: 'a'.repeat(64),
    ...overrides,
  };
  const path = join(root, 'pilot-config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { config, path };
}

export interface HarnessOptions {
  root?: string;
  fortnox?: FortnoxTransport;
  accounted?: ReturnType<typeof fakeAccounted>;
  synthetic?: ReturnType<typeof createSyntheticFortnox>;
  clock?: { now: number };
  stderr?: string[];
  osUser?: string;
  headDir?: string;
  fsync?: (fd: number) => void;
}
export async function makeHost(options: HarnessOptions = {}) {
  const root = options.root ?? tempRoot();
  mkdirSync(root, { recursive: true });
  const { path } = configFor(root);
  const config = loadPilotConfig(path);
  const synthetic = options.synthetic ?? createSyntheticFortnox(ORG);
  const accounted = options.accounted ?? fakeAccounted({ articles: [articleEntry()] });
  const clock = options.clock ?? { now: BASE_TIME };
  const stderr = options.stderr ?? [];
  const headDir = options.headDir ?? join(root, 'heads');
  const host = await createPilotHost(config, {
    fortnox: options.fortnox ?? synthetic.transport,
    accounted: createAccountedClient({
      origin: config.accountedOrigin,
      companyId: config.targetCompany,
      apiKey: async () => API_KEY,
      fetchImpl: accounted.fetchImpl,
      timeoutMs: 500,
    }),
    now: () => clock.now,
    stderr: (line) => stderr.push(line),
    osUser: () => options.osUser ?? 'pilot-operator',
    headDir,
    ...(options.fsync ? { fsync: options.fsync } : {}),
  });
  hosts.push(host);
  return { host, root, config, synthetic, accounted, clock, stderr, headDir };
}

export function articleEntry(extra: Record<string, unknown> = {}) {
  return { id: ARTICLE_UUID, article_number: 'A-1', name: 'Synthetic', active: true, ...extra };
}

export async function connect(host: PilotHost): Promise<Client> {
  const client = new Client({ name: 'pilot-test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.staged.server.connect(host.wrapTransport(st)), client.connect(ct)]);
  return client;
}
export function textOf(result: CallToolResult): string {
  const text = result.content?.find((item) => item.type === 'text');
  return text && 'text' in text ? text.text : '';
}
export async function stagedCreate(
  client: Client,
  tool: 'fortnox_create_customer' | 'fortnox_create_invoice',
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const prepared = (await client.callTool({
    name: 'staged_prepare',
    arguments: { tool, args: { ...args, confirm: true } },
  })) as CallToolResult;
  if (prepared.isError) return prepared;
  const record = JSON.parse(textOf(prepared)) as { id: string };
  return (await client.callTool({
    name: 'staged_execute',
    arguments: { id: record.id, confirm: true },
  })) as CallToolResult;
}
export const invoiceArgs = (article = 'A-1') => ({
  CustomerNumber: '1',
  Currency: 'SEK',
  InvoiceDate: '2026-10-29',
  DueDate: '2026-11-29',
  InvoiceRows: [
    {
      Description: 'Synthetic',
      DeliveredQuantity: 1,
      Price: 100,
      VAT: 25,
      Unit: 'st',
      ArticleNumber: article,
    },
  ],
});
