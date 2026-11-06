import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'noxctl-embedded-consumer-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(scratch, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${output}`);
  }
  return result.stdout;
}

function linkDependency(name, consumerNodeModules) {
  const target = resolve(repoRoot, 'node_modules', ...name.split('/'));
  const link = resolve(consumerNodeModules, ...name.split('/'));
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

try {
  const packDir = join(scratch, 'pack');
  const extractDir = join(scratch, 'extract');
  const consumerDir = join(scratch, 'consumer');
  const consumerNodeModules = join(consumerDir, 'node_modules');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(consumerNodeModules, { recursive: true });

  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], repoRoot),
  );
  const tarball = join(packDir, packed[0].filename);
  run('tar', ['-xzf', tarball, '-C', extractDir], repoRoot);

  const packedPackageDir = join(extractDir, 'package');
  const manifest = JSON.parse(readFileSync(join(packedPackageDir, 'package.json'), 'utf8'));
  if (manifest.exports?.['./embedded']?.import !== './dist/embedded.js') {
    throw new Error('Packed package does not expose noxctl/embedded at dist/embedded.js');
  }

  renameSync(packedPackageDir, join(consumerNodeModules, 'noxctl'));
  for (const dependency of ['@modelcontextprotocol/sdk', 'commander', 'zod', '@types/node']) {
    linkDependency(dependency, consumerNodeModules);
  }

  writeFileSync(join(consumerDir, 'package.json'), '{"type":"module","private":true}\n');
  writeFileSync(
    join(consumerDir, 'runtime.mjs'),
    `import * as embedded from 'noxctl/embedded';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TargetReceiptPendingError } from 'noxctl/embedded';
const { createFortnoxClient, createFortnoxOperations, createServer } = embedded;
if (typeof embedded.ShadowQueue.prototype.drainPaymentAware !== 'function' ||
    typeof embedded.ShadowQueue.prototype.reconcilePaymentGroup !== 'function' ||
    typeof embedded.ShadowQueue.prototype.verifyPaymentGroup !== 'function') {
  throw new Error('Packed package omits grouped payment queue methods');
}
if (typeof embedded.projectInvoicePaymentLifecycle !== 'function') {
  throw new Error('Packed package does not expose projectInvoicePaymentLifecycle');
}
const paymentSource = embedded.projectInvoicePaymentLifecycle(
  [], { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' }, '10',
);
if (paymentSource.state !== 'missing' || paymentSource.chain.length !== 0) {
  throw new Error('Packed payment source projection did not preserve missing evidence');
}
if (typeof embedded.AccountedInvoiceStageVerifier !== 'function') {
  throw new Error('Packed package does not expose AccountedInvoiceStageVerifier');
}
const stage = new embedded.AccountedInvoiceStageVerifier(
  { sourceCompany: 'synthetic-source', targetCompany: '33333333-3333-4333-8333-333333333333' },
  () => [],
  async () => { throw new Error('Missing identity must not call the target'); },
);
if ((await stage.verify('10')).state !== 'missing') {
  throw new Error('Packed stage verifier did not preserve missing identity');
}
if (typeof embedded.AccountedInvoiceDraftAdapter !== 'function') {
  throw new Error('Packed embedded API is missing the explicit draft adapter');
}
if (typeof embedded.AccountedInvoiceIssueAdapter !== 'function') {
  throw new Error('Packed embedded API is missing the explicit issue adapter');
}
if (typeof embedded.AccountedInvoicePaymentAdapter !== 'function') {
  throw new Error('Packed embedded API is missing the explicit invoice payment adapter');
}
let paymentRequests = 0;
const paymentAdapter = new embedded.AccountedInvoicePaymentAdapter(
  { sourceCompany: 'synthetic-source', targetCompany: '33333333-3333-4333-8333-333333333333' },
  () => [],
  () => undefined,
  async () => { paymentRequests++; throw new Error('Missing source must not call target'); },
);
const emptyPayment = paymentAdapter.prepare({
  id: 'synthetic-empty-payment-group', sourcePaymentId: '17', sourceInvoiceId: '10',
  members: [], sourceResult: {},
});
if (!('blocked' in emptyPayment) || paymentRequests !== 0) {
  throw new Error('Packed invoice payment adapter did not refuse missing source evidence');
}
for (const forbidden of ['startMcpServer', 'bindStartupProfile', 'defaultFortnoxTransport', 'defaultFortnoxOperations']) {
  if (forbidden in embedded) throw new Error(\`Embedded API leaked \${forbidden}\`);
}
const transport = createFortnoxClient({
  getAccessToken: async () => 'consumer-test-token',
  fetch: async () => new Response('{}'),
});
const operations = createFortnoxOperations(transport);
const server = createServer({ transport });
if (typeof operations.getCompanyInfo !== 'function' || typeof server.connect !== 'function') {
  throw new Error('Embedded runtime exports are incomplete');
}
const targetId = '11111111-1111-4111-8111-111111111111';
const adapter = new embedded.AccountedMasterDataAdapter(
  { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
  async (request) => {
    if (request.method === 'GET') throw new Error('synthetic readback failure');
    return {
      status: 201,
      json: { data: { id: targetId, ...request.body } },
    };
  },
);
const record = {
  sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target',
  id: 'synthetic-customer-intent', version: 1, requestHash: 'synthetic-customer-hash',
  operation: 'createCustomer', args: [{ Name: 'Synthetic Customer' }],
  sourceResult: {
    Name: 'Synthetic Customer', Type: 'COMPANY', CountryCode: 'SE', CustomerNumber: 'C1',
  },
  state: 'pending', createdAt: 1, updatedAt: 1,
};
const prepared = adapter.prepare(record);
if (!('request' in prepared)) throw new Error('Synthetic customer mapping was blocked');
try {
  await adapter.apply(record, prepared.request);
  throw new Error('Synthetic readback failure did not reject');
} catch (error) {
  if (!(error instanceof TargetReceiptPendingError)) {
    throw new Error('Packed adapter did not expose TargetReceiptPendingError', { cause: error });
  }
  if (error.targetId !== targetId) throw new Error('Packed pending error lost targetId');
  if (JSON.stringify(error.receipt) !== JSON.stringify({
    data: { id: targetId, ...prepared.request }, expected: prepared.request,
  })) throw new Error('Packed pending error lost target receipt');
}
const directory = mkdtempSync(join(tmpdir(), 'noxctl-packed-staged-'));
let sourceCalls = 0;
const staged = await embedded.createStagedServer({
  directory,
  transport: createFortnoxClient({
    getAccessToken: async () => 'synthetic-only',
    fetch: async () => {
      sourceCalls++;
      return new Response(JSON.stringify({ Customer: { Name: 'Synthetic', CustomerNumber: 'S1' } }));
    },
  }),
  binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
  actorId: 'synthetic-owner', revision: 'a'.repeat(64), maxPreparationAgeMs: 60000,
  authorize: async () => true,
});
const stagedClient = new Client({ name: 'packed-synthetic-client', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([staged.server.connect(serverTransport), stagedClient.connect(clientTransport)]);
  const prepared = await stagedClient.callTool({ name: 'staged_prepare', arguments: {
    tool: 'fortnox_create_customer', args: { Name: 'Synthetic', confirm: true },
  }});
  if (prepared.isError || sourceCalls !== 0) throw new Error('Packed preparation failed');
  const { id } = JSON.parse(prepared.content[0].text);
  const request = { name: 'staged_execute', arguments: { id, confirm: true } };
  const result = await stagedClient.callTool(request);
  const replay = await stagedClient.callTool(request);
  if (result.isError || JSON.stringify(result) !== JSON.stringify(replay) || sourceCalls !== 1)
    throw new Error('Packed staged execution/replay failed');
  if (staged.queue.status().counts.pending !== 1) throw new Error('Packed queue receipt missing');
} finally {
  await stagedClient.close();
  await staged.close();
  rmSync(directory, { recursive: true, force: true });
}
for (const invalid of [undefined, {}]) {
  try {
    createServer(invalid);
    throw new Error('Embedded createServer accepted a missing tenant transport');
  } catch (error) {
    if (!String(error).includes('tenant-bound transport')) throw error;
  }
}
`,
  );
  writeFileSync(
    join(consumerDir, 'consumer.ts'),
    `import {
  createFortnoxClient,
  createFortnoxOperations,
  createServer,
  TargetReceiptPendingError,
  AccountedInvoiceIssueAdapter,
  AccountedInvoiceStageVerifier,
  AccountedInvoicePaymentAdapter,
  type CapturedPaymentVoucher,
  type InvoicePaymentPlan,
  type ShadowPaymentAdapter,
  type ShadowPaymentGroup,
  type ShadowSnapshotEntry,
  type InvoiceStageVerification,
  type CreateFortnoxClientOptions,
  type CreateServerOptions,
  createStagedServer,
  type CreateStagedServerOptions,
  type FortnoxOperations,
  type FortnoxTransport,
} from 'noxctl/embedded';

const clientOptions: CreateFortnoxClientOptions = {
  getAccessToken: async () => 'consumer-test-token',
  fetch: async () => new Response('{}'),
};
const transport: FortnoxTransport = createFortnoxClient(clientOptions);
const operations: FortnoxOperations = createFortnoxOperations(transport);
const serverOptions: CreateServerOptions = { transport };
createServer(serverOptions);
const stagedOptions: CreateStagedServerOptions = {
  transport, directory: '/synthetic-unused',
  binding: { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' },
  actorId: 'synthetic-owner', revision: 'a'.repeat(64), maxPreparationAgeMs: 60000,
  authorize: ({ actorId }) => actorId === 'synthetic-owner',
};
void stagedOptions;
void createStagedServer;
void TargetReceiptPendingError;
const issueAdapter = new AccountedInvoiceIssueAdapter(
  { sourceCompany: 'synthetic-source', targetCompany: '33333333-3333-4333-8333-333333333333' },
  () => ({ state: 'missing' }),
  () => undefined,
  async () => { throw new Error('Synthetic type-check-only transport'); },
);
void issueAdapter;
const stageSnapshot: ShadowSnapshotEntry[] = [];
const stageVerifier = new AccountedInvoiceStageVerifier(
  { sourceCompany: 'synthetic-source', targetCompany: '33333333-3333-4333-8333-333333333333' },
  () => stageSnapshot,
  async () => { throw new Error('Synthetic type-check-only transport'); },
);
const stageResult: Promise<InvoiceStageVerification> = stageVerifier.verify('10');
void stageResult;
const paymentVoucher = (_group: ShadowPaymentGroup): CapturedPaymentVoucher | undefined => undefined;
const paymentAdapter: ShadowPaymentAdapter = new AccountedInvoicePaymentAdapter(
  { sourceCompany: 'synthetic-source', targetCompany: '33333333-3333-4333-8333-333333333333' },
  () => stageSnapshot,
  paymentVoucher,
  async () => { throw new Error('Synthetic type-check-only payment transport'); },
);
const paymentPlan: InvoicePaymentPlan | undefined = undefined;
void paymentAdapter;
void paymentPlan;
// @ts-expect-error Embedded servers must fail closed without a tenant transport.
createServer();
void operations;
`,
  );

  run(process.execPath, ['runtime.mjs'], consumerDir);
  run(
    process.execPath,
    [join(consumerNodeModules, 'noxctl', 'dist', 'cli.js'), '--help'],
    consumerDir,
  );
  run(
    process.execPath,
    [
      resolve(repoRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      '--target',
      'ES2022',
      'consumer.ts',
    ],
    consumerDir,
  );

  process.stdout.write('Packed noxctl/embedded runtime and type consumer passed.\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
