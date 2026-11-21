import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function open(root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'evidence-'));
  if (!root) roots.push(dir);
  return { dir, queue: await openShadowQueue(dir, binding, () => 1_000) };
}

describe('captured read-only source evidence (NOX-211)', () => {
  it('stores evidence once and returns it with its sha256 after reopen', async () => {
    const { dir, queue } = await open();
    const stored = queue.recordEvidence('payment-voucher', '1:A:17', { VoucherNumber: 17 });
    expect(stored).toMatchObject({
      ok: true,
      created: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    queue.close();
    const again = (await open(dir)).queue;
    expect(again.getEvidence('payment-voucher', '1:A:17')).toEqual({
      data: { VoucherNumber: 17 },
      sha256: (stored as { sha256: string }).sha256,
      capturedAt: 1_000,
    });
    again.close();
  });

  it('accepts an identical re-capture and refuses a different one without changing the stored copy', async () => {
    const { queue } = await open();
    queue.recordEvidence('credit-note', '11', { DocumentNumber: '11', Total: -125 });
    expect(
      queue.recordEvidence('credit-note', '11', { Total: -125, DocumentNumber: '11' }),
    ).toMatchObject({
      ok: true,
      created: false,
    });
    expect(
      queue.recordEvidence('credit-note', '11', { DocumentNumber: '11', Total: -100 }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs from the captured evidence/),
    });
    expect(queue.getEvidence('credit-note', '11')?.data).toEqual({
      DocumentNumber: '11',
      Total: -125,
    });
    queue.close();
  });

  it('keeps kinds apart and returns undefined for missing evidence', async () => {
    const { queue } = await open();
    queue.recordEvidence('credit-note', '11', { a: 1 });
    expect(queue.getEvidence('payment-voucher', '11')).toBeUndefined();
    expect(queue.getEvidence('credit-note', '12')).toBeUndefined();
    queue.close();
  });

  it.each([
    ['an unknown kind', 'invoice', 'x'],
    ['an empty key', 'credit-note', ''],
    ['a key with a control character', 'credit-note', 'a\nb'],
  ])('refuses %s', async (_name, kind, key) => {
    const { queue } = await open();
    expect(() => queue.recordEvidence(kind as 'credit-note', key, { a: 1 })).toThrow();
    queue.close();
  });

  it('refuses evidence that is not a plain object or is too large', async () => {
    const { queue } = await open();
    expect(() => queue.recordEvidence('credit-note', '11', [1] as never)).toThrow();
    expect(() =>
      queue.recordEvidence('credit-note', '11', { big: 'x'.repeat(1_100_000) }),
    ).toThrow();
    queue.close();
  });
});
