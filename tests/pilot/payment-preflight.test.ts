import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
} from '../../src/pilot/commands.js';
import { preflightStagedCall, type PreflightDeps } from '../../src/pilot/preflight.js';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';
import { createStagedServer } from '../../src/staged-server.js';
import {
  ARTICLE_UUID,
  BASE_TIME,
  COMPANY,
  ORG,
  connect,
  invoiceArgs,
  makeHost,
  stagedCreate,
  tempRoot,
  textOf,
} from './helpers.js';

type Made = Awaited<ReturnType<typeof makeHost>>;

async function drainNext(h: Made) {
  const id = h.host.queue.snapshot().at(-1)!.record.id;
  const preview = await previewCommand(h.host, id);
  const drained = await drainOneCommand(h.host, id, preview.hash!);
  expect(drained.ok, drained.message).toBe(true);
}
/** A host with an applied (mirrored) strict invoice, source number "1", total 125. */
async function withInvoice(): Promise<Made> {
  const h = await makeHost();
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
const depsOf = (h: Made): PreflightDeps => ({
  binding: { sourceCompany: ORG, targetCompany: COMPANY },
  adapterFor: (name) => h.host.adapterFor(name),
  resolveIdentity: (resource, id) => h.host.queue.resolveIdentity(resource, id),
  getRecord: (id) => h.host.queue.get(id),
  records: () => h.host.queue.snapshot().map(({ record }) => record),
  now: () => BASE_TIME,
});
const pay = (args: Record<string, unknown>) => ({
  InvoiceNumber: 1,
  Amount: 125,
  PaymentDate: '2026-11-05',
  ...args,
});
const check = (h: Made, args: Record<string, unknown>) =>
  preflightStagedCall(depsOf(h), 'createInvoicePayment', args);

describe('invoice payment preflight (NOX-211)', () => {
  it('accepts the exact full payment of a mirrored strict invoice', async () => {
    const h = await withInvoice();
    expect(check(h, pay({ Source: 'direct', confirm: true }))).toBeUndefined();
  });

  it('refuses an invoice that is not mirrored', async () => {
    const h = await withInvoice();
    expect(check(h, pay({ InvoiceNumber: 2 }))).toMatch(/Invoice 2 is not mirrored/);
  });

  it.each([
    [{ Amount: 100 }, /exact full payment/],
    [{ Amount: 125.001 }, /whole cents/],
    [{ Amount: 0 }, /positive amount/],
    [{ Amount: '125' }, /positive amount/],
    [{ InvoiceNumber: 0 }, /InvoiceNumber/],
    [{ InvoiceNumber: 1.5 }, /InvoiceNumber/],
    [{ PaymentDate: '2026-02-30' }, /PaymentDate/],
    [{ PaymentDate: '5 nov' }, /PaymentDate/],
    [{ Source: '' }, /Source/],
    [{ Source: 'a\nb' }, /Source/],
    [{ Currency: 'EUR' }, /Unsupported payment input fields: Currency/],
    [{ WriteOffs: [] }, /Unsupported payment input fields: WriteOffs/],
  ])('refuses invalid or unsupported input %j', async (patch, reason) => {
    const h = await withInvoice();
    expect(check(h, pay(patch))).toMatch(reason);
  });

  it('refuses a second payment record for the same invoice, even a refused one', async () => {
    const h = await withInvoice();
    await h.host.queue.execute(
      { id: 'pay-1', operation: 'createInvoicePayment', args: [pay({})] },
      async () => ({ Number: '9', InvoiceNumber: '1', Booked: false }),
    );
    expect(check(h, pay({}))).toMatch(/already has payment record pay-1/);
  });

  it('refuses when the receipt and the request name different invoices', async () => {
    const h = await withInvoice();
    await h.host.queue.execute(
      { id: 'pay-c', operation: 'createInvoicePayment', args: [pay({})] },
      async () => ({ Number: '9', InvoiceNumber: '2', Booked: false }),
    );
    expect(check(h, pay({}))).toMatch(/already has payment record pay-c/);
  });

  it('sees the invoice named in update fields', async () => {
    const h = await withInvoice();
    await h.host.queue.execute(
      { id: 'pay-u', operation: 'updateInvoicePayment', args: ['9', { InvoiceNumber: 1 }] },
      async () => ({ Number: '9' }),
    );
    expect(check(h, pay({}))).toMatch(/already has payment record pay-u/);
  });

  it('blocks a new payment while a payment record names no invoice', async () => {
    const h = await withInvoice();
    await h.host.queue.execute(
      { id: 'pay-b', operation: 'bookkeepInvoicePayment', args: ['9'] },
      async () => ({ Number: '9' }),
    );
    expect(check(h, pay({}))).toMatch(/Payment record pay-b names no invoice/);
  });

  it('fails closed when the host supplies no queue lookup', async () => {
    const h = await withInvoice();
    const { getRecord: _g, records: _r, ...bare } = depsOf(h);
    expect(preflightStagedCall(bare, 'createInvoicePayment', pay({}))).toMatch(
      /No invoice payment/,
    );
  });

  it('is not reachable through the pilot host until payments are explicitly enabled', async () => {
    const h = await withInvoice();
    const client = await connect(h.host);
    const refused = await client.callTool({
      name: 'staged_prepare',
      arguments: {
        tool: 'fortnox_create_invoice_payment',
        args: { ...pay({}), confirm: true },
      },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as never)).toMatch(/outside staged contract/);
    await client.close();
  });
});

describe('staged server payment opt-in (NOX-211)', () => {
  async function staged(
    enable: boolean | undefined,
    preflight?: () => string | undefined,
    serializedExecution: boolean | undefined = enable === true ? true : undefined,
  ) {
    const directory = join(tempRoot(), 'staged');
    mkdirSync(directory, { mode: 0o700 });
    const server = await createStagedServer({
      transport: createSyntheticFortnox(ORG).transport,
      directory,
      binding: { sourceCompany: ORG, targetCompany: COMPANY },
      actorId: 'tester',
      revision: 'a'.repeat(64),
      maxPreparationAgeMs: 60_000,
      authorize: () => true,
      ...(preflight ? { preflight } : {}),
      ...(enable === undefined ? {} : { enableInvoicePayments: enable }),
      ...(serializedExecution === undefined ? {} : { serializedExecution }),
    });
    const client = new Client({ name: 't', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.server.connect(st), client.connect(ct)]);
    const prepare = (args: Record<string, unknown>) =>
      client.callTool({
        name: 'staged_prepare',
        arguments: { tool: 'fortnox_create_invoice_payment', args },
      });
    return { server, client, prepare };
  }
  const args = { InvoiceNumber: 1, Amount: 125, PaymentDate: '2026-11-05', confirm: true };

  it('refuses to start with payments enabled but no preflight or no serialization', async () => {
    await expect(staged(true, undefined)).rejects.toThrow(
      /requires a host preflight and serialized execution/,
    );
    await expect(staged(true, () => undefined, false)).rejects.toThrow(
      /requires a host preflight and serialized execution/,
    );
  });

  it('refuses the payment tool by default', async () => {
    for (const flag of [undefined, false]) {
      const s = await staged(flag);
      const result = await s.prepare(args);
      expect(result.isError).toBe(true);
      expect(textOf(result as never)).toMatch(/outside staged contract/);
      await s.client.close();
      await s.server.close();
    }
  });

  it('when enabled, still requires confirmation and runs the host preflight before saving', async () => {
    const seen: string[] = [];
    const s = await staged(true, () => {
      seen.push('x');
      return 'nope';
    });
    const unconfirmed = await s.prepare({ ...args, confirm: false });
    expect(unconfirmed.isError).toBe(true);
    expect(seen).toEqual([]);
    const refused = await s.prepare(args);
    expect(refused.isError).toBe(true);
    expect(textOf(refused as never)).toMatch(/Preflight refused: nope/);
    expect(s.server.queue.snapshot()).toEqual([]);
    await s.client.close();
    await s.server.close();
  });

  it('when enabled and preflight passes, the call is saved but nothing is written', async () => {
    const s = await staged(true, () => undefined);
    const ok = await s.prepare(args);
    expect(ok.isError, textOf(ok as never)).not.toBe(true);
    expect(s.server.queue.snapshot()).toEqual([]);
    await s.client.close();
    await s.server.close();
  });
});
