import { describe, expect, it } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowAdapter } from '../../src/shadow/types.js';
import { binding, ids, sourceCustomer, useTempDirs } from './baseline-helpers.js';

const directory = useTempDirs();

function adapter(targetId: string): ShadowAdapter {
  return {
    prepare: () => ({ request: {} }),
    apply: async () => ({ targetId, receipt: { data: { id: targetId } } }),
  };
}

async function applied(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id: string,
  operation: string,
  args: unknown[],
  source: unknown,
  targetId: string,
) {
  await queue.execute({ id, operation, args }, async () => source);
  expect(await queue.drainOne(adapter(targetId))).toBe(true);
}

/** A second identity source for the same source object is blocked before any dispatch. */
async function competing(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  id: string,
  operation: string,
  args: unknown[],
  source: unknown,
  targetId: string,
) {
  await queue.execute({ id, operation, args }, async () => source);
  const target = adapter(targetId);
  expect(await queue.drainOne(target)).toBe(false);
  expect(queue.get(id)).toMatchObject({ state: 'blocked' });
  expect(queue.get(id)!.reason).toContain('IDENTITY_SOURCE_COMPETING');
  expect(queue.get(id)!.targetAttempts ?? 0).toBe(0);
}

describe('baseline identity conflicts', () => {
  it('createCustomer plus baselineCustomer for one number conflict', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await applied(queue, 'c1', 'createCustomer', [{ Name: 'x' }], sourceCustomer, ids[0]!);
    expect(queue.resolveIdentity('customer', '7')).toMatchObject({ state: 'ready' });
    await competing(
      queue,
      'c2',
      'baselineCustomer',
      [{ CustomerNumber: '7' }],
      sourceCustomer,
      ids[1]!,
    );
    expect(queue.resolveIdentity('customer', '7')).toMatchObject({ state: 'conflict' });
    queue.close();
  });

  it('createArticle plus baselineArticle, and two baselineArticle, for one number conflict', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await applied(queue, 'a1', 'baselineArticle', [{}], { ArticleNumber: 'A-1' }, ids[0]!);
    expect(queue.resolveIdentity('article', 'A-1')).toMatchObject({ state: 'ready' });
    await competing(queue, 'a2', 'baselineArticle', [{}], { ArticleNumber: 'A-1' }, ids[0]!);
    expect(queue.resolveIdentity('article', 'A-1')).toMatchObject({ state: 'conflict' });
    // A new queue so the blocked a2 does not hold back later work (head-of-line).
    queue.close();
    const queue2 = await openShadowQueue(directory(), binding);
    await applied(queue2, 'a3', 'createArticle', [{}], { ArticleNumber: 'B-1' }, ids[2]!);
    await competing(queue2, 'a4', 'baselineArticle', [{}], { ArticleNumber: 'B-1' }, ids[3]!);
    expect(queue2.resolveIdentity('article', 'B-1')).toMatchObject({ state: 'conflict' });
    queue2.close();
  });

  it('one target UUID claimed by two different source numbers conflicts for both', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await applied(queue, 'a1', 'baselineArticle', [{}], { ArticleNumber: 'A-1' }, ids[0]!);
    await applied(queue, 'a2', 'baselineArticle', [{}], { ArticleNumber: 'A-2' }, ids[0]!);
    expect(queue.resolveIdentity('article', 'A-1')).toMatchObject({ state: 'conflict' });
    expect(queue.resolveIdentity('article', 'A-2')).toMatchObject({ state: 'conflict' });
    queue.close();
  });

  it('does not resolve baseline numbers across resource kinds and ignores numeric article numbers', async () => {
    const queue = await openShadowQueue(directory(), binding);
    await applied(queue, 'a1', 'baselineArticle', [{}], { ArticleNumber: 42 }, ids[0]!);
    expect(queue.resolveIdentity('article', '42')).toEqual({ state: 'missing' });
    await applied(queue, 'c1', 'baselineCustomer', [{}], { CustomerNumber: 'X' }, ids[1]!);
    expect(queue.resolveIdentity('supplier', 'X')).toEqual({ state: 'missing' });
    queue.close();
  });
});
