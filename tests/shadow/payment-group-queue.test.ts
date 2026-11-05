import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { TargetNotDispatchedError, TargetReceiptPendingError } from '../../src/shadow/types.js';
import type {
  ShadowAdapter,
  ShadowBinding,
  ShadowPaymentAdapter,
  ShadowPaymentGroup,
  ShadowRecord,
} from '../../src/shadow/types.js';

const binding: ShadowBinding = {
  sourceCompany: 'synthetic-source',
  targetCompany: 'synthetic-target',
};
// Source document numbers and an opaque target UUID are synthetic. The receipt is a test-only value,
// not a claim about the shape of any provider API response.
const paymentId = '17';
const invoiceId = '42';
const targetPaymentId = '99999999-9999-4999-8999-999999999999';
const paymentReceipt = { kind: 'synthetic-payment-group-receipt', marker: 'fixture-only' };
const roots: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'payment-group-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createPayment(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id = 'payment-create',
) {
  return queue.execute(
    {
      id,
      operation: 'createInvoicePayment',
      args: [{ InvoiceNumber: invoiceId, Amount: 125 }],
    },
    async () => ({ Number: paymentId, InvoiceNumber: invoiceId, Booked: false }),
  );
}

async function updatePayment(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id = 'payment-update',
) {
  return queue.execute(
    { id, operation: 'updateInvoicePayment', args: [paymentId, { Memo: 'synthetic update' }] },
    async () => ({ Number: paymentId, InvoiceNumber: invoiceId, Booked: false }),
  );
}

async function bookkeepPayment(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id = 'payment-bookkeep',
) {
  return queue.execute(
    { id, operation: 'bookkeepInvoicePayment', args: [paymentId] },
    async () => ({ Number: paymentId, InvoiceNumber: invoiceId, Booked: true }),
  );
}

async function deletePayment(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id = 'payment-delete',
) {
  return queue.execute(
    { id, operation: 'deleteInvoicePayment', args: [paymentId] },
    async () => undefined,
  );
}

function normalAdapter(events: string[] = []): ShadowAdapter {
  return {
    prepare: (record) => ({ request: { intentId: record.id } }),
    apply: vi.fn(async (record) => {
      events.push(`normal:${record.id}`);
      return { targetId: `normal-target-${record.id}`, receipt: { marker: 'normal-fixture' } };
    }),
  };
}

function paymentAdapter(
  options: {
    apply?: (
      group: ShadowPaymentGroup,
      request: unknown,
    ) => Promise<{ targetId: string; receipt: unknown }>;
    prepare?: (group: ShadowPaymentGroup) => { request: unknown } | { blocked: string };
    verify?: (
      group: ShadowPaymentGroup,
      target: { targetId: string; receipt: unknown },
    ) => Promise<boolean>;
    events?: string[];
  } = {},
): ShadowPaymentAdapter {
  const prepare = vi.fn(
    options.prepare ?? ((group: ShadowPaymentGroup) => ({ request: { groupId: group.id } })),
  );
  const apply = vi.fn(
    options.apply ??
      (async (group: ShadowPaymentGroup) => {
        options.events?.push(`payment:${group.id}`);
        return { targetId: targetPaymentId, receipt: paymentReceipt };
      }),
  );
  return {
    prepare,
    apply,
    ...(options.verify ? { verify: vi.fn(options.verify) } : {}),
  };
}

async function deferCreate(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  normal: ShadowAdapter,
  payments: ShadowPaymentAdapter,
) {
  expect(await queue.drainPaymentAware(normal, payments)).toMatchObject({
    state: 'deferred',
    intentIds: ['payment-create'],
  });
}

describe('durable payment-aware source queue', () => {
  it('retains payment-aware ownership after a source-validation refusal and reopen', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    await queue.execute(
      {
        id: 'invalid-payment',
        operation: 'createInvoicePayment',
        args: [{ InvoiceNumber: invoiceId }],
      },
      async () => ({ Number: paymentId, InvoiceNumber: invoiceId, Booked: 'invalid' }),
    );
    const normal = normalAdapter();
    const payments = paymentAdapter();
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('blocked');
    queue.close();
    queue = await openShadowQueue(root, binding);
    expect(queue.revalidateBlocked('invalid-payment', normal)).toBe(false);
    expect(await queue.drainOne(normal)).toBe(false);
    expect(normal.apply).not.toHaveBeenCalled();
    expect(payments.apply).not.toHaveBeenCalled();
    queue.close();
  });

  it('does not retry a payment group past a newly blocked intervening target', async () => {
    let now = 1000;
    const queue = await openShadowQueue(directory(), binding, () => now);
    await createPayment(queue);
    await queue.execute(
      { id: 'between', operation: 'createCustomer', args: [{ Name: 'Synthetic AB' }] },
      async () => ({ CustomerNumber: 'C-1' }),
    );
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const payments = paymentAdapter({
      apply: async () => {
        throw new TargetNotDispatchedError();
      },
    });
    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('applied');
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('retry');
    expect(await queue.verifyApplied('between', { ...normal, verify: async () => false })).toBe(
      false,
    );
    now += 10_000;
    await queue.drainPaymentAware(normal, payments);
    expect(payments.apply).toHaveBeenCalledTimes(1);
    expect(queue.get('between')?.state).toBe('blocked');
    expect(queue.get('payment-create')?.state).toBe('retry_wait');
    queue.close();
  });

  it('dispatches an already-booked source creation as one single-member group', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      {
        id: 'booked-create',
        operation: 'createInvoicePayment',
        args: [{ InvoiceNumber: invoiceId }],
      },
      async () => ({ Number: paymentId, InvoiceNumber: invoiceId, Booked: true }),
    );
    const payments = paymentAdapter({ verify: async () => true });
    const normal = normalAdapter();
    expect(await queue.drainPaymentAware(normal, payments)).toEqual({
      state: 'applied',
      intentIds: ['booked-create'],
    });
    expect(payments.apply).toHaveBeenCalledTimes(1);
    expect(await queue.verifyPaymentGroup('booked-create', payments)).toBe(true);
    expect(queue.summary().counts.deferred).toBe(0);
    queue.close();
  });

  it.each([1, 'true', {}, []])(
    'requires literal true from a group verifier (%j)',
    async (invalid) => {
      const queue = await openShadowQueue(directory(), binding);
      await createPayment(queue);
      await bookkeepPayment(queue);
      const normal = normalAdapter();
      const payments = paymentAdapter({
        apply: async () => {
          throw new TargetReceiptPendingError(targetPaymentId, paymentReceipt, {
            cause: new Error('synthetic readback'),
          });
        },
        verify: async () => invalid as unknown as boolean,
      });
      await deferCreate(queue, normal, payments);
      await queue.drainPaymentAware(normal, payments);
      expect(await queue.reconcilePaymentGroup('payment-create', payments)).toBe(false);
      expect(queue.summary().counts.target_unknown).toBe(2);
      queue.close();
    },
  );

  it('orders two interleaved payments by their terminal financial positions', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createPayment(queue);
    await queue.execute(
      {
        id: 'second-create',
        operation: 'createInvoicePayment',
        args: [{ InvoiceNumber: invoiceId }],
      },
      async () => ({ Number: '18', InvoiceNumber: invoiceId, Booked: false }),
    );
    await bookkeepPayment(queue);
    await queue.execute(
      { id: 'second-book', operation: 'bookkeepInvoicePayment', args: ['18'] },
      async () => ({ Number: '18', InvoiceNumber: invoiceId, Booked: true }),
    );
    const order: string[] = [];
    const payments = paymentAdapter({
      apply: async (group) => {
        order.push(group.sourcePaymentId);
        return {
          targetId:
            group.sourcePaymentId === '17'
              ? targetPaymentId
              : '66666666-6666-4666-8666-666666666666',
          receipt: paymentReceipt,
        };
      },
    });
    const normal = normalAdapter();
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('deferred');
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('deferred');
    expect(queue.summary().counts.deferred).toBe(2);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('applied');
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('applied');
    expect(order).toEqual(['17', '18']);
    expect(queue.summary().counts.applied).toBe(4);
    queue.close();
  });

  it('refuses a changed prepared request after a proven before-dispatch failure', async () => {
    let now = 1000;
    const queue = await openShadowQueue(directory(), binding, () => now);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const first = paymentAdapter({
      apply: async () => {
        throw new TargetNotDispatchedError();
      },
    });
    await deferCreate(queue, normal, first);
    expect((await queue.drainPaymentAware(normal, first)).state).toBe('retry');
    now = 5000;
    const altered = paymentAdapter({
      prepare: (group) => ({ request: { groupId: group.id, changed: true } }),
    });
    expect((await queue.drainPaymentAware(normal, altered)).state).toBe('blocked');
    expect(queue.summary().counts.blocked).toBe(2);
    expect(altered.apply).not.toHaveBeenCalled();
    expect((await queue.drainPaymentAware(normal, first)).state).toBe('idle');
    queue.close();
  });

  it('rejects stale group reconciliation after another connection completes it', async () => {
    const root = directory();
    const queue = await openShadowQueue(root, binding);
    const other = await openShadowQueue(root, binding);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const pending = paymentAdapter({
      apply: async () => {
        throw new TargetReceiptPendingError(targetPaymentId, paymentReceipt, {
          cause: new Error('synthetic readback'),
        });
      },
    });
    await deferCreate(queue, normal, pending);
    await queue.drainPaymentAware(normal, pending);
    let release!: (value: boolean) => void;
    const delayed = paymentAdapter({
      verify: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const first = queue.reconcilePaymentGroup('payment-create', delayed);
    expect(
      await other.reconcilePaymentGroup(
        'payment-bookkeep',
        paymentAdapter({ verify: async () => true }),
      ),
    ).toBe(true);
    release(true);
    await expect(first).rejects.toThrow('changed');
    expect(queue.summary().counts.applied).toBe(2);
    expect(pending.apply).toHaveBeenCalledTimes(1);
    queue.close();
    other.close();
  });

  it('blocks every applied member on target drift without enabling per-record replay', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const payments = paymentAdapter({ verify: async () => false });
    await deferCreate(queue, normal, payments);
    await queue.drainPaymentAware(normal, payments);
    expect(await queue.verifyPaymentGroup('payment-bookkeep', payments)).toBe(false);
    expect(queue.summary().counts.blocked).toBe(2);
    expect(await queue.drainOne(normal)).toBe(false);
    expect(queue.revalidateBlocked('payment-create', normal)).toBe(false);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('idle');
    expect(payments.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('retains later source work as a separate record when an earlier group completes', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    let release!: (value: { targetId: string; receipt: unknown }) => void;
    const payments = paymentAdapter({
      apply: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await deferCreate(queue, normal, payments);
    const pending = queue.drainPaymentAware(normal, payments);
    await updatePayment(queue, 'later-update');
    release({ targetId: targetPaymentId, receipt: paymentReceipt });
    expect((await pending).state).toBe('applied');
    expect(queue.get('later-update')?.state).toBe('pending');
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('blocked');
    expect(queue.get('later-update')?.state).toBe('blocked');
    expect(payments.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('keeps an unbooked preparation deferred, visible, aged, and durable', async () => {
    let now = 1_000;
    const root = directory();
    let queue = await openShadowQueue(root, binding, () => now);
    await createPayment(queue);
    const normal = normalAdapter();
    const payments = paymentAdapter();

    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('deferred');
    expect(await queue.drainOne(normal)).toBe(false);
    expect(queue.status().counts.deferred).toBe(1);
    now += 8_000;
    expect(queue.summary().oldestUnappliedAgeMs).toBe(8_000);
    expect(payments.apply).not.toHaveBeenCalled();
    queue.close();

    queue = await openShadowQueue(root, binding, () => now);
    expect(queue.status().counts.deferred).toBe(1);
    expect(queue.summary().oldestUnappliedAgeMs).toBe(8_000);
    expect(await queue.drainOne(normal)).toBe(false);
    expect(payments.apply).not.toHaveBeenCalled();
    queue.close();
  });

  it('runs intervening normal work before applying one complete booked payment group', async () => {
    const queue = await openShadowQueue(directory(), binding);
    const events: string[] = [];
    const normal = normalAdapter(events);
    const payments = paymentAdapter({ events });
    await createPayment(queue);
    await queue.execute(
      { id: 'normal-between', operation: 'createCustomer', args: [{ Name: 'Synthetic AB' }] },
      async () => ({ CustomerNumber: 'C-1' }),
    );
    await bookkeepPayment(queue);

    await deferCreate(queue, normal, payments);
    expect(await queue.drainPaymentAware(normal, payments)).toMatchObject({
      state: 'applied',
      intentIds: ['normal-between'],
    });
    expect(events).toEqual(['normal:normal-between']);
    expect(await queue.drainPaymentAware(normal, payments)).toMatchObject({
      state: 'applied',
      intentIds: ['payment-create', 'payment-bookkeep'],
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatch(/^payment:/);
    expect(queue.get('payment-create')?.state).toBe('applied');
    expect(queue.get('payment-bookkeep')?.state).toBe('applied');
    expect(payments.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('cancels an entire never-dispatched source chain after source deletion', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createPayment(queue);
    await updatePayment(queue);
    await deletePayment(queue);
    const normal = normalAdapter();
    const payments = paymentAdapter();

    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('deferred');
    expect(await queue.drainPaymentAware(normal, payments)).toMatchObject({
      state: 'cancelled',
      intentIds: ['payment-create', 'payment-update', 'payment-delete'],
    });
    expect(queue.status().counts.source_cancelled).toBe(3);
    expect(queue.status().items).toHaveLength(3);
    expect(
      queue
        .status()
        .items.every((item) => item.state === 'source_cancelled' && item.targetId === undefined),
    ).toBe(true);
    expect(queue.status().oldestUnappliedAgeMs).toBeNull();
    expect(queue.summary().oldestUnappliedAgeMs).toBeNull();
    expect(payments.prepare).not.toHaveBeenCalled();
    expect(payments.apply).not.toHaveBeenCalled();
    queue.close();
  });

  it('keeps a pre-dispatch retry on the stable group and blocks per-record bypasses', async () => {
    let now = 1_000;
    const root = directory();
    let queue = await openShadowQueue(root, binding, () => now);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const groupIds: string[] = [];
    const payments = paymentAdapter({
      apply: vi.fn(async (group) => {
        groupIds.push(group.id);
        if (groupIds.length === 1) throw new TargetNotDispatchedError();
        return { targetId: targetPaymentId, receipt: paymentReceipt };
      }),
    });
    await deferCreate(queue, normal, payments);
    expect(await queue.drainPaymentAware(normal, payments)).toMatchObject({
      state: 'retry',
      intentIds: ['payment-create', 'payment-bookkeep'],
    });
    const storedGroupId = (
      queue.get('payment-create') as (ShadowRecord & { paymentGroup?: { id: string } }) | undefined
    )?.paymentGroup?.id;
    expect(storedGroupId).toEqual(expect.any(String));
    expect(queue.get('payment-bookkeep')?.state).toBe('retry_wait');
    expect(await queue.drainOne(normal)).toBe(false);
    expect(queue.revalidateBlocked('payment-bookkeep', normal)).toBe(false);
    const individualVerifier = normalAdapter();
    individualVerifier.verify = vi.fn(async () => true);
    await expect(queue.reconcileTarget('payment-bookkeep', individualVerifier)).rejects.toThrow();
    await expect(queue.verifyApplied('payment-bookkeep', individualVerifier)).rejects.toThrow();
    expect(individualVerifier.verify).not.toHaveBeenCalled();
    expect(normal.apply).not.toHaveBeenCalled();
    queue.close();

    now += 1_000;
    queue = await openShadowQueue(root, binding, () => now);
    const retry = await queue.drainPaymentAware(normal, payments);
    expect(retry.state).toBe('applied');
    expect(groupIds).toEqual([storedGroupId, storedGroupId]);
    expect(queue.get('payment-create')?.state).toBe('applied');
    queue.close();
  });

  it('does not replay an uncertain group after reopen while allowing later source progress', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    const upstream = vi.fn(async () => ({
      Number: paymentId,
      InvoiceNumber: invoiceId,
      Booked: false,
    }));
    await queue.execute(
      {
        id: 'payment-create',
        operation: 'createInvoicePayment',
        args: [{ InvoiceNumber: invoiceId }],
      },
      upstream,
    );
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const apply = vi.fn(async () => {
      throw new Error('synthetic uncertain payment group result');
    });
    const payments = paymentAdapter({ apply });
    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('unknown');
    expect(queue.status().counts.target_unknown).toBe(2);
    queue.close();

    queue = await openShadowQueue(root, binding);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('idle');
    expect(queue.status().counts.target_unknown).toBe(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      await queue.execute(
        {
          id: 'payment-create',
          operation: 'createInvoicePayment',
          args: [{ InvoiceNumber: invoiceId }],
        },
        upstream,
      ),
    ).toEqual({ Number: paymentId, InvoiceNumber: invoiceId, Booked: false });
    await queue.execute(
      { id: 'later-source', operation: 'createCustomer', args: [{ Name: 'Later' }] },
      async () => ({ CustomerNumber: 'C-2' }),
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(queue.get('later-source')?.state).toBe('pending');
    queue.close();
  });

  it('persists a common pending receipt and reconciles the group with read-only verification', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const verify = vi.fn<NonNullable<ShadowPaymentAdapter['verify']>>(async () => true);
    const apply = vi.fn(async () => {
      throw new TargetReceiptPendingError(targetPaymentId, paymentReceipt, {
        cause: new Error('synthetic readback outage'),
      });
    });
    const payments = paymentAdapter({ apply, verify });
    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('unknown');
    for (const id of ['payment-create', 'payment-bookkeep']) {
      expect(queue.get(id)).toMatchObject({
        state: 'target_unknown',
        targetId: targetPaymentId,
        targetReceipt: paymentReceipt,
      });
    }
    const individualVerifier = normalAdapter();
    individualVerifier.verify = vi.fn(async () => true);
    await expect(queue.reconcileTarget('payment-create', individualVerifier)).rejects.toThrow();
    expect(individualVerifier.verify).not.toHaveBeenCalled();
    queue.close();

    queue = await openShadowQueue(root, binding);
    expect(await queue.reconcilePaymentGroup('payment-create', payments)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][1]).toEqual({ targetId: targetPaymentId, receipt: paymentReceipt });
    expect(queue.get('payment-create')?.state).toBe('applied');
    expect(queue.get('payment-bookkeep')?.state).toBe('applied');
    expect(await queue.verifyPaymentGroup('payment-bookkeep', payments)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('lets only one connection claim a group apply', async () => {
    const root = directory();
    const first = await openShadowQueue(root, binding);
    const second = await openShadowQueue(root, binding);
    await createPayment(first);
    await bookkeepPayment(first);
    const normal = normalAdapter();
    const payments = paymentAdapter();
    await deferCreate(first, normal, payments);
    let release!: (value: { targetId: string; receipt: unknown }) => void;
    const competingApply = vi.fn(
      () =>
        new Promise<{ targetId: string; receipt: unknown }>((resolve) => {
          release = resolve;
        }),
    );
    const competing = paymentAdapter({ apply: competingApply });
    const firstDrain = first.drainPaymentAware(normal, competing);
    await expect(second.drainPaymentAware(normal, competing)).resolves.not.toMatchObject({
      state: 'applied',
    });
    expect(competingApply).toHaveBeenCalledTimes(1);
    release({ targetId: targetPaymentId, receipt: paymentReceipt });
    expect((await firstDrain).state).toBe('applied');
    expect(competingApply).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
  });

  it('blocks the terminal payment gate while earlier preparations remain visibly deferred', async () => {
    const root = directory();
    const first = await openShadowQueue(root, binding);
    const second = await openShadowQueue(root, binding);
    await createPayment(first);
    await bookkeepPayment(first);
    const normal = normalAdapter();
    const payments = paymentAdapter({
      prepare: vi.fn(() => ({ blocked: 'synthetic apply gate' })),
    });
    await deferCreate(first, normal, payments);
    expect(await first.drainPaymentAware(normal, payments)).toMatchObject({
      state: 'blocked',
      intentIds: ['payment-create', 'payment-bookkeep'],
    });
    expect(first.get('payment-create')?.state).toBe('deferred');
    expect(first.get('payment-bookkeep')?.state).toBe('blocked');
    expect(first.revalidateBlocked('payment-create', normal)).toBe(false);
    expect(first.get('payment-create')?.state).toBe('deferred');
    expect(payments.apply).not.toHaveBeenCalled();
    await second.drainPaymentAware(normal, payments);
    expect(payments.apply).not.toHaveBeenCalled();
    first.close();
    second.close();
  });

  it('passes detached group evidence so callback mutations cannot rewrite durable source rows', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createPayment(queue);
    await updatePayment(queue);
    await bookkeepPayment(queue);
    const normal = normalAdapter();
    const payments = paymentAdapter({
      apply: vi.fn(async (group) => {
        group.members[0].record.args[0] = { InvoiceNumber: 'mutated' };
        (group.members[0].record.sourceResult as Record<string, unknown>).Booked = true;
        (group.sourceResult as Record<string, unknown>).InvoiceNumber = 'mutated';
        group.members.splice(0, group.members.length);
        return { targetId: targetPaymentId, receipt: paymentReceipt };
      }),
    });
    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('deferred');
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('applied');
    expect(queue.get('payment-create')?.args).toEqual([{ InvoiceNumber: invoiceId, Amount: 125 }]);
    expect(queue.get('payment-create')?.sourceResult).toEqual({
      Number: paymentId,
      InvoiceNumber: invoiceId,
      Booked: false,
    });
    expect(queue.get('payment-bookkeep')?.sourceResult).toEqual({
      Number: paymentId,
      InvoiceNumber: invoiceId,
      Booked: true,
    });
    queue.close();
  });

  it('rolls back partial member acknowledgement and retains the known group receipt as unknown', async () => {
    const root = directory();
    const queue = await openShadowQueue(root, binding);
    await createPayment(queue);
    await bookkeepPayment(queue);
    const fault = new DatabaseSync(join(root, 'shadow.sqlite'));
    fault.exec(
      "CREATE TRIGGER fail_second_group_member BEFORE UPDATE ON intents WHEN NEW.id='payment-bookkeep' AND NEW.state='applied' BEGIN SELECT RAISE(FAIL, 'synthetic group acknowledgement fault'); END;",
    );
    const normal = normalAdapter();
    const apply = vi.fn(async () => ({ targetId: targetPaymentId, receipt: paymentReceipt }));
    const payments = paymentAdapter({ apply });
    await deferCreate(queue, normal, payments);
    expect((await queue.drainPaymentAware(normal, payments)).state).toBe('unknown');
    expect(queue.get('payment-create')).toMatchObject({
      state: 'target_unknown',
      targetId: targetPaymentId,
      targetReceipt: paymentReceipt,
    });
    expect(queue.get('payment-bookkeep')).toMatchObject({
      state: 'target_unknown',
      targetId: targetPaymentId,
      targetReceipt: paymentReceipt,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    fault.exec('DROP TRIGGER fail_second_group_member');
    fault.close();
    queue.close();
  });

  it('leaves every group member in flight after a real child process is killed in apply', async () => {
    const root = directory();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/shadow/queue.js')).href;
    const effect = join(root, 'group-effect');
    const script = `
      import { openShadowQueue } from ${JSON.stringify(moduleUrl)};
      import { writeFileSync } from 'node:fs';
      const binding = ${JSON.stringify(binding)};
      const paymentId = ${JSON.stringify(paymentId)};
      const invoiceId = ${JSON.stringify(invoiceId)};
      const q = await openShadowQueue(${JSON.stringify(root)}, binding);
      await q.execute({id:'payment-create',operation:'createInvoicePayment',args:[{InvoiceNumber:invoiceId}]},async()=>({Number:paymentId,InvoiceNumber:invoiceId,Booked:false}));
      await q.execute({id:'payment-bookkeep',operation:'bookkeepInvoicePayment',args:[paymentId]},async()=>({Number:paymentId,InvoiceNumber:invoiceId,Booked:true}));
      const normal = {prepare:()=>({request:{}}),apply:async()=>({targetId:'unused',receipt:{}})};
      const payments = {prepare:(group)=>({request:{groupId:group.id}}),apply:async()=>{writeFileSync(${JSON.stringify(effect)},'once');process.kill(process.pid,'SIGKILL');return new Promise(()=>{});}};
      await q.drainPaymentAware(normal,payments);
      await q.drainPaymentAware(normal,payments);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { HOME: root, PATH: '/usr/bin:/bin', CI: '1', NO_COLOR: '1' },
      timeout: 10_000,
      encoding: 'utf8',
    });
    expect(child.signal, child.stderr).toBe('SIGKILL');
    expect(readFileSync(effect, 'utf8')).toBe('once');
    const queue = await openShadowQueue(root, binding);
    expect(queue.status().counts.target_in_flight).toBe(2);
    const apply = vi.fn();
    const normal = normalAdapter();
    expect((await queue.drainPaymentAware(normal, paymentAdapter({ apply }))).state).toBe('idle');
    expect(apply).not.toHaveBeenCalled();
    expect(existsSync(effect)).toBe(true);
    queue.close();
  });
});
