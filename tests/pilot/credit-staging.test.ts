import { describe, expect, it } from 'vitest';
import {
  baselineCustomerCommand,
  captureCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
} from '../../src/pilot/commands.js';
import { preflightStagedCall, type PreflightDeps } from '../../src/pilot/preflight.js';
import type { ShadowRecord } from '../../src/shadow/types.js';
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
async function withInvoice(enableInvoiceCredits = true): Promise<Made> {
  const h = await makeHost({ enableInvoiceCredits });
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
const issueRecord = (overrides: Partial<ShadowRecord> = {}): ShadowRecord => ({
  version: 1,
  sourceCompany: ORG,
  targetCompany: COMPANY,
  id: 'issue-1',
  operation: 'markInvoicePrinted',
  args: ['1'],
  requestHash: 'h',
  state: 'applied',
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME,
  ...overrides,
});
/** Preflight deps over the host queue plus extra synthetic records. */
const depsOf = (h: Made, extra: ShadowRecord[] = []): PreflightDeps => ({
  binding: { sourceCompany: ORG, targetCompany: COMPANY },
  adapterFor: (name) => h.host.adapterFor(name),
  resolveIdentity: (resource, id) => h.host.queue.resolveIdentity(resource, id),
  getRecord: (id) => h.host.queue.get(id),
  records: () => [...h.host.queue.snapshot().map(({ record }) => record), ...extra],
  now: () => BASE_TIME,
});
const check = (h: Made, args: Record<string, unknown>, extra: ShadowRecord[] = []) =>
  preflightStagedCall(depsOf(h, extra), 'creditInvoice', args);

describe('credit preflight (NOX-212)', () => {
  it('accepts the full credit of a mirrored, issued, unpaid invoice', async () => {
    const h = await withInvoice();
    expect(check(h, { documentNumber: '1', confirm: true }, [issueRecord()])).toBeUndefined();
  });

  it('refuses while the pilot cannot have issued the original', async () => {
    const h = await withInvoice();
    expect(check(h, { documentNumber: '1' })).toMatch(/CREDIT_ORIGINAL_NOT_ISSUED/);
    expect(check(h, { documentNumber: '1' }, [issueRecord({ state: 'pending' })])).toMatch(
      /CREDIT_ORIGINAL_NOT_ISSUED/,
    );
  });

  it.each([
    [{ documentNumber: '01' }, /documentNumber/],
    [{ documentNumber: 1 }, /documentNumber/],
    [{ documentNumber: '1', extra: 1 }, /Unsupported credit input fields: extra/],
    [{ documentNumber: '2' }, /Invoice 2 is not mirrored/],
  ])('refuses invalid input %j', async (args, reason) => {
    const h = await withInvoice();
    expect(check(h, args, [issueRecord()])).toMatch(reason);
  });

  it('refuses a second credit and a credit of a paid invoice', async () => {
    const h = await withInvoice();
    const credit = issueRecord({ id: 'credit-1', operation: 'creditInvoice', state: 'pending' });
    expect(check(h, { documentNumber: '1' }, [issueRecord(), credit])).toMatch(
      /CREDIT_DUPLICATE: Invoice 1 already has credit record credit-1/,
    );
    const payment = issueRecord({
      id: 'pay-1',
      operation: 'createInvoicePayment',
      args: [{ InvoiceNumber: 1 }],
      state: 'pending',
    });
    expect(check(h, { documentNumber: '1' }, [issueRecord(), payment])).toMatch(
      /Invoice 1 has payment record pay-1/,
    );
  });
});

describe('pilot credit staging behind the host flag (NOX-212)', () => {
  it('is off by default', async () => {
    const h = await withInvoice(false);
    const client = await connect(h.host);
    const result = await stagedCreate(client, 'fortnox_credit_invoice', { documentNumber: '1' });
    expect(textOf(result)).toMatch(/outside staged contract/);
    await client.close();
  });

  it('when enabled, still refuses before Fortnox while the original is not issued', async () => {
    const h = await withInvoice();
    const client = await connect(h.host);
    const result = await stagedCreate(client, 'fortnox_credit_invoice', { documentNumber: '1' });
    expect(textOf(result)).toMatch(/CREDIT_ORIGINAL_NOT_ISSUED/);
    await client.close();
    expect(h.synthetic.state.requests.some((r) => r.endsWith('/credit'))).toBe(false);
  });

  it('a credit record is captured and previewed by the credit adapter, which refuses it unissued', async () => {
    const h = await withInvoice();
    // A credit made outside the pilot (synthetic Fortnox), recorded as the queue would record it.
    const original = await h.host.operations.creditInvoice('1');
    expect(original).toMatchObject({ DocumentNumber: '1', CreditInvoiceReference: '2' });
    expect(h.synthetic.state.invoices.get('2')).toMatchObject({
      Credit: 'true',
      CreditInvoiceReference: '0',
      InvoiceReference: '1',
      Total: -125,
    });
    await h.host.queue.execute(
      { id: 'credit-1', operation: 'creditInvoice', args: ['1'] },
      async () => original,
    );
    expect((await captureCommand(h.host, 'credit-1')).ok).toBe(true);
    const preview = await previewCommand(h.host, 'credit-1');
    expect(preview.ok).toBe(false);
    expect(preview.message).toMatch(/CREDIT_ORIGINAL_NOT_ISSUED/);
    expect(h.host.queue.get('credit-1')!.state).toBe('pending');
  });
});
