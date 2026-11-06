import { describe, expect, it } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { TargetBlockedError } from '../../src/shadow/types.js';
import { AccountedMasterDataAdapter } from '../../src/shadow/accounted-adapter.js';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import {
  binding,
  fakeCustomerTarget,
  ids,
  invoiceRecord,
  sourceCustomer,
  useTempDirs,
} from './baseline-helpers.js';

const directory = useTempDirs();

async function baseline(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  source = sourceCustomer,
) {
  const reads: string[] = [];
  await queue.execute(
    { id: 'baseline-c', operation: 'baselineCustomer', args: [{ CustomerNumber: '7' }] },
    async () => {
      reads.push('read');
      return source;
    },
  );
  return reads;
}

describe('baselineCustomer', () => {
  it('goes pending, drains through POST plus exact readback, and then resolves invoice customers', async () => {
    const queue = await openShadowQueue(directory(), binding);
    const reads = await baseline(queue);
    expect(reads).toEqual(['read']);
    expect(queue.get('baseline-c')!.state).toBe('pending');
    expect(queue.resolveIdentity('customer', '7')).toMatchObject({ state: 'unresolved' });

    const target = fakeCustomerTarget();
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    expect(await queue.drainOne(adapter)).toBe(true);
    expect(target.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(target.calls[0]!.body).toMatchObject({ customer_number: '7', name: 'Exempel AB' });
    expect(queue.get('baseline-c')).toMatchObject({ state: 'applied', targetId: ids[0] });

    const identity = queue.resolveIdentity('customer', '7');
    expect(identity).toMatchObject({
      state: 'ready',
      targetId: ids[0],
      sourceCustomer: { Name: 'Exempel AB' },
    });
    const mapped = mapInvoiceDraft(invoiceRecord(), binding, (kind, id) =>
      queue.resolveIdentity(kind, id),
    );
    expect(mapped).not.toHaveProperty('blocked');
    expect(await queue.verifyApplied('baseline-c', adapter)).toBe(true);
    queue.close();
  });

  it('applies the createCustomer refusal rules (populated GLN is blocked, no request issued)', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await baseline(queue, { ...sourceCustomer, GLN: '7350000000000' } as typeof sourceCustomer);
    const target = fakeCustomerTarget();
    expect(await queue.drainOne(new AccountedMasterDataAdapter(binding, target.request))).toBe(
      false,
    );
    expect(queue.get('baseline-c')).toMatchObject({ state: 'blocked' });
    expect(queue.get('baseline-c')!.reason).toContain('CUSTOMER_FIELD_UNSUPPORTED');
    expect(target.calls).toEqual([]);
    queue.close();
  });

  it.each([
    ['extra argument key', [{ CustomerNumber: '7', Name: 'Exempel AB' }]],
    ['mismatching number', [{ CustomerNumber: '8' }]],
    ['no arguments', []],
  ])('blocks malformed baseline arguments: %s', async (_label, args) => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      { id: 'bad', operation: 'baselineCustomer', args },
      async () => sourceCustomer,
    );
    const target = fakeCustomerTarget();
    await queue.drainOne(new AccountedMasterDataAdapter(binding, target.request));
    expect(queue.get('bad')!.state).toBe('blocked');
    expect(target.calls).toEqual([]);
    queue.close();
  });

  it('leaves an unknown POST outcome as target_unknown and never retries it', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await baseline(queue);
    const target = fakeCustomerTarget({ postThrows: true });
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('baseline-c')!.state).toBe('target_unknown');
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(target.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(queue.resolveIdentity('customer', '7')).toMatchObject({ state: 'unresolved' });
    queue.close();
  });

  it('treats TargetBlockedError from a mutating operation as an unknown outcome, never blocked', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await baseline(queue);
    const adapter = {
      prepare: () => ({ request: {} }),
      apply: async () => {
        throw new TargetBlockedError('ARTICLE_LINK_NOT_FOUND: wrongly thrown after a POST');
      },
    };
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('baseline-c')!.state).toBe('target_unknown');
    queue.close();
  });

  it('refuses a customer number with a control character before any POST', async () => {
    const queue = await openShadowQueue(directory(), binding);
    const bad = { ...sourceCustomer, CustomerNumber: '7\u0007' };
    await queue.execute(
      { id: 'x1', operation: 'createCustomer', args: [{ CustomerNumber: '7\u0007' }] },
      async () => bad,
    );
    await queue.execute(
      { id: 'x2', operation: 'baselineCustomer', args: [{ CustomerNumber: '7\u0007' }] },
      async () => bad,
    );
    const target = fakeCustomerTarget();
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('x1')).toMatchObject({ state: 'blocked' });
    expect(queue.get('x1')!.reason).toMatch(/customer number/i);
    expect(target.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    queue.close();
  });

  it('derives different request hashes and idempotency keys from createCustomer for the same input', async () => {
    const queue = await openShadowQueue(directory(), binding);
    const args = [{ CustomerNumber: '7' }];
    await queue.execute({ id: 'a', operation: 'createCustomer', args }, async () => sourceCustomer);
    await queue.execute({ id: 'a', operation: 'createCustomer', args }, async () => sourceCustomer);
    await queue.execute(
      { id: 'b', operation: 'baselineCustomer', args },
      async () => sourceCustomer,
    );
    const created = queue.get('a')!;
    const baselined = queue.get('b')!;
    expect(created.requestHash).not.toBe(baselined.requestHash);
    // The same id cannot be reused across operations.
    await expect(
      queue.execute({ id: 'a', operation: 'baselineCustomer', args }, async () => sourceCustomer),
    ).rejects.toThrow(/identity conflict/);

    // Two identity sources for one customer: neither may dispatch a POST.
    const target = fakeCustomerTarget();
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('a')).toMatchObject({ state: 'blocked' });
    expect(queue.get('a')!.reason).toContain('IDENTITY_SOURCE_COMPETING');
    expect(queue.get('a')!.targetAttempts ?? 0).toBe(0);
    expect(target.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    queue.close();
  });

  it.each([
    ['baseline after an applied create', 'createCustomer', 'baselineCustomer', true],
    ['baseline after a pending create', 'createCustomer', 'baselineCustomer', false],
    ['create after an applied baseline', 'baselineCustomer', 'createCustomer', true],
    ['two baselines, first applied', 'baselineCustomer', 'baselineCustomer', true],
  ])('never POSTs a second customer: %s', async (_label, first, second, drainFirst) => {
    const queue = await openShadowQueue(directory(), binding);
    const args = [{ CustomerNumber: '7' }];
    const target = fakeCustomerTarget();
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    await queue.execute({ id: 'first', operation: first, args }, async () => sourceCustomer);
    if (drainFirst) expect(await queue.drainOne(adapter)).toBe(true);
    await queue.execute({ id: 'second', operation: second, args }, async () => sourceCustomer);
    while (await queue.drainOne(adapter)) {
      /* drain until blocked or idle */
    }
    expect(target.calls.filter((c) => c.method === 'POST')).toHaveLength(drainFirst ? 1 : 0);
    // The oldest unresolved intent that competes is the one blocked; nothing else dispatches.
    const blockedId = drainFirst ? 'second' : 'first';
    expect(queue.get(blockedId)).toMatchObject({ state: 'blocked' });
    expect(queue.get(blockedId)!.reason).toContain('IDENTITY_SOURCE_COMPETING');
    queue.close();
  });
});
