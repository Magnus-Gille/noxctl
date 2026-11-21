import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalEncode } from '../../src/shadow/codec.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { TargetNotDispatchedError } from '../../src/shadow/types.js';
import type {
  ShadowPaymentAdapter,
  ShadowPaymentGroup,
  ShadowRecord,
} from '../../src/shadow/types.js';

const binding = { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function open() {
  const root = mkdtempSync(join(tmpdir(), 'payment-expected-'));
  roots.push(root);
  return openShadowQueue(root, binding, () => 1_000);
}
type Queue = Awaited<ReturnType<typeof open>>;
const create = (q: Queue, id = 'create') =>
  q.execute(
    { id, operation: 'createInvoicePayment', args: [{ InvoiceNumber: '42', Amount: 125 }] },
    async () => ({ Number: '17', InvoiceNumber: '42', Booked: false }),
  );
const bookkeep = (q: Queue, id = 'book') =>
  q.execute({ id, operation: 'bookkeepInvoicePayment', args: ['17'] }, async () => ({
    Number: '17',
    InvoiceNumber: '42',
    Booked: true,
  }));
function adapter(options: Partial<ShadowPaymentAdapter> = {}): ShadowPaymentAdapter {
  return {
    prepare: vi.fn((group: ShadowPaymentGroup) => ({ request: { groupId: group.id } })),
    apply: vi.fn(async () => ({ targetId: 'target-1', receipt: { ok: true } })),
    ...options,
  };
}
const digestOf = (group: ShadowPaymentGroup, request: unknown) =>
  createHash('sha256')
    .update(
      canonicalEncode({
        ids: group.members.map((m) => [m.record.id, m.record.requestHash]),
        request,
      }),
    )
    .digest('hex');
const states = (q: Queue) => q.snapshot().map(({ record }) => `${record.id}:${record.state}`);

describe('hash-bound payment group drain (NOX-211 step 3)', () => {
  it('previews a booked group without changing the queue', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const a = adapter();
    const preview = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf },
      'preview',
    );
    expect(preview).toMatchObject({ claimed: false, preview: true });
    if (!('preview' in preview)) throw new Error('no preview');
    expect(preview.group.members.map((m) => m.record.id)).toEqual(['create', 'book']);
    expect(preview.digest).toBe(digestOf(preview.group, preview.request));
    expect(states(q)).toEqual(['create:pending', 'book:pending']);
    expect(a.apply).not.toHaveBeenCalled();
    q.close();
  });

  it('drains the previewed group, running beforeApply for the claimed group first', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const events: string[] = [];
    const a = adapter({
      apply: vi.fn(async () => {
        events.push('apply');
        return { targetId: 'target-1', receipt: { ok: true } };
      }),
    });
    const preview = await q.drainPaymentGroupExpected(a, { memberId: 'book', digestOf }, 'preview');
    if (!('preview' in preview)) throw new Error('no preview');
    const result = await q.drainPaymentGroupExpected(
      a,
      {
        memberId: 'book',
        digestOf,
        expectedDigest: preview.digest,
        beforeApply: (group: ShadowPaymentGroup) => {
          events.push(
            `journal:${group.members.map((m) => `${m.record.id}/${m.record.state}/${m.record.targetAttempts}`).join(',')}`,
          );
        },
      },
      'drain',
    );
    expect(result).toEqual({ claimed: true, state: 'applied', intentIds: ['create', 'book'] });
    expect(events).toEqual(['journal:create/target_in_flight/1,book/target_in_flight/1', 'apply']);
    expect(states(q)).toEqual(['create:applied', 'book:applied']);
    q.close();
  });

  it('claims nothing when the digest differs, and leaves no deferred record behind', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const a = adapter();
    const result = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf, expectedDigest: 'f'.repeat(64) },
      'drain',
    );
    expect(result).toEqual({
      claimed: false,
      reason: expect.stringMatching(/differs from the previewed/),
    });
    expect(states(q)).toEqual(['create:pending', 'book:pending']);
    expect(a.apply).not.toHaveBeenCalled();
    q.close();
  });

  it('refuses a payment that still awaits bookkeeping, without deferring it', async () => {
    const q = await open();
    await create(q);
    const result = await q.drainPaymentGroupExpected(
      adapter(),
      { memberId: 'create', digestOf },
      'preview',
    );
    expect(result).toEqual({ claimed: false, reason: expect.stringMatching(/awaits bookkeeping/) });
    expect(states(q)).toEqual(['create:pending']);
    q.close();
  });

  it('refuses an id that is not a member of the next payment group', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const result = await q.drainPaymentGroupExpected(
      adapter(),
      { memberId: 'other', digestOf },
      'preview',
    );
    expect(result).toEqual({ claimed: false, reason: expect.stringMatching(/not a member/) });
    q.close();
  });

  it('refuses when the next record is ordinary', async () => {
    const q = await open();
    await q.execute({ id: 'cust', operation: 'createCustomer', args: [{}] }, async () => ({}));
    await create(q);
    await bookkeep(q);
    const result = await q.drainPaymentGroupExpected(
      adapter(),
      { memberId: 'create', digestOf },
      'preview',
    );
    expect(result).toEqual({
      claimed: false,
      reason: expect.stringMatching(/cust is not a payment/),
    });
    q.close();
  });

  it('reports a mapping refusal without persisting it', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const a = adapter({ prepare: () => ({ blocked: 'voucher not captured' }) });
    const result = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf },
      'preview',
    );
    expect(result).toEqual({
      claimed: false,
      reason: expect.stringMatching(/voucher not captured/),
    });
    expect(states(q)).toEqual(['create:pending', 'book:pending']);
    q.close();
  });

  it('a beforeApply that throws TargetNotDispatchedError leaves the group in retry_wait, nothing sent', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const a = adapter();
    const preview = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf },
      'preview',
    );
    if (!('preview' in preview)) throw new Error('no preview');
    const result = await q.drainPaymentGroupExpected(
      a,
      {
        memberId: 'create',
        digestOf,
        expectedDigest: preview.digest,
        beforeApply: () => {
          throw new TargetNotDispatchedError('journal down');
        },
      },
      'drain',
    );
    expect(result).toMatchObject({ claimed: true, state: 'retry' });
    expect(states(q)).toEqual(['create:retry_wait', 'book:retry_wait']);
    expect(a.apply).not.toHaveBeenCalled();
    // The resumed group previews with the same digest once the retry is due.
    const resumed = q.get('create') as ShadowRecord;
    expect(resumed.paymentGroup).toBeDefined();
    q.close();
  });

  it('a thrown apply error leaves the group target_unknown', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    const a = adapter({
      apply: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const preview = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf },
      'preview',
    );
    if (!('preview' in preview)) throw new Error('no preview');
    const result = await q.drainPaymentGroupExpected(
      a,
      { memberId: 'create', digestOf, expectedDigest: preview.digest },
      'drain',
    );
    expect(result).toMatchObject({ claimed: true, state: 'unknown' });
    expect(states(q)).toEqual(['create:target_unknown', 'book:target_unknown']);
    q.close();
  });
});

describe('operator refusal of a payment chain (NOX-211 step 4)', () => {
  it('refuses the whole booked group when the mapping refuses it, and the queue moves on', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    await q.execute({ id: 'cust', operation: 'createCustomer', args: [{}] }, async () => ({}));
    const a = adapter({ prepare: () => ({ blocked: 'rounding' }) });
    const result = q.refusePaymentChain('book', 'manual settlement', a);
    expect(result).toEqual({ ok: true, ids: ['create', 'book'], mappingReason: 'rounding' });
    expect(states(q)).toEqual(['create:blocked', 'book:blocked', 'cust:pending']);
    expect(q.get('create')!.reason).toMatch(
      /^OPERATOR_REFUSED: manual settlement \(mapping: rounding\)/,
    );
    // The next decision is the ordinary record after the refused chain.
    const next = await q.drainPaymentGroupExpected(
      adapter(),
      { memberId: 'create', digestOf },
      'preview',
    );
    expect(next).toEqual({
      claimed: false,
      reason: expect.stringMatching(/cust is not a payment/),
    });
    q.close();
  });

  it('refuses a payment that awaits bookkeeping', async () => {
    const q = await open();
    await create(q);
    const result = q.refusePaymentChain('create', 'never booked', adapter());
    expect(result).toEqual({
      ok: true,
      ids: ['create'],
      mappingReason: 'payment awaits bookkeeping',
    });
    expect(states(q)).toEqual(['create:blocked']);
    q.close();
  });

  it('does not refuse a mappable group, a non-member or a dispatched group', async () => {
    const q = await open();
    await create(q);
    await bookkeep(q);
    expect(q.refusePaymentChain('create', 'x', adapter())).toEqual({
      ok: false,
      reason: expect.stringMatching(/mappable; use preview and drain-one/),
    });
    expect(
      q.refusePaymentChain('other', 'x', adapter({ prepare: () => ({ blocked: 'b' }) })),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/not a member/),
    });
    const preview = await q.drainPaymentGroupExpected(
      adapter(),
      { memberId: 'create', digestOf },
      'preview',
    );
    if (!('preview' in preview)) throw new Error('no preview');
    await q.drainPaymentGroupExpected(
      adapter({
        apply: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
      { memberId: 'create', digestOf, expectedDigest: preview.digest },
      'drain',
    );
    expect(
      q.refusePaymentChain('create', 'x', adapter({ prepare: () => ({ blocked: 'b' }) })),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/no payment chain can be refused|target contact/),
    });
    expect(states(q)).toEqual(['create:target_unknown', 'book:target_unknown']);
    q.close();
  });
});
