import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  baselineCustomerCommand,
  captureCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
  reconcileCommand,
  refuseCommand,
} from '../../src/pilot/commands.js';
import { journalPath } from '../../src/pilot/journal.js';
import { TargetReceiptPendingError } from '../../src/shadow/types.js';
import type { ShadowPaymentAdapter, ShadowPaymentGroup } from '../../src/shadow/types.js';
import { ARTICLE_UUID, connect, invoiceArgs, makeHost, stagedCreate, textOf } from './helpers.js';

type Made = Awaited<ReturnType<typeof makeHost>>;

async function drainNext(h: Made) {
  const id = h.host.queue.snapshot().at(-1)!.record.id;
  const preview = await previewCommand(h.host, id);
  const drained = await drainOneCommand(h.host, id, preview.hash!);
  expect(drained.ok, drained.message).toBe(true);
}
function fakeAdapter(events: string[] = []): ShadowPaymentAdapter {
  return {
    prepare: vi.fn((group: ShadowPaymentGroup) => ({
      request: { group: group.id, invoice: group.sourceInvoiceId },
    })),
    apply: vi.fn(async () => {
      events.push('apply');
      return { targetId: '55555555-5555-4555-8555-555555555555', receipt: { ok: true } };
    }),
  };
}
/** Payments enabled, applied invoice 1, staged create + bookkeep of payment 1. */
async function withBookedPayment(paymentAdapter?: ShadowPaymentAdapter): Promise<Made> {
  const h = await makeHost({
    enableInvoicePayments: true,
    ...(paymentAdapter ? { paymentAdapter } : {}),
  });
  expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
  await drainNext(h);
  expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(true);
  await drainNext(h);
  const client = await connect(h.host);
  for (const [tool, args] of [
    ['fortnox_create_invoice', invoiceArgs()],
    [
      'fortnox_create_invoice_payment',
      { InvoiceNumber: 1, Amount: 125, PaymentDate: '2026-11-05' },
    ],
    ['fortnox_bookkeep_invoice_payment', { paymentNumber: '1' }],
  ] as const) {
    const result = await stagedCreate(client, tool, args);
    expect(result.isError, textOf(result)).not.toBe(true);
    if (tool === 'fortnox_create_invoice') await drainNext(h);
  }
  await client.close();
  return h;
}
const ids = (h: Made) => {
  const records = h.host.queue.snapshot().map(({ record }) => record);
  return {
    create: records.find((r) => r.operation === 'createInvoicePayment')!.id,
    book: records.find((r) => r.operation === 'bookkeepInvoicePayment')?.id,
  };
};
const journalTargets = (h: Made) =>
  readFileSync(journalPath(h.host.directory), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; intentId?: string })
    .filter((entry) => entry.kind === 'target')
    .map((entry) => entry.intentId);

describe('pilot preview and drain-one of a payment group (NOX-211 step 3)', () => {
  it('previews the whole group, then drains it once, journaling every member first', async () => {
    const events: string[] = [];
    const adapter = fakeAdapter(events);
    const h = await withBookedPayment(adapter);
    const { create } = ids(h);
    const book = ids(h).book!;
    const preview = await previewCommand(h.host, create);
    expect(preview.ok, preview.message).toBe(true);
    expect(preview.message).toMatch(new RegExp(`members: ${create}, ${book}`));
    expect(h.host.queue.get(create)!.state).toBe('pending');
    const before = journalTargets(h).length;

    const drained = await drainOneCommand(h.host, create, preview.hash!);
    expect(drained.ok, drained.message).toBe(true);
    expect(drained.message).toMatch(/applied/);
    expect(h.host.queue.get(create)!.state).toBe('applied');
    expect(h.host.queue.get(book)!.state).toBe('applied');
    expect(journalTargets(h).slice(before)).toEqual([create, book]);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    // Journal and queue agree afterwards: the gate opens again.
    expect((await h.host.checkGate()).ok).toBe(true);
    // A second drain finds nothing to claim.
    const again = await drainOneCommand(h.host, create, preview.hash!);
    expect(again.ok).toBe(false);
  });

  it('refuses a hash that is not the stored preview, and changes nothing', async () => {
    const adapter = fakeAdapter();
    const h = await withBookedPayment(adapter);
    const { create } = ids(h);
    await previewCommand(h.host, create);
    const refused = await drainOneCommand(h.host, create, 'a'.repeat(64));
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/hash does not match the stored preview/);
    expect(h.host.queue.get(create)!.state).toBe('pending');
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('refuses when the payment in Fortnox no longer matches its receipt', async () => {
    const adapter = fakeAdapter();
    const h = await withBookedPayment(adapter);
    const book = ids(h).book!;
    const preview = await previewCommand(h.host, book);
    h.synthetic.state.payments.get('1')!.Amount = 100;
    const refused = await drainOneCommand(h.host, book, preview.hash!);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/Fortnox payment 1 changed since bookkeeping/);
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('refuses a payment that awaits bookkeeping without leaving it deferred', async () => {
    const h = await makeHost({ enableInvoicePayments: true, paymentAdapter: fakeAdapter() });
    expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
    await drainNext(h);
    expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(true);
    await drainNext(h);
    const client = await connect(h.host);
    expect((await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs())).isError).not.toBe(
      true,
    );
    await drainNext(h);
    await stagedCreate(client, 'fortnox_create_invoice_payment', {
      InvoiceNumber: 1,
      Amount: 125,
      PaymentDate: '2026-11-05',
    });
    await client.close();
    const { create } = ids(h);
    const preview = await previewCommand(h.host, create);
    expect(preview.ok).toBe(false);
    expect(preview.message).toMatch(/awaits bookkeeping/);
    expect(h.host.queue.get(create)!.state).toBe('pending');
    expect((await h.host.checkGate()).ok).toBe(true);
  });

  it('with the real adapter, refuses before a claim: no captured voucher, then no issued invoice', async () => {
    const h = await withBookedPayment();
    const { create } = ids(h);
    const book = ids(h).book!;
    const first = await previewCommand(h.host, create);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/voucher has not been captured/);
    expect((await captureCommand(h.host, book)).ok).toBe(true);
    const second = await previewCommand(h.host, create);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/PAYMENT_INVOICE_NOT_ISSUED/);
    expect(h.host.queue.get(create)!.state).toBe('pending');
    expect(h.accounted.calls.filter((c) => c.url.includes('mark-paid'))).toEqual([]);
  });

  it('does not write a preview file for a refused payment preview', async () => {
    const h = await withBookedPayment();
    const { create } = ids(h);
    await previewCommand(h.host, create);
    expect(() => readFileSync(join(h.host.directory, 'previews', `${create}.json`))).toThrow();
  });
});

describe('pilot refuse and reconcile of a payment group (NOX-211 step 4)', () => {
  it('refuses the whole group, journals each member, and the gate opens again', async () => {
    const h = await withBookedPayment();
    const { create } = ids(h);
    const book = ids(h).book!;
    const callsBefore = h.accounted.calls.length;
    const result = await refuseCommand(h.host, book, 'settled by hand');
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toMatch(new RegExp(`${create}, ${book}: blocked`));
    expect(h.host.queue.get(create)!.state).toBe('blocked');
    expect(h.host.queue.get(book)!.state).toBe('blocked');
    const refused = readFileSync(journalPath(h.host.directory), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; intentId?: string })
      .filter((entry) => entry.kind === 'refused')
      .map((entry) => entry.intentId);
    expect(refused).toEqual([create, book]);
    expect((await h.host.checkGate()).ok).toBe(true);
    expect(h.accounted.calls.slice(callsBefore)).toEqual([]);
  });

  it('does not refuse a group that the adapter can map', async () => {
    const h = await withBookedPayment(fakeAdapter());
    const { create } = ids(h);
    const result = await refuseCommand(h.host, create, 'x');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/mappable/);
  });

  it.each([
    [true, 'applied'],
    [false, 'target_unknown'],
  ])('reconciles a target_unknown group read-only (verify=%s)', async (matches, state) => {
    const adapter = fakeAdapter();
    adapter.apply = vi.fn(async () => {
      throw new TargetReceiptPendingError('55555555-5555-4555-8555-555555555555', { ok: true });
    });
    adapter.verify = vi.fn(async () => matches);
    const h = await withBookedPayment(adapter);
    const { create } = ids(h);
    const book = ids(h).book!;
    const preview = await previewCommand(h.host, create);
    const drained = await drainOneCommand(h.host, create, preview.hash!);
    expect(drained.ok).toBe(false);
    expect(h.host.queue.get(book)!.state).toBe('target_unknown');
    const result = await reconcileCommand(h.host, book);
    expect(result.ok, result.message).toBe(matches);
    expect(h.host.queue.get(create)!.state).toBe(state);
    expect(h.host.queue.get(book)!.state).toBe(state);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
  });
});
