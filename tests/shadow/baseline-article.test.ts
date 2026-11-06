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
    ['active flag missing', [{ id: ids[1], article_number: '00123-aB' }], ARTICLE_LINK_ACTIVE],
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
