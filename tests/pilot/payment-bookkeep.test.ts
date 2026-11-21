import { describe, expect, it } from 'vitest';
import {
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
  statusCommand,
} from '../../src/pilot/commands.js';
import { preflightStagedCall, type PreflightDeps } from '../../src/pilot/preflight.js';
import {
  ARTICLE_UUID,
  BASE_TIME,
  COMPANY,
  ORG,
  connect,
  invoiceArgs,
  makeHost,
  stagedCreate,
  textOf,
} from './helpers.js';

type Made = Awaited<ReturnType<typeof makeHost>>;

async function drainNext(h: Made) {
  const id = h.host.queue.snapshot().at(-1)!.record.id;
  const preview = await previewCommand(h.host, id);
  const drained = await drainOneCommand(h.host, id, preview.hash!);
  expect(drained.ok, drained.message).toBe(true);
}
/** Pilot host with payments enabled and an applied strict invoice "1" (total 125). */
async function withInvoice(enableInvoicePayments = true): Promise<Made> {
  const h = await makeHost({ enableInvoicePayments });
  expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
  await drainNext(h);
  expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(true);
  await drainNext(h);
  const client = await connect(h.host);
  const created = await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
  expect(created.isError, textOf(created)).not.toBe(true);
  await client.close();
  await drainNext(h);
  return h;
}
const payArgs = { InvoiceNumber: 1, Amount: 125, PaymentDate: '2026-11-05' };
async function stagePayment(h: Made) {
  const client = await connect(h.host);
  const result = await stagedCreate(client, 'fortnox_create_invoice_payment', payArgs);
  await client.close();
  return result;
}
async function stageBookkeep(h: Made, paymentNumber = '1') {
  const client = await connect(h.host);
  const result = await stagedCreate(client, 'fortnox_bookkeep_invoice_payment', { paymentNumber });
  await client.close();
  return result;
}
const depsOf = (h: Made): PreflightDeps => ({
  binding: { sourceCompany: ORG, targetCompany: COMPANY },
  adapterFor: (name) => h.host.adapterFor(name),
  resolveIdentity: (resource, id) => h.host.queue.resolveIdentity(resource, id),
  getRecord: (id) => h.host.queue.get(id),
  records: () => h.host.queue.snapshot().map(({ record }) => record),
  now: () => BASE_TIME,
});
const check = (h: Made, args: Record<string, unknown>) =>
  preflightStagedCall(depsOf(h), 'bookkeepInvoicePayment', args);
const unbooked = {
  Number: '1',
  InvoiceNumber: '1',
  Amount: 125,
  PaymentDate: '2026-11-05',
  Booked: false,
};
async function createRecord(h: Made, id = 'pay-1', receipt: unknown = unbooked) {
  await h.host.queue.execute(
    { id, operation: 'createInvoicePayment', args: [payArgs] },
    async () => receipt,
  );
}

describe('bookkeep preflight (NOX-211 step 2)', () => {
  it('accepts the bookkeeping of the one unbooked mirrored payment', async () => {
    const h = await withInvoice();
    await createRecord(h);
    expect(check(h, { paymentNumber: '1', confirm: true })).toBeUndefined();
  });

  it.each([
    [{ paymentNumber: '01' }, /paymentNumber/],
    [{ paymentNumber: '' }, /paymentNumber/],
    [{ paymentNumber: 1 }, /paymentNumber/],
    [{ paymentNumber: '1', extra: true }, /Unsupported bookkeep input fields: extra/],
  ])('refuses invalid input %j', async (args, reason) => {
    const h = await withInvoice();
    await createRecord(h);
    expect(check(h, args)).toMatch(reason);
  });

  it('refuses a payment that was not created through the pilot', async () => {
    const h = await withInvoice();
    expect(check(h, { paymentNumber: '1' })).toMatch(/Payment 1 has no pilot create record/);
  });

  it('refuses a payment whose create receipt is already booked', async () => {
    const h = await withInvoice();
    await createRecord(h, 'pay-1', { ...unbooked, Booked: true });
    expect(check(h, { paymentNumber: '1' })).toMatch(/is already booked/);
  });

  it('refuses a second bookkeeping of the same payment', async () => {
    const h = await withInvoice();
    await createRecord(h);
    await h.host.queue.execute(
      { id: 'book-1', operation: 'bookkeepInvoicePayment', args: ['1'] },
      async () => ({ ...unbooked, Booked: true }),
    );
    expect(check(h, { paymentNumber: '1' })).toMatch(/already has payment record book-1/);
  });

  it('refuses bookkeeping a second payment of the same invoice', async () => {
    const h = await withInvoice();
    await createRecord(h);
    const record = h.host.queue.get('pay-1')!;
    expect(record.state).toBe('pending');
    await h.host.queue.execute(
      { id: 'pay-2', operation: 'createInvoicePayment', args: [payArgs] },
      async () => ({ ...unbooked, Number: '2' }),
    );
    expect(check(h, { paymentNumber: '2' })).toMatch(/Invoice 1 already has payment record pay-1/);
  });

  it('refuses a payment on a credited invoice', async () => {
    const h = await withInvoice();
    await createRecord(h);
    await h.host.queue.execute(
      { id: 'credit-1', operation: 'creditInvoice', args: ['1'] },
      async () => ({ DocumentNumber: '1', CreditInvoiceReference: '2', Credit: 'false' }),
    );
    expect(check(h, { paymentNumber: '1' })).toMatch(/PAYMENT_INVOICE_CREDITED/);
  });

  it('refuses a create receipt whose amount is not the mirrored invoice total', async () => {
    const h = await withInvoice();
    await createRecord(h, 'pay-1', { ...unbooked, Amount: 100 });
    expect(check(h, { paymentNumber: '1' })).toMatch(/exact full payment/);
  });

  it('blocks while a payment record carries a malformed payment number', async () => {
    const h = await withInvoice();
    await createRecord(h);
    await h.host.queue.execute(
      { id: 'pay-x', operation: 'updateInvoicePayment', args: ['01', {}] },
      async () => ({}),
    );
    expect(check(h, { paymentNumber: '1' })).toMatch(/pay-x has a malformed payment number/);
  });
});

describe('pilot payment staging behind the host flag (NOX-211 step 2)', () => {
  it('is off by default: neither payment tool can be prepared', async () => {
    const h = await withInvoice(false);
    expect(textOf(await stagePayment(h))).toMatch(/outside staged contract/);
    expect(textOf(await stageBookkeep(h))).toMatch(/outside staged contract/);
  });

  it('when enabled, stages a full payment and then its bookkeeping, both journaled', async () => {
    const h = await withInvoice();
    const created = await stagePayment(h);
    expect(created.isError, textOf(created)).not.toBe(true);
    const create = h.host.queue.snapshot().at(-1)!.record;
    expect(create).toMatchObject({ operation: 'createInvoicePayment', state: 'pending' });
    expect(create.sourceResult).toMatchObject({ Booked: false, InvoiceNumber: 1, Number: 1 });
    // A second payment of the same invoice is refused before Fortnox is contacted.
    const again = await stagePayment(h);
    expect(textOf(again)).toMatch(/already has payment record/);

    const booked = await stageBookkeep(h, '1');
    expect(booked.isError, textOf(booked)).not.toBe(true);
    const bookkeep = h.host.queue.snapshot().at(-1)!.record;
    expect(bookkeep).toMatchObject({ operation: 'bookkeepInvoicePayment', state: 'pending' });
    expect(bookkeep.sourceResult).toMatchObject({
      Booked: true,
      VoucherSeries: 'D',
      VoucherNumber: 1,
      VoucherYear: 1,
    });
    expect(h.synthetic.state.vouchers.get('1:D:1')).toMatchObject({
      ReferenceType: 'INVOICEPAYMENT',
      ReferenceNumber: '1',
    });
    expect(textOf(await stageBookkeep(h, '1'))).toMatch(/already has payment record/);
    // Completed staged payment writes satisfy the journal check (the gate still opens).
    expect((await h.host.checkIntegrity()).ok).toBe(true);
    expect((await statusCommand(h.host)).ok).toBe(true);
  });
});
