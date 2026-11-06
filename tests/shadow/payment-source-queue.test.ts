import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createInvoicePaymentOperations } from '../../src/operations/invoice-payments.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';
import { projectInvoicePaymentLifecycle } from '../../src/shadow/payment-source-lifecycle.js';

const binding = { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' };
const directories: string[] = [];
const queues: ShadowQueue[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'payment-source-queue-'));
  directories.push(path);
  return path;
}
async function open(path: string) {
  const queue = await openShadowQueue(path, binding);
  queues.push(queue);
  return queue;
}
function close(queue: ShadowQueue) {
  queue.close();
  queues.splice(queues.indexOf(queue), 1);
}
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const receipt = (Booked: boolean, Amount = 100) => ({
  Number: '10',
  InvoiceNumber: 17,
  Booked,
  Amount,
  Currency: 'SEK',
  PaymentDate: '2026-01-10',
});

describe('source payment lifecycle over durable queue receipts', () => {
  it('retains interleaved create/update/bookkeep receipts after reopen without marking targets applied', async () => {
    const path = directory();
    let queue = await open(path);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ InvoicePayment: receipt(false) })
      .mockResolvedValueOnce({ InvoicePayment: receipt(false, 90) })
      .mockResolvedValueOnce({ InvoicePayment: receipt(true, 90) });
    const operations = createInvoicePaymentOperations({ request } as unknown as FortnoxTransport);
    const createArgs = { InvoiceNumber: 17, Amount: 100 };
    await queue.execute(
      { id: 'create-payment', operation: 'createInvoicePayment', args: [createArgs] },
      () => operations.createInvoicePayment(createArgs),
    );
    const firstSnapshot = queue.snapshot();
    expect(projectInvoicePaymentLifecycle(firstSnapshot, binding, '10').state).toBe(
      'waiting-for-bookkeeping',
    );
    await queue.execute(
      { id: 'unrelated-customer', operation: 'createCustomer', args: [{ Name: 'Synthetic' }] },
      async () => ({ CustomerNumber: '99' }),
    );
    const updateArgs = { Amount: 90 };
    await queue.execute(
      { id: 'update-payment', operation: 'updateInvoicePayment', args: ['10', updateArgs] },
      () => operations.updateInvoicePayment('10', updateArgs),
    );
    close(queue);
    queue = await open(path);
    expect(projectInvoicePaymentLifecycle(queue.snapshot(), binding, '10').state).toBe(
      'waiting-for-bookkeeping',
    );
    await queue.execute(
      { id: 'book-payment', operation: 'bookkeepInvoicePayment', args: ['10'] },
      () => operations.bookkeepInvoicePayment('10'),
    );
    const snapshot = queue.snapshot();
    const projected = projectInvoicePaymentLifecycle(snapshot, binding, '10');
    expect(projected.state).toBe('booked');
    expect(projected.sourceInvoiceId).toBe('17');
    expect(projected.sourceResult).toEqual(receipt(true, 90));
    expect(projected.chain.map((item) => item.intentId)).toEqual([
      'create-payment',
      'update-payment',
      'book-payment',
    ]);
    expect(projected.chain.map((item) => item.sequence)).toEqual([1, 3, 4]);
    expect(queue.snapshot()).toEqual(snapshot);
    expect(queue.summary().counts.pending).toBe(4);
    expect(queue.summary().counts.applied).toBe(0);
    expect(
      snapshot.every(
        ({ record }) => record.targetId === undefined && record.targetReceipt === undefined,
      ),
    ).toBe(true);
    const forbiddenReplay = vi.fn(async () => {
      throw new Error('source replay');
    });
    expect(
      await queue.execute(
        { id: 'book-payment', operation: 'bookkeepInvoicePayment', args: ['10'] },
        forbiddenReplay,
      ),
    ).toEqual(receipt(true, 90));
    expect(forbiddenReplay).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([endpoint, options]) => [endpoint, options.method])).toEqual([
      ['invoicepayments', 'POST'],
      ['invoicepayments/10', 'PUT'],
      ['invoicepayments/10/bookkeep', 'PUT'],
    ]);
    expect(projected.snapshotHash).not.toBe(
      projectInvoicePaymentLifecycle(firstSnapshot, binding, '10').snapshotHash,
    );
  });

  it('leaves an unknown source bookkeep outcome unresolved and never retries it', async () => {
    const queue = await open(directory());
    await queue.execute(
      { id: 'create', operation: 'createInvoicePayment', args: [{ InvoiceNumber: 17 }] },
      async () => receipt(false),
    );
    await expect(
      queue.execute(
        { id: 'bookkeep', operation: 'bookkeepInvoicePayment', args: ['10'] },
        async () => {
          throw new Error('synthetic response lost');
        },
      ),
    ).rejects.toThrow('synthetic response lost');
    const before = queue.snapshot();
    expect(projectInvoicePaymentLifecycle(before, binding, '10').state).toBe('unresolved');
    const replay = vi.fn(async () => receipt(true));
    await expect(
      queue.execute({ id: 'bookkeep', operation: 'bookkeepInvoicePayment', args: ['10'] }, replay),
    ).rejects.toThrow('Source outcome unknown');
    expect(replay).not.toHaveBeenCalled();
    expect(queue.snapshot()).toEqual(before);
  });

  it('projects a source-only deletion while every target operation stays pending', async () => {
    const queue = await open(directory());
    await queue.execute(
      { id: 'create', operation: 'createInvoicePayment', args: [{ InvoiceNumber: 17 }] },
      async () => receipt(false),
    );
    await queue.execute(
      { id: 'delete', operation: 'deleteInvoicePayment', args: ['10'] },
      async () => undefined,
    );
    expect(projectInvoicePaymentLifecycle(queue.snapshot(), binding, '10').state).toBe('deleted');
    expect(queue.summary().counts.pending).toBe(2);
    expect(queue.summary().counts.applied).toBe(0);
  });

  it('preserves the unbooked receipt across a real child-process termination', async () => {
    const path = directory();
    const url = pathToFileURL(join(process.cwd(), 'dist/shadow/queue.js')).href;
    const script = `import {openShadowQueue} from ${JSON.stringify(url)};
      const queue = await openShadowQueue(${JSON.stringify(path)}, ${JSON.stringify(binding)});
      await queue.execute({id:'child-create',operation:'createInvoicePayment',args:[{InvoiceNumber:17}]},async()=>(${JSON.stringify(receipt(false))}));
      process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { HOME: path, TMPDIR: path, PATH: process.env.PATH ?? '', CI: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const queue = await open(path);
    const snapshot = queue.snapshot();
    expect(projectInvoicePaymentLifecycle(snapshot, binding, '10').state).toBe(
      'waiting-for-bookkeeping',
    );
    expect(queue.get('child-create')?.sourceResult).toEqual(receipt(false));
    expect(queue.snapshot()).toEqual(snapshot);
  });
});
