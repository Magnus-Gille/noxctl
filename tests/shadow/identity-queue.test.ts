import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { TargetReceiptPendingError } from '../../src/shadow/types.js';
import type { ShadowAdapter } from '../../src/shadow/types.js';

const binding = { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' };
const invoiceId = '11111111-1111-4111-8111-111111111111';
const paymentId = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-identity-'));
  roots.push(root);
  return root;
}
function adapter(targetId = invoiceId): ShadowAdapter {
  return {
    prepare: () => ({ request: {} }),
    apply: vi.fn(async () => ({ targetId, receipt: { data: { id: targetId } } })),
    verify: vi.fn(async () => true),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable queue identity projection', () => {
  it.each(['applied', 'target_in_flight'] as const)(
    'reconstructs %s evidence after a separate writer process is killed',
    async (stage) => {
      const root = directory();
      const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/shadow/queue.js')).href;
      const script = `
      import { openShadowQueue } from ${JSON.stringify(moduleUrl)};
      const q = await openShadowQueue(${JSON.stringify(root)}, ${JSON.stringify(binding)});
      await q.execute({ id: 'child-invoice', operation: 'createInvoice', args: [{}] }, async () => ({ DocumentNumber: '123' }));
      await q.drainOne({ prepare: () => ({ request: {} }), apply: async () => {
        if (${JSON.stringify(stage)} === 'target_in_flight') process.kill(process.pid, 'SIGKILL');
        return { targetId: ${JSON.stringify(invoiceId)}, receipt: { data: { id: ${JSON.stringify(invoiceId)} } } };
      }});
      process.kill(process.pid, 'SIGKILL');
    `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? '', CI: 'true' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.signal, child.stderr).toBe('SIGKILL');
      const queue = await openShadowQueue(root, binding);
      expect(queue.get('child-invoice')?.state).toBe(stage);
      expect(queue.resolveIdentity('invoice', '123').state).toBe(
        stage === 'applied' ? 'ready' : 'unresolved',
      );
      const target = adapter();
      expect(await queue.drainOne(target)).toBe(false);
      expect(target.apply).not.toHaveBeenCalled();
      queue.close();
    },
  );

  it('restores invoice and payment dependencies using persisted receipts without duplicate calls', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('invoice', '123').state).toBe('missing');
    const source = vi.fn(async () => ({ DocumentNumber: '123' }));
    const intent = { id: 'create-invoice', operation: 'createInvoice', args: [{}] };
    await queue.execute(intent, source);
    expect(queue.resolveIdentity('invoice', '123').state).toBe('unresolved');
    const invoice = adapter();
    await queue.drainOne(invoice);
    queue.close();
    queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('invoice', '123')).toMatchObject({
      state: 'ready',
      targetId: invoiceId,
      sourceId: '123',
      ...binding,
    });
    await queue.execute(intent, source);
    expect(source).toHaveBeenCalledTimes(1);
    const payment = adapter(paymentId);
    payment.prepare = (record) => {
      const input = record.args[0] as { InvoiceNumber: string };
      const identity = queue.resolveIdentity('invoice', input.InvoiceNumber);
      return identity.state === 'ready'
        ? { request: { invoice_id: identity.targetId } }
        : { blocked: `Invoice identity ${identity.state}` };
    };
    await queue.execute(
      { id: 'create-payment', operation: 'createInvoicePayment', args: [{ InvoiceNumber: '123' }] },
      async () => ({ Number: 789 }),
    );
    await queue.drainOne(payment);
    expect(payment.apply).toHaveBeenCalledWith(expect.anything(), { invoice_id: invoiceId });
    expect(invoice.apply).toHaveBeenCalledTimes(1);
    expect(payment.apply).toHaveBeenCalledTimes(1);
    queue.close();
    queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('invoice-payment', '789')).toMatchObject({
      state: 'ready',
      targetId: paymentId,
    });
    const before = queue.status();
    queue.resolveIdentity('invoice', '123');
    queue.resolveIdentity('invoice-payment', '789');
    expect(queue.status()).toEqual(before);
    queue.close();
  });

  it('keeps a known but unverified target unresolved across reopen until read-only reconciliation', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    await queue.execute({ id: 'draft', operation: 'createInvoice', args: [{}] }, async () => ({
      DocumentNumber: '1',
    }));
    const target = adapter();
    target.apply = vi.fn(async () => {
      throw new TargetReceiptPendingError(
        invoiceId,
        { data: { id: invoiceId } },
        { cause: new Error('synthetic readback outage') },
      );
    });
    expect(await queue.drainOne(target)).toBe(false);
    queue.close();
    queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('invoice', '1').state).toBe('unresolved');
    expect(await queue.drainOne(target)).toBe(false);
    expect(await queue.reconcileTarget('draft', target)).toBe(true);
    expect(queue.resolveIdentity('invoice', '1')).toMatchObject({
      state: 'ready',
      targetId: invoiceId,
    });
    expect(target.apply).toHaveBeenCalledTimes(1);
    expect(target.verify).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('does not cache a target identity after readback invalidates its receipt', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute({ id: 'draft', operation: 'createInvoice', args: [{}] }, async () => ({
      DocumentNumber: '1',
    }));
    const target = adapter();
    await queue.drainOne(target);
    expect(queue.resolveIdentity('invoice', '1').state).toBe('ready');
    target.verify = vi.fn(async () => false);
    expect(await queue.verifyApplied('draft', target)).toBe(false);
    expect(queue.resolveIdentity('invoice', '1').state).toBe('unresolved');
    expect(target.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('sees committed identities from another connection without a stale in-memory index', async () => {
    const root = directory();
    const writer = await openShadowQueue(root, binding);
    const reader = await openShadowQueue(root, binding);
    expect(reader.resolveIdentity('invoice', '1').state).toBe('missing');
    await writer.execute({ id: 'draft', operation: 'createInvoice', args: [{}] }, async () => ({
      DocumentNumber: '1',
    }));
    expect(reader.resolveIdentity('invoice', '1').state).toBe('unresolved');
    await writer.drainOne(adapter());
    expect(reader.resolveIdentity('invoice', '1')).toMatchObject({
      state: 'ready',
      targetId: invoiceId,
    });
    reader.close();
    writer.close();
  });

  it('blocks a later dependency when two creator intents claim one source invoice', async () => {
    const queue = await openShadowQueue(directory(), binding);
    for (const id of ['first', 'second']) {
      await queue.execute({ id, operation: 'createInvoice', args: [{}] }, async () => ({
        DocumentNumber: '1',
      }));
      await queue.drainOne(adapter());
    }
    expect(queue.resolveIdentity('invoice', '1').state).toBe('conflict');
    await queue.execute(
      { id: 'payment', operation: 'createInvoicePayment', args: [{}] },
      async () => ({ Number: '1' }),
    );
    const target = adapter(paymentId);
    target.prepare = () => {
      const identity = queue.resolveIdentity('invoice', '1');
      return identity.state === 'ready'
        ? { request: { invoice_id: identity.targetId } }
        : { blocked: `Invoice identity ${identity.state}` };
    };
    expect(await queue.drainOne(target)).toBe(false);
    expect(queue.get('payment')).toMatchObject({
      state: 'blocked',
      reason: 'Invoice identity conflict',
    });
    expect(target.apply).not.toHaveBeenCalled();
    queue.close();
  });
});
