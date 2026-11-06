import { describe, expect, it } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { AccountedMasterDataAdapter } from '../../src/shadow/accounted-adapter.js';
import {
  AccountedArticleLinkAdapter,
  ARTICLE_LINK_ACTIVE,
  ARTICLE_LINK_AMBIGUOUS,
  ARTICLE_LINK_NOT_FOUND,
  ARTICLE_LINK_NUMBER_MISMATCH,
  ARTICLE_LINK_UUID_INVALID,
} from '../../src/shadow/article-link-adapter.js';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import {
  articleEntry,
  binding,
  fakeArticleTarget,
  fakeCustomerTarget,
  ids,
  invoiceRecord,
  sourceCustomer,
  useTempDirs,
} from './baseline-helpers.js';

const directory = useTempDirs();

async function queued(
  articleNumber = '00123-aB',
  targetArticleId = ids[1]!,
  sourceNumber: unknown = articleNumber,
  id = 'baseline-a',
) {
  const queue = await openShadowQueue(directory(), binding);
  await queue.execute(
    {
      id,
      operation: 'baselineArticle',
      args: [{ ArticleNumber: articleNumber, targetArticleId }],
    },
    async () => ({ ArticleNumber: sourceNumber, Description: 'Synthetic' }),
  );
  return queue;
}

describe('baselineArticle', () => {
  it('links an existing active article with GET only and resolves invoice rows to its UUID', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([
      articleEntry(ids[0]!, 'OTHER'),
      articleEntry(ids[1]!, '00123-aB'),
    ]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    expect(await queue.drainOne(adapter)).toBe(true);
    expect(target.calls.map((call) => call.method)).toEqual(['GET']);
    expect(target.calls[0]!.path).toBe(
      `/api/v1/companies/${binding.targetCompany}/articles?include_inactive=true`,
    );
    expect(queue.get('baseline-a')).toMatchObject({
      state: 'applied',
      targetId: ids[1],
      targetReceipt: { data: { id: ids[1], article_number: '00123-aB', active: true } },
    });
    expect(queue.resolveIdentity('article', '00123-aB')).toMatchObject({
      state: 'ready',
      targetId: ids[1],
    });
    expect(queue.resolveIdentity('article', '123-aB')).toEqual({ state: 'missing' });

    // A customer baseline supplies the invoice customer; the article resolves to the linked UUID.
    await queue.execute(
      { id: 'baseline-c', operation: 'baselineCustomer', args: [{ CustomerNumber: '7' }] },
      async () => sourceCustomer,
    );
    const customers = new AccountedMasterDataAdapter(binding, fakeCustomerTarget().request);
    expect(await queue.drainOne(customers)).toBe(true);
    const mapped = mapInvoiceDraft(invoiceRecord('00123-aB'), binding, (kind, id) =>
      queue.resolveIdentity(kind, id),
    );
    if ('blocked' in mapped) throw new Error(mapped.blocked);
    expect(mapped.request.items[0]!.article_id).toBe(ids[1]);
    queue.close();
  });

  it('routes through the master-data adapter too', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
    const adapter = new AccountedMasterDataAdapter(binding, target.request);
    expect(await queue.drainOne(adapter)).toBe(true);
    expect(target.calls.every((call) => call.method === 'GET')).toBe(true);
    queue.close();
  });

  it.each([
    ['id absent from the list', [articleEntry(ids[2]!, '00123-aB')], ARTICLE_LINK_NOT_FOUND],
    ['leading zeros dropped', [articleEntry(ids[1]!, '123-aB')], ARTICLE_LINK_NUMBER_MISMATCH],
    ['case differs', [articleEntry(ids[1]!, '00123-AB')], ARTICLE_LINK_NUMBER_MISMATCH],
    ['null article number', [articleEntry(ids[1]!, null)], ARTICLE_LINK_NUMBER_MISMATCH],
    ['inactive', [articleEntry(ids[1]!, '00123-aB', { active: false })], ARTICLE_LINK_ACTIVE],
    [
      'duplicate article_number on another article',
      [articleEntry(ids[1]!, '00123-aB'), articleEntry(ids[2]!, '00123-aB')],
      ARTICLE_LINK_AMBIGUOUS,
    ],
    [
      'duplicate article_number on an inactive article',
      [articleEntry(ids[1]!, '00123-aB'), articleEntry(ids[2]!, '00123-aB', { active: false })],
      ARTICLE_LINK_AMBIGUOUS,
    ],
    [
      'duplicate id',
      [articleEntry(ids[1]!, '00123-aB'), articleEntry(ids[1]!, '00123-aB')],
      ARTICLE_LINK_AMBIGUOUS,
    ],
  ])('blocks without applying: %s', async (_label, articles, reason) => {
    const queue = await queued();
    const target = fakeArticleTarget(articles);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    const record = queue.get('baseline-a')!;
    expect(record.state).toBe('blocked');
    expect(record.reason).toContain(reason);
    expect(record.targetId).toBeUndefined();
    expect(target.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(queue.resolveIdentity('article', '00123-aB')).toMatchObject({ state: 'unresolved' });
    queue.close();
  });

  it.each([
    ['an empty object entry', [{}]],
    ['a missing article_number', [{ id: ids[2], active: true }]],
    ['a numeric article_number', [{ id: ids[2], article_number: 123, active: true }]],
    ['a non-UUID id', [{ id: 'x', article_number: 'OTHER', active: true }]],
    ['a non-boolean active', [{ id: ids[2], article_number: 'OTHER', active: 'yes' }]],
    ['a missing active flag', [{ id: ids[2], article_number: 'OTHER' }]],
  ])('treats a list with %s as malformed (unknown, never applied)', async (_label, extra) => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB'), ...(extra as unknown[])]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('baseline-a')!.state).toBe('target_unknown');
    queue.close();
  });

  it('compares UUIDs case-insensitively and treats case-only duplicates as ambiguous', async () => {
    const upper = ids[1]!.toUpperCase();
    const queue = await queued();
    const ok = fakeArticleTarget([articleEntry(upper, '00123-aB')]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, ok.request);
    expect(await queue.drainOne(adapter)).toBe(true);
    expect(queue.get('baseline-a')!.targetId).toBe(ids[1]);
    queue.close();

    const queue2 = await queued();
    const dup = fakeArticleTarget([
      articleEntry(ids[1]!, '00123-aB'),
      articleEntry(upper, 'OTHER'),
    ]);
    const adapter2 = new AccountedArticleLinkAdapter(binding.targetCompany, dup.request);
    expect(await queue2.drainOne(adapter2)).toBe(false);
    expect(queue2.get('baseline-a')!.reason).toContain(ARTICLE_LINK_AMBIGUOUS);
    queue2.close();
  });

  it('blocks malformed arguments or a source result that disagrees, before any request', async () => {
    const cases: Array<[string, unknown[], unknown]> = [
      ['bad uuid', [{ ArticleNumber: 'A', targetArticleId: 'nope' }], 'A'],
      ['padded number', [{ ArticleNumber: ' A', targetArticleId: ids[1] }], ' A'],
      ['source differs', [{ ArticleNumber: 'A', targetArticleId: ids[1] }], 'a'],
      ['numeric source', [{ ArticleNumber: 'A', targetArticleId: ids[1] }], 42],
      ['extra key', [{ ArticleNumber: 'A', targetArticleId: ids[1], Name: 'x' }], 'A'],
    ];
    for (const [label, args, sourceNumber] of cases) {
      const queue = await openShadowQueue(directory(), binding);
      await queue.execute({ id: 'x', operation: 'baselineArticle', args }, async () => ({
        ArticleNumber: sourceNumber,
      }));
      const target = fakeArticleTarget([articleEntry(ids[1]!, 'A')]);
      await queue.drainOne(new AccountedArticleLinkAdapter(binding.targetCompany, target.request));
      expect(queue.get('x')!.state, label).toBe('blocked');
      expect(target.calls, label).toEqual([]);
      queue.close();
    }
    expect(ARTICLE_LINK_UUID_INVALID).toBeTruthy();
  });

  it('leaves a failed list request unknown (read-only, never retried automatically)', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([]);
    target.state.status = 500;
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('baseline-a')!.state).toBe('target_unknown');
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(target.calls).toHaveLength(1);
    queue.close();
  });

  it('verify() passes while the link holds and detects drift', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    await queue.drainOne(adapter);
    expect(await adapter.verify(queue.get('baseline-a')!)).toBe(true);

    const drifts: unknown[][] = [
      [],
      [articleEntry(ids[1]!, '00123-aB-renumbered')],
      [articleEntry(ids[1]!, '00123-aB', { active: false })],
      [articleEntry(ids[1]!, '00123-aB'), articleEntry(ids[2]!, '00123-aB')],
    ];
    for (const drift of drifts) {
      target.state.articles = drift;
      expect(await adapter.verify(queue.get('baseline-a')!)).toBe(false);
    }
    expect(await queue.verifyApplied('baseline-a', adapter)).toBe(false);
    expect(queue.get('baseline-a')!.state).toBe('blocked');
    expect(target.calls.every((call) => call.method === 'GET')).toBe(true);
    queue.close();
  });

  it.each([
    [
      'an HTTP failure',
      (t: ReturnType<typeof fakeArticleTarget>) => {
        t.state.status = 503;
      },
    ],
    [
      'a malformed list',
      (t: ReturnType<typeof fakeArticleTarget>) => {
        t.state.articles = [{}];
      },
    ],
  ])(
    'withholds the identity when drift verification cannot complete: %s',
    async (_label, breakIt) => {
      const queue = await queued();
      const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
      const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
      await queue.drainOne(adapter);
      expect(queue.resolveIdentity('article', '00123-aB')).toMatchObject({ state: 'ready' });
      breakIt(target);
      await expect(queue.verifyApplied('baseline-a', adapter)).rejects.toThrow();
      expect(queue.get('baseline-a')).toMatchObject({ state: 'target_unknown', targetId: ids[1] });
      expect(queue.resolveIdentity('article', '00123-aB').state).not.toBe('ready');
      // A later successful read-only reconciliation restores the identity.
      target.state.status = 200;
      target.state.articles = [articleEntry(ids[1]!, '00123-aB')];
      expect(await queue.reconcileTarget('baseline-a', adapter)).toBe(true);
      expect(queue.resolveIdentity('article', '00123-aB')).toMatchObject({ state: 'ready' });
      expect(target.calls.every((call) => call.method === 'GET')).toBe(true);
      queue.close();
    },
  );

  it('does not let a later failed verification overwrite a confirmed mismatch', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    await queue.drainOne(adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mismatch = {
      ...adapter,
      prepare: adapter.prepare.bind(adapter),
      apply: adapter.apply.bind(adapter),
      verify: async () => false,
    };
    const failing = {
      ...mismatch,
      verify: async () => {
        await gate;
        throw new Error('network');
      },
    };
    const slow = queue.verifyApplied('baseline-a', failing);
    expect(await queue.verifyApplied('baseline-a', mismatch)).toBe(false);
    expect(queue.get('baseline-a')!.state).toBe('blocked');
    release();
    await expect(slow).rejects.toThrow();
    expect(queue.get('baseline-a')!.state).toBe('blocked');
    queue.close();
  });

  it('records a confirmed mismatch even after a concurrent failed verification', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
    const adapter = new AccountedArticleLinkAdapter(binding.targetCompany, target.request);
    await queue.drainOne(adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = { prepare: adapter.prepare.bind(adapter), apply: adapter.apply.bind(adapter) };
    const slowMismatch = queue.verifyApplied('baseline-a', {
      ...base,
      verify: async () => {
        await gate;
        return false;
      },
    });
    await expect(
      queue.verifyApplied('baseline-a', {
        ...base,
        verify: async () => {
          throw new Error('network');
        },
      }),
    ).rejects.toThrow();
    expect(queue.get('baseline-a')!.state).toBe('target_unknown');
    release();
    expect(await slowMismatch).toBe(false);
    expect(queue.get('baseline-a')!.state).toBe('blocked');
    // A blocked mismatch can no longer be reconciled back to applied.
    await expect(queue.reconcileTarget('baseline-a', adapter)).rejects.toThrow();
    queue.close();
  });

  it('refuses another target company binding', async () => {
    const queue = await queued();
    const target = fakeArticleTarget([articleEntry(ids[1]!, '00123-aB')]);
    const adapter = new AccountedArticleLinkAdapter('other-company', target.request);
    await queue.drainOne(adapter);
    expect(queue.get('baseline-a')!.state).toBe('blocked');
    expect(target.calls).toEqual([]);
    queue.close();
  });
});
