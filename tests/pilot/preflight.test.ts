import { describe, expect, it } from 'vitest';
import {
  baselineCustomerCommand,
  drainOneCommand,
  linkArticleCommand,
  previewCommand,
} from '../../src/pilot/commands.js';
import { ARTICLE_UUID, connect, invoiceArgs, makeHost, stagedCreate, textOf } from './helpers.js';

const posts = (requests: string[]) => requests.filter((r) => r.startsWith('POST'));

async function linked() {
  const h = await makeHost();
  for (const step of [
    () => baselineCustomerCommand(h.host, '1'),
    () => linkArticleCommand(h.host, 'A-1', ARTICLE_UUID),
  ]) {
    expect((await step()).ok).toBe(true);
    const id = h.host.queue.snapshot().at(-1)!.record.id;
    const p = await previewCommand(h.host, id);
    expect((await drainOneCommand(h.host, id, p.hash!)).ok).toBe(true);
  }
  return h;
}

describe('mapping preflight before every Fortnox write (NOX-215)', () => {
  it('refuses an invoice without InvoiceDate and makes no Fortnox write', async () => {
    const h = await linked();
    const client = await connect(h.host);
    const { InvoiceDate: _omit, ...args } = invoiceArgs();
    const before = h.host.queue.snapshot().length;
    const result = await stagedCreate(client, 'fortnox_create_invoice', args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/InvoiceDate/);
    expect(posts(h.synthetic.state.requests)).toEqual([]);
    expect(h.host.queue.snapshot().length).toBe(before);
    await client.close();
  });

  it('refuses createCustomer with unsupported input fields (Currency, VATType)', async () => {
    for (const extra of [{ Currency: 'SEK' }, { VATType: 'SEVAT' }]) {
      const stderr: string[] = [];
      const h = await makeHost({ stderr });
      const client = await connect(h.host);
      const result = await stagedCreate(client, 'fortnox_create_customer', {
        Name: 'X AB',
        Type: 'COMPANY',
        CountryCode: 'SE',
        ...extra,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/Unsupported customer input fields/);
      expect(stderr.join('\n')).toMatch(/preflight/i);
      expect(posts(h.synthetic.state.requests)).toEqual([]);
      expect(h.host.queue.snapshot()).toEqual([]);
      await client.close();
    }
  });

  it('refuses an invoice whose customer or article has no applied identity', async () => {
    const h = await makeHost();
    const client = await connect(h.host);
    const noCustomer = await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
    expect(noCustomer.isError).toBe(true);
    expect(textOf(noCustomer)).toMatch(/customer identity/i);
    expect(posts(h.synthetic.state.requests)).toEqual([]);
    await baselineCustomerCommand(h.host, '1');
    const id = h.host.queue.snapshot()[0]!.record.id;
    const p = await previewCommand(h.host, id);
    await drainOneCommand(h.host, id, p.hash!);
    const noArticle = await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
    expect(noArticle.isError).toBe(true);
    expect(textOf(noArticle)).toMatch(/article/i);
    expect(posts(h.synthetic.state.requests)).toEqual([]);
    await client.close();
  });

  it('passes and executes a valid invoice with a linked customer and article', async () => {
    const h = await linked();
    const client = await connect(h.host);
    const result = await stagedCreate(client, 'fortnox_create_invoice', invoiceArgs());
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(posts(h.synthetic.state.requests)).toEqual(['POST invoices']);
    expect(h.host.queue.snapshot().at(-1)!.record.state).toBe('pending');
    await client.close();
  });

  it('passes a customer create that gives no Type, CountryCode or number (response-dependent)', async () => {
    const h = await makeHost();
    const client = await connect(h.host);
    const result = await stagedCreate(client, 'fortnox_create_customer', { Name: 'Ny AB' });
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(posts(h.synthetic.state.requests)).toEqual(['POST customers']);
    await client.close();
  });

  it('re-checks at execute and refuses before any Fortnox write', async () => {
    const h = await makeHost();
    const client = await connect(h.host);
    const prepared = await client.callTool({
      name: 'staged_prepare',
      arguments: {
        tool: 'fortnox_create_customer',
        args: {
          Name: 'X AB',
          Type: 'COMPANY',
          CountryCode: 'SE',
          CustomerNumber: '9',
          confirm: true,
        },
      },
    });
    expect(prepared.isError).not.toBe(true);
    const id = (JSON.parse(textOf(prepared as never)) as { id: string }).id;
    // Another intent now claims customer 9 (the identity is no longer free).
    await h.host.queue.execute(
      { id: 'other', operation: 'baselineCustomer', args: [{ CustomerNumber: '9' }] },
      async () => ({ CustomerNumber: '9' }),
    );
    const result = await client.callTool({
      name: 'staged_execute',
      arguments: { id, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(posts(h.synthetic.state.requests)).toEqual([]);
    await client.close();
  });

  it('does not let the country rule mask other input errors', async () => {
    const h = await makeHost();
    const client = await connect(h.host);
    const bad = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      Type: 'COMPANY',
      CountryCode: '',
      Email: 'not-an-email',
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Email/);
    expect(posts(h.synthetic.state.requests)).toEqual([]);
    const ok = await stagedCreate(client, 'fortnox_create_customer', {
      Name: 'X AB',
      Type: 'COMPANY',
      CountryCode: '',
    });
    expect(ok.isError, textOf(ok)).not.toBe(true);
    await client.close();
  });
});
