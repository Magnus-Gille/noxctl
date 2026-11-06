/** Runnable synthetic stdio fixture. Never accepts credentials, URLs or live transports. */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { FortnoxTransport } from '../../../src/fortnox-client.js';
import { openShadowQueue } from '../../../src/shadow/queue.js';
import { StagedCallStore, createStagedHost, createStagedInvoker } from './staged-host.js';

const [root, mode, ...extra] = process.argv.slice(2);
if (
  !root ||
  !isAbsolute(root) ||
  !['normal', 'after-effect', 'after-source'].includes(mode) ||
  extra.length
)
  throw new Error('Expected absolute synthetic scratch directory and explicit fixture mode');
const stat = lstatSync(root);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error('Fixture root must be a private existing scratch directory');
process.umask(0o077);
mkdirSync(join(root, 'queue'), { recursive: true, mode: 0o700 });

const binding = {
  sourceCompany: 'synthetic-stdio-source',
  targetCompany: 'synthetic-stdio-target',
};
const db = new DatabaseSync(join(root, 'staged.sqlite'));
const store = new StagedCallStore(db, binding, 'synthetic-stdio-v1');
const provider = new DatabaseSync(join(root, 'provider.sqlite'));
provider.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;' +
    'CREATE TABLE IF NOT EXISTS effects (seq INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, body TEXT NOT NULL);',
);

async function barrier(stage: string): Promise<void> {
  process.stderr.write(`STAGED_BARRIER ${stage}\n`);
  await new Promise<void>(() => {});
}
function unsupported(): never {
  throw new Error('Operation outside synthetic stdio provider');
}
const transport: FortnoxTransport = {
  async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}) {
    if (!['customers', 'invoices'].includes(endpoint) || options.method !== 'POST') unsupported();
    const envelope = endpoint === 'customers' ? 'Customer' : 'Invoice';
    const body = options.body as Record<string, Record<string, unknown>> | undefined;
    if (!body?.[envelope]) unsupported();
    const result = provider
      .prepare('INSERT INTO effects(endpoint,body) VALUES(?,?)')
      .run(endpoint, JSON.stringify(body));
    if (mode === 'after-effect') await barrier('after-effect');
    const number = String(result.lastInsertRowid);
    return {
      [envelope]: {
        ...body[envelope],
        ...(endpoint === 'customers'
          ? { CustomerNumber: `SIM-${number}` }
          : { DocumentNumber: number }),
      },
    } as T;
  },
  requestWithMetadata: async () => unsupported(),
  requestPdf: async () => unsupported(),
  requestPdfFromMutation: async () => unsupported(),
  requestFile: async () => unsupported(),
  fetchAllPages: async () => unsupported(),
};
const queue = await openShadowQueue(join(root, 'queue'), binding);
const staged = await createStagedInvoker(queue, transport);
const server = createStagedHost(
  store,
  async (record) => {
    const result = await staged.invoke(record);
    if (mode === 'after-source') await barrier('after-source');
    return result;
  },
  staged.status,
);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await staged.close();
  queue.close();
  provider.close();
  db.close();
}
process.stdin.once('end', () => {
  void stop().catch((error: unknown) => {
    process.stderr.write(`Synthetic shutdown failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
});
await server.connect(new StdioServerTransport());
