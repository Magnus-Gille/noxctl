import { describe, expect, it } from 'vitest';
import {
  baselineCustomerCommand,
  captureCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
} from '../../src/pilot/commands.js';
import { createAccountedClient } from '../../src/pilot/accounted-client.js';
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
type Flags = Parameters<typeof makeHost>[0];

async function drainNext(h: Made) {
  const id = h.host.queue.snapshot().at(-1)!.record.id;
  const preview = await previewCommand(h.host, id);
  expect(preview.ok, preview.message).toBe(true);
  const drained = await drainOneCommand(h.host, id, preview.hash!);
  expect(drained.ok, drained.message).toBe(true);
}
async function withInvoice(flags: Flags = { enableInvoiceIssue: true }): Promise<Made> {
  const h = await makeHost(flags);
  expect((await baselineCustomerCommand(h.host, '1')).ok).toBe(true);
  await drainNext(h);
  expect((await linkArticleCommand(h.host, 'A-1', ARTICLE_UUID)).ok).toBe(true);
  await drainNext(h);
  await stage(h, 'fortnox_create_invoice', invoiceArgs());
  await drainNext(h);
  return h;
}
async function stage(
  h: Made,
  tool: Parameters<typeof stagedCreate>[1],
  args: Record<string, unknown>,
) {
  const client = await connect(h.host);
  const result = await stagedCreate(client, tool, args);
  await client.close();
  return result;
}
const issueArgs = { documentNumber: '1', markSent: true };
const depsOf = (h: Made): PreflightDeps => ({
  binding: { sourceCompany: ORG, targetCompany: COMPANY },
  adapterFor: (name) => h.host.adapterFor(name),
  resolveIdentity: (resource, id) => h.host.queue.resolveIdentity(resource, id),
  getRecord: (id) => h.host.queue.get(id),
  records: () => h.host.queue.snapshot().map(({ record }) => record),
  now: () => BASE_TIME,
});
const check = (h: Made, args: Record<string, unknown>) =>
  preflightStagedCall(depsOf(h), 'markInvoicePrinted', args);

describe('issue preflight (NOX-211/212 issue stage)', () => {
  it('accepts marking a mirrored invoice as sent', async () => {
    const h = await withInvoice();
    expect(check(h, { ...issueArgs, confirm: true })).toBeUndefined();
  });

  it.each([
    [{ documentNumber: '1' }, /markSent must be true/],
    [{ documentNumber: '1', markSent: false }, /markSent must be true/],
    [{ ...issueArgs, outputPath: '/tmp/x.pdf' }, /Unsupported issue input fields: outputPath/],
    [{ ...issueArgs, overwrite: true }, /Unsupported issue input fields: overwrite/],
    [{ ...issueArgs, documentNumber: '01' }, /documentNumber/],
    [{ ...issueArgs, documentNumber: '2' }, /Invoice 2 is not mirrored/],
  ])('refuses %j', async (args, reason) => {
    const h = await withInvoice();
    expect(check(h, args)).toMatch(reason);
  });

  it('refuses a second issue of the same invoice', async () => {
    const h = await withInvoice();
    await h.host.queue.execute(
      { id: 'issue-x', operation: 'markInvoicePrinted', args: ['1'] },
      async () => ({}),
    );
    expect(check(h, issueArgs)).toMatch(/Invoice 1 already has issue record issue-x/);
  });
});

describe('pilot issue stage behind the host flag', () => {
  it('is off by default', async () => {
    const h = await withInvoice({});
    expect(textOf(await stage(h, 'fortnox_invoice_pdf', issueArgs))).toMatch(
      /outside staged contract/,
    );
  });

  it('issues a mirrored invoice in Fortnox and then in Accounted, read back as sent', async () => {
    const h = await withInvoice();
    const staged = await stage(h, 'fortnox_invoice_pdf', issueArgs);
    expect(staged.isError, textOf(staged)).not.toBe(true);
    expect(h.synthetic.state.invoices.get('1')!.Sent).toBe(true);
    const issue = h.host.queue.snapshot().at(-1)!.record;
    expect(issue).toMatchObject({ operation: 'markInvoicePrinted', state: 'pending', args: ['1'] });
    await drainNext(h);
    const applied = h.host.queue.get(issue.id)!;
    expect(applied.state).toBe('applied');
    const target = h.accounted.invoices.get(applied.targetId!)!;
    expect(target).toMatchObject({ status: 'sent' });
    expect(textOf(await stage(h, 'fortnox_invoice_pdf', issueArgs))).toMatch(
      /already has issue record/,
    );
  });

  it('after the issue, a booked payment previews with the real adapter and a credit passes preflight', async () => {
    const h = await withInvoice({
      enableInvoiceIssue: true,
      enableInvoicePayments: true,
      enableInvoiceCredits: true,
    });
    await stage(h, 'fortnox_invoice_pdf', issueArgs);
    await drainNext(h);
    expect(check(h, issueArgs)).toMatch(/already has issue record/);
    expect(
      preflightStagedCall(depsOf(h), 'creditInvoice', { documentNumber: '1' }),
    ).toBeUndefined();

    const created = await stage(h, 'fortnox_create_invoice_payment', {
      InvoiceNumber: 1,
      Amount: 125,
      PaymentDate: '2026-11-05',
    });
    expect(created.isError, textOf(created)).not.toBe(true);
    const booked = await stage(h, 'fortnox_bookkeep_invoice_payment', { paymentNumber: '1' });
    expect(booked.isError, textOf(booked)).not.toBe(true);
    const book = h.host.queue.snapshot().at(-1)!.record.id;
    expect((await captureCommand(h.host, book)).ok).toBe(true);
    const preview = await previewCommand(h.host, book);
    expect(preview.ok, preview.message).toBe(true);
    expect(preview.request).toMatchObject({ source: { amount: 125 } });
  });
});

describe('Accounted client allowlist for the opt-in stages', () => {
  const path = (suffix: string) =>
    `/api/v1/companies/${COMPANY}/invoices/00000000-0000-4000-8000-000000000002${suffix}`;
  it.each([
    ['POST', '/mark-sent', 'issue'],
    ['POST', '/credit', 'credits'],
    ['POST', '/mark-paid', 'payments'],
    ['POST', '/mark-paid?dry_run=true', 'payments'],
    ['GET', '?expand=items,payments', 'payments'],
  ] as const)('refuses %s %s unless the %s stage is enabled', async (method, suffix, stage) => {
    let fetched = 0;
    const make = (stages: Record<string, boolean>) =>
      createAccountedClient({
        origin: 'https://accounted.test',
        companyId: COMPANY,
        apiKey: async () => 'k',
        fetchImpl: (async () => {
          fetched++;
          return new Response('{"data":{}}', { status: 200 });
        }) as typeof fetch,
        stages,
      });
    const request = {
      method,
      path: path(suffix),
      ...(method === 'POST' ? { idempotencyKey: 'k1' } : {}),
    };
    await expect(make({})(request as never)).rejects.toThrow(/outside the pilot allowlist/);
    expect(fetched).toBe(0);
    await make({ [stage]: true })(request as never).catch(() => undefined);
    expect(fetched).toBeGreaterThan(0);
  });
});
