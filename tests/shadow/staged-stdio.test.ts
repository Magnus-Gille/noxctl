import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowBinding, ShadowRecord } from '../../src/shadow/types.js';

type Mode = 'normal' | 'after-effect' | 'after-source';

interface FixtureSession {
  client: Client;
  transport: StdioClientTransport;
  stderr: string;
  closed: Promise<void>;
  isClosed: () => boolean;
  waitForMarker: (marker: string) => Promise<void>;
}

interface ProviderEffect {
  seq: number;
  endpoint: string;
  body: string;
}

interface StagedCall {
  id: string;
  state: string;
  result?: unknown;
}

const binding: ShadowBinding = {
  sourceCompany: 'synthetic-stdio-source',
  targetCompany: 'synthetic-stdio-target',
};
const workerRoot = fileURLToPath(new URL('../..', import.meta.url));
const evidenceRoot = join(workerRoot, '.local', 'staged-stdio-test');
const fixtureSource = join(workerRoot, 'tests', 'shadow', 'fixtures', 'staged-stdio.ts');
const roots: string[] = [];
const operationTimeoutMs = 8_000;
let runRoot: string;
let buildRoot: string;
let compiledFixture: string;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'noxctl-staged-stdio-'));
  roots.push(root);
  return root;
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = operationTimeoutMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function textOf(result: CallToolResult): string {
  const item = result.content?.find((content) => content.type === 'text');
  return item && 'text' in item ? item.text : '';
}

function jsonOf<T = unknown>(result: CallToolResult): T {
  const text = textOf(result);
  if (!text) return (result.structuredContent ?? result) as T;
  return JSON.parse(text) as T;
}

function assertSuccessful(result: CallToolResult): void {
  if (result.isError === true) throw new Error(`Fixture returned an MCP error: ${textOf(result)}`);
}

function customerArgs(name = 'Synthetic stdio customer AB'): Record<string, unknown> {
  return {
    Name: name,
    Type: 'COMPANY',
    CountryCode: 'SE',
    confirm: true,
  };
}

function invoiceArgs(marker = 'Synthetic stdio invoice'): Record<string, unknown> {
  return {
    CustomerNumber: '42',
    InvoiceRows: [
      {
        Description: marker,
        DeliveredQuantity: 1,
        Price: 100,
        VAT: 25,
      },
    ],
    InvoiceDate: '2026-10-29',
    DueDate: '2026-11-29',
    OurReference: marker,
    confirm: true,
    includeRaw: true,
  };
}

function readEffects(root: string): ProviderEffect[] {
  const db = new DatabaseSync(join(root, 'provider.sqlite'));
  try {
    return db
      .prepare('SELECT seq, endpoint, body FROM effects ORDER BY seq')
      .all() as unknown as ProviderEffect[];
  } finally {
    db.close();
  }
}

async function readQueue(root: string): Promise<ShadowRecord[]> {
  const queue = await openShadowQueue(join(root, 'queue'), binding);
  try {
    return queue
      .status()
      .items.map(({ id }) => queue.get(id))
      .filter((record): record is ShadowRecord => record !== undefined);
  } finally {
    queue.close();
  }
}

function compileFixture(): void {
  if (!readFileSync(fixtureSource, 'utf8')) throw new Error('Synthetic stdio fixture is empty');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  runRoot = mkdtempSync(join(evidenceRoot, 'run-'));
  buildRoot = join(runRoot, 'build');
  compiledFixture = join(buildRoot, 'tests', 'shadow', 'fixtures', 'staged-stdio.js');
  mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  const tsc = join(workerRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const scratchHome = join(runRoot, 'compile-home');
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        '--target',
        'ES2022',
        '--module',
        'Node16',
        '--moduleResolution',
        'Node16',
        '--strict',
        '--skipLibCheck',
        '--esModuleInterop',
        '--rootDir',
        '.',
        '--outDir',
        buildRoot,
        'tests/shadow/fixtures/staged-stdio.ts',
      ],
      {
        cwd: workerRoot,
        env: {
          HOME: scratchHome,
          PATH: '/usr/bin:/bin',
          TMPDIR: runRoot,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      [
        'Synthetic stdio fixture compilation failed',
        details.stderr?.trim(),
        details.stdout?.trim(),
        details.message,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

async function connectFixture(root: string, mode: Mode): Promise<FixtureSession> {
  const transport = new StdioClientTransport({
    command: '/usr/bin/env',
    args: [
      '-i',
      `HOME=${root}`,
      `TMPDIR=${root}`,
      'PATH=/usr/bin:/bin',
      process.execPath,
      compiledFixture,
      root,
      mode,
    ],
    cwd: workerRoot,
    env: {
      HOME: root,
      PATH: '/usr/bin:/bin',
      TMPDIR: root,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const markerWaiters = new Map<string, Array<() => void>>();
  const stderrStream = transport.stderr;
  if (!stderrStream) throw new Error('Stdio transport did not expose a stderr stream');
  stderrStream.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
    for (const [marker, waiters] of markerWaiters) {
      if (!stderr.includes(marker)) continue;
      markerWaiters.delete(marker);
      for (const resolve of waiters) resolve();
    }
  });
  transport.onerror = (error) => {
    stderr += `\nTRANSPORT_ERROR ${error.name}: ${error.message}\n`;
  };
  const client = new Client({ name: 'synthetic-stdio-test-client', version: '0.0.0-test' });
  client.onclose = () => {
    closed = true;
    resolveClosed();
  };
  try {
    await withTimeout(client.connect(transport), 'stdio client connect');
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const pid = transport.pid;
    if (!closed && pid && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await withTimeout(closedPromise, `stdio child ${pid} close after connect failure`);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const diagnostic = `Synthetic stdio connect failed${stderr ? `\n${stderr}` : ''}`;
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], diagnostic);
    throw new Error(diagnostic, { cause: error });
  }
  return {
    client,
    transport,
    get stderr() {
      return stderr;
    },
    closed: closedPromise,
    isClosed: () => closed,
    waitForMarker: (marker: string) => {
      if (stderr.includes(marker)) return Promise.resolve();
      return withTimeout(
        new Promise<void>((resolve) => {
          const waiters = markerWaiters.get(marker) ?? [];
          waiters.push(resolve);
          markerWaiters.set(marker, waiters);
        }),
        `stderr marker ${marker}`,
      ).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
      });
    },
  };
}

async function killOwnedChild(session: FixtureSession): Promise<void> {
  const pid = session.transport.pid;
  if (!pid || pid === process.pid) throw new Error('Refusing to kill an unowned fixture process');
  process.kill(pid, 'SIGKILL');
  await withTimeout(session.closed, `stdio child ${pid} close`);
  expect(session.isClosed()).toBe(true);
}

async function closeSession(session: FixtureSession | undefined): Promise<void> {
  if (!session) return;
  const operations: Promise<unknown>[] = [];
  if (!session.isClosed()) operations.push(killOwnedChild(session));
  operations.push(session.client.close());
  const outcomes = await Promise.allSettled(operations);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length > 0) {
    throw new Error(
      `Synthetic stdio cleanup failed: ${errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join('; ')}\n${session.stderr}`,
    );
  }
}

async function prepare(
  session: FixtureSession,
  tool: 'fortnox_create_customer' | 'fortnox_create_invoice',
  args: Record<string, unknown>,
): Promise<StagedCall> {
  const result = await withTimeout(
    session.client.callTool({ name: 'staged_prepare', arguments: { tool, args } }),
    'staged_prepare',
  );
  assertSuccessful(result as CallToolResult);
  return jsonOf<StagedCall>(result as CallToolResult);
}

async function getCall(session: FixtureSession, id: string): Promise<StagedCall> {
  const result = await withTimeout(
    session.client.callTool({ name: 'staged_get', arguments: { id } }),
    'staged_get',
  );
  assertSuccessful(result as CallToolResult);
  return jsonOf<StagedCall>(result as CallToolResult);
}

async function execute(session: FixtureSession, id: string): Promise<CallToolResult> {
  return (await withTimeout(
    session.client.callTool({ name: 'staged_execute', arguments: { id, confirm: true } }),
    'staged_execute',
  )) as CallToolResult;
}

async function shadowStatus(session: FixtureSession): Promise<Record<string, unknown>> {
  const result = await withTimeout(
    session.client.callTool({ name: 'fortnox_shadow_status', arguments: {} }),
    'fortnox_shadow_status',
  );
  assertSuccessful(result as CallToolResult);
  return jsonOf<Record<string, unknown>>(result as CallToolResult);
}

beforeAll(() => {
  compileFixture();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (runRoot) rmSync(runRoot, { recursive: true, force: true });
});

describe('synthetic stdio staged shadow recovery', () => {
  it('reopens a prepared call without an effect, then executes it once', async () => {
    const root = makeRoot();
    let session: FixtureSession | undefined;
    let reopened: FixtureSession | undefined;
    try {
      session = await connectFixture(root, 'normal');
      const prepared = await prepare(session, 'fortnox_create_customer', customerArgs());
      expect(prepared.state).toBe('prepared');
      await killOwnedChild(session);
      expect(readEffects(root)).toHaveLength(0);

      reopened = await connectFixture(root, 'normal');
      await expect(getCall(reopened, prepared.id)).resolves.toMatchObject({
        id: prepared.id,
        state: 'prepared',
      });
      const result = await execute(reopened, prepared.id);
      assertSuccessful(result);
      expect(readEffects(root)).toHaveLength(1);
      await expect(getCall(reopened, prepared.id)).resolves.toMatchObject({
        id: prepared.id,
        state: 'completed',
      });
    } finally {
      await closeSession(reopened);
      await closeSession(session);
    }
  }, 30_000);

  it('replays a complete call after reopen with the same full result and one pending child', async () => {
    const root = makeRoot();
    let session: FixtureSession | undefined;
    let reopened: FixtureSession | undefined;
    try {
      session = await connectFixture(root, 'normal');
      const prepared = await prepare(
        session,
        'fortnox_create_invoice',
        invoiceArgs('replayed synthetic stdio invoice'),
      );
      const first = await execute(session, prepared.id);
      assertSuccessful(first);
      const statusBefore = await shadowStatus(session);
      expect(statusBefore).toMatchObject({ counts: { pending: 1 } });
      await killOwnedChild(session);

      reopened = await connectFixture(root, 'normal');
      const replay = await execute(reopened, prepared.id);
      expect(replay).toEqual(first);
      expect(readEffects(root)).toHaveLength(1);
      await expect(shadowStatus(reopened)).resolves.toMatchObject({ counts: { pending: 1 } });
    } finally {
      await closeSession(reopened);
      await closeSession(session);
    }
  }, 30_000);

  it('does not retry an after-effect interruption after the child is killed', async () => {
    const root = makeRoot();
    let session: FixtureSession | undefined;
    let reopened: FixtureSession | undefined;
    try {
      session = await connectFixture(root, 'after-effect');
      const prepared = await prepare(session, 'fortnox_create_customer', customerArgs());
      const pending = execute(session, prepared.id).then(
        () => new Error('after-effect request unexpectedly completed'),
        (error: unknown) => error,
      );
      await session.waitForMarker('STAGED_BARRIER after-effect\n');
      expect(readEffects(root)).toHaveLength(1);
      await killOwnedChild(session);
      const rejection = await pending;
      expect(String(rejection)).toMatch(/closed|terminated|transport|process/i);

      reopened = await connectFixture(root, 'after-effect');
      await expect(getCall(reopened, prepared.id)).resolves.toMatchObject({
        id: prepared.id,
        state: 'executing',
      });
      await expect(shadowStatus(reopened)).resolves.toMatchObject({
        counts: { source_in_flight: 1 },
      });
      const blocked = await execute(reopened, prepared.id);
      expect(blocked.isError).toBe(true);
      expect(readEffects(root)).toHaveLength(1);
    } finally {
      await closeSession(reopened);
      await closeSession(session);
    }
  }, 30_000);

  it('retains the source receipt after an after-source interruption and blocks replay', async () => {
    const root = makeRoot();
    let session: FixtureSession | undefined;
    let reopened: FixtureSession | undefined;
    try {
      session = await connectFixture(root, 'after-source');
      const prepared = await prepare(session, 'fortnox_create_customer', customerArgs());
      const pending = execute(session, prepared.id).then(
        () => new Error('after-source request unexpectedly completed'),
        (error: unknown) => error,
      );
      await session.waitForMarker('STAGED_BARRIER after-source\n');
      expect(readEffects(root)).toHaveLength(1);
      await killOwnedChild(session);
      const rejection = await pending;
      expect(String(rejection)).toMatch(/closed|terminated|transport|process/i);

      reopened = await connectFixture(root, 'after-source');
      await expect(getCall(reopened, prepared.id)).resolves.toMatchObject({
        id: prepared.id,
        state: 'executing',
      });
      const records = await readQueue(root);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: 'createCustomer',
        state: 'pending',
        sourceResult: { CustomerNumber: 'SIM-1' },
      });
      const blocked = await execute(reopened, prepared.id);
      expect(blocked.isError).toBe(true);
      expect(readEffects(root)).toHaveLength(1);
    } finally {
      await closeSession(reopened);
      await closeSession(session);
    }
  }, 30_000);

  it('assigns distinct staged IDs and source receipts to identical payloads', async () => {
    const root = makeRoot();
    let session: FixtureSession | undefined;
    try {
      session = await connectFixture(root, 'normal');
      const payload = customerArgs('Same synthetic stdio payload AB');
      const first = await prepare(session, 'fortnox_create_customer', payload);
      const second = await prepare(session, 'fortnox_create_customer', payload);
      expect(first.id).not.toBe(second.id);
      assertSuccessful(await execute(session, first.id));
      assertSuccessful(await execute(session, second.id));
      expect(readEffects(root)).toHaveLength(2);
      const records = await readQueue(root);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.id)).toEqual(
        expect.arrayContaining([`${first.id}:0`, `${second.id}:0`]),
      );
      expect(
        records
          .map((record) => (record.sourceResult as { CustomerNumber: string }).CustomerNumber)
          .sort(),
      ).toEqual(['SIM-1', 'SIM-2']);
    } finally {
      await closeSession(session);
    }
  }, 30_000);
});
