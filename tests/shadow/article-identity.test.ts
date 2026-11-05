import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { resolveShadowIdentity } from '../../src/shadow/identity.js';
import { TargetReceiptPendingError } from '../../src/shadow/types.js';
import type { ShadowAdapter, ShadowRecord } from '../../src/shadow/types.js';

const binding = { sourceCompany: 'synthetic-source', targetCompany: 'synthetic-target' };
const targetIds = [
  '550e8400-e29b-41d4-a716-446655440000',
  '7a1c89b0-d2f3-41c6-a7f1-879a44c3d177',
  '4ab23938-fdb6-4470-8d12-d47b338090a2',
  '9e7dc1a5-72a0-42ce-a332-fec2800c6207',
];
const roots: string[] = [];

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'article-identity-'));
  roots.push(root);
  return root;
}

function adapter(targetId: string): ShadowAdapter {
  return {
    prepare: () => ({ request: { synthetic: true } }),
    apply: vi.fn(async () => ({ targetId, receipt: { data: { id: targetId } } })),
    verify: vi.fn(async () => true),
  };
}

async function createArticle(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id: string,
  articleNumber: string,
  targetId: string,
  args: unknown[] = [{ Name: 'Synthetic article' }],
): Promise<ShadowAdapter> {
  await queue.execute({ id, operation: 'createArticle', args }, async () => ({
    ArticleNumber: articleNumber,
  }));
  const target = adapter(targetId);
  expect(await queue.drainOne(target)).toBe(true);
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('article shadow identity contract', () => {
  it('does not invent a catalog identifier by coercing a numeric source field', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      { id: 'numeric-article', operation: 'createArticle', args: [{ ArticleNumber: '00042' }] },
      async () => ({ ArticleNumber: 42 }),
    );
    await queue.drainOne(adapter(targetIds[0]!));
    expect(queue.resolveIdentity('article', '42')).toEqual({ state: 'missing' });
    expect(queue.resolveIdentity('article', '00042')).toEqual({ state: 'missing' });
    queue.close();
  });

  it('does not resolve an applied article whose target receipt contradicts its stored UUID', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createArticle(queue, 'receipt-drift', 'A-13', targetIds[0]!);
    const original = queue.snapshot()[0]!.record;
    expect(
      resolveShadowIdentity(
        [{ ...original, targetReceipt: { data: { id: targetIds[1] } } }],
        binding,
        'article',
        'A-13',
      ),
    ).toMatchObject({ state: 'unresolved' });
    queue.close();
  });

  it.each([
    ['mixed-case alphanumeric', '001Ab'],
    ['all-digit leading-zero', '00042'],
  ])('preserves the exact source ArticleNumber for %s', async (_label, articleNumber) => {
    const queue = await openShadowQueue(directory(), binding);
    const target = await createArticle(
      queue,
      `article-${articleNumber}`,
      articleNumber,
      targetIds[0]!,
      [{ ArticleNumber: 'argument-decoy', Name: 'Name is not identity' }],
    );

    expect(queue.resolveIdentity('article', articleNumber)).toMatchObject({
      state: 'ready',
      resource: 'article',
      sourceId: articleNumber,
      targetId: targetIds[0],
    });
    expect(queue.resolveIdentity('article', articleNumber.replace(/^0+/, ''))).toEqual({
      state: 'missing',
    });
    expect(target.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('uses only createArticle source receipts and ignores unrelated operations and resources', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await queue.execute(
      {
        id: 'article-args-only',
        operation: 'createArticle',
        args: [{ ArticleNumber: 'ARG-ONLY', Name: 'Decoy' }],
      },
      async () => ({ Name: 'Receipt without ArticleNumber' }),
    );
    await queue.drainOne(adapter(targetIds[3]!));
    expect(queue.resolveIdentity('article', 'ARG-ONLY')).toEqual({ state: 'missing' });

    await queue.execute(
      { id: 'update-article', operation: 'updateArticle', args: [{ ArticleNumber: 'A-7' }] },
      async () => ({ ArticleNumber: 'A-7' }),
    );
    await queue.drainOne(adapter(targetIds[1]!));
    await queue.execute(
      { id: 'create-customer', operation: 'createCustomer', args: [{ CustomerNumber: 'A-7' }] },
      async () => ({ CustomerNumber: 'A-7' }),
    );
    await queue.drainOne(adapter(targetIds[2]!));
    expect(queue.resolveIdentity('article', 'A-7')).toEqual({ state: 'missing' });

    await createArticle(queue, 'create-article', 'A-7', targetIds[0]!, [
      { ArticleNumber: 'ARGUMENT', Name: 'Name is not source identity' },
    ]);
    expect(queue.resolveIdentity('article', 'A-7')).toMatchObject({
      state: 'ready',
      intentId: 'create-article',
    });
    expect(queue.resolveIdentity('article', 'ARGUMENT')).toEqual({ state: 'missing' });
    queue.close();
  });

  it('keeps absent, unapplied, and receipt-less unknown article identities unresolved', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('article', 'A-8')).toEqual({ state: 'missing' });
    const source = vi.fn(async () => ({ ArticleNumber: 'A-8' }));
    const intent = { id: 'create-article', operation: 'createArticle', args: [{}] };
    await queue.execute(intent, source);
    expect(queue.resolveIdentity('article', 'A-8')).toMatchObject({ state: 'unresolved' });

    const failedTarget = adapter(targetIds[0]!);
    failedTarget.apply = vi.fn(async () => {
      throw new Error('synthetic ambiguous target outcome');
    });
    expect(await queue.drainOne(failedTarget)).toBe(false);
    expect(queue.get(intent.id)).toMatchObject({ state: 'target_unknown' });
    expect(queue.get(intent.id)).not.toHaveProperty('targetId');
    queue.close();

    queue = await openShadowQueue(root, binding);
    expect(queue.resolveIdentity('article', 'A-8')).toMatchObject({ state: 'unresolved' });
    expect(await queue.drainOne(failedTarget)).toBe(false);
    expect(failedTarget.apply).toHaveBeenCalledTimes(1);
    await queue.execute(intent, source);
    expect(source).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('reopens a persisted article identity without another source or target call', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    const source = vi.fn(async () => ({ ArticleNumber: '00017' }));
    const intent = {
      id: 'durable-article',
      operation: 'createArticle',
      args: [{ ArticleNumber: 'not-the-source-receipt' }],
    };
    await queue.execute(intent, source);
    const target = adapter(targetIds[0]!);
    expect(await queue.drainOne(target)).toBe(true);
    const first = queue.resolveIdentity('article', '00017');
    expect(first).toMatchObject({ state: 'ready', targetId: targetIds[0] });
    queue.close();

    queue = await openShadowQueue(root, binding);
    await queue.execute(intent, source);
    expect(await queue.drainOne(target)).toBe(false);
    expect(queue.resolveIdentity('article', '00017')).toEqual(first);
    expect(source).toHaveBeenCalledTimes(1);
    expect(target.apply).toHaveBeenCalledTimes(1);
    queue.close();
  });

  it('refuses company mismatches and conflicting source or target mappings', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await createArticle(queue, 'first', 'A-9', targetIds[0]!);
    const firstRecord = queue.snapshot()[0]!.record;
    for (const companyMismatch of [
      { sourceCompany: 'other-source' },
      { targetCompany: 'other-target' },
    ]) {
      const mismatched = { ...firstRecord, ...companyMismatch } as ShadowRecord;
      expect(() => resolveShadowIdentity([mismatched], binding, 'article', 'A-9')).toThrow(
        /binding/i,
      );
    }

    await createArticle(queue, 'second-same-source', 'A-9', targetIds[1]!);
    expect(queue.resolveIdentity('article', 'A-9')).toMatchObject({ state: 'conflict' });
    queue.close();

    const targetConflictQueue = await openShadowQueue(directory(), binding);
    await createArticle(targetConflictQueue, 'source-one', 'A-10', targetIds[0]!);
    await createArticle(targetConflictQueue, 'source-two', 'A-11', targetIds[0]!);
    expect(targetConflictQueue.resolveIdentity('article', 'A-10')).toMatchObject({
      state: 'conflict',
    });
    targetConflictQueue.close();
  });

  it('reconciles a durable unknown receipt with verification only', async () => {
    const root = directory();
    let queue = await openShadowQueue(root, binding);
    await queue.execute(
      { id: 'receipt-pending', operation: 'createArticle', args: [{}] },
      async () => ({ ArticleNumber: 'A-12' }),
    );
    const target = adapter(targetIds[0]!);
    target.apply = vi.fn(async () => {
      throw new TargetReceiptPendingError(
        targetIds[0]!,
        { data: { id: targetIds[0] } },
        { cause: new Error('synthetic readback failure') },
      );
    });
    expect(await queue.drainOne(target)).toBe(false);
    expect(queue.resolveIdentity('article', 'A-12')).toMatchObject({ state: 'unresolved' });
    queue.close();

    queue = await openShadowQueue(root, binding);
    expect(await queue.drainOne(target)).toBe(false);
    expect(await queue.reconcileTarget('receipt-pending', target)).toBe(true);
    expect(queue.resolveIdentity('article', 'A-12')).toMatchObject({
      state: 'ready',
      targetId: targetIds[0],
    });
    expect(target.apply).toHaveBeenCalledTimes(1);
    expect(target.verify).toHaveBeenCalledTimes(1);
    queue.close();
  });
});
