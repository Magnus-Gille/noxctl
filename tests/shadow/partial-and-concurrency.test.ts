import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { createQueueObserver } from '../../src/shadow/observer.js';
import { createFortnoxOperations } from '../../src/operations/index.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
const roots: string[] = [];
function directory() {
  const p = mkdtempSync(join(tmpdir(), 'noxctl-shadow-partial-'));
  roots.push(p);
  return p;
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const binding = { sourceCompany: 'synthetic', targetCompany: 'synthetic-target' };
describe('competing target workers and partial source effects', () => {
  it('allows only one target worker to dispatch the oldest claimed intent', async () => {
    const root = directory();
    const a = await openShadowQueue(root, binding);
    const b = await openShadowQueue(root, binding);
    await a.execute({ id: 'one', operation: 'createCustomer', args: [] }, async () => ({}));
    let finish!: (value: { targetId: string; receipt: unknown }) => void;
    const firstApply = vi.fn(
      () =>
        new Promise<{ targetId: string; receipt: unknown }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = a.drainOne({ prepare: () => ({ request: {} }), apply: firstApply });
    const secondApply = vi.fn();
    expect(await b.drainOne({ prepare: () => ({ request: {} }), apply: secondApply })).toBe(false);
    expect(secondApply).not.toHaveBeenCalled();
    finish({ targetId: 'target', receipt: { id: 'target' } });
    expect(await first).toBe(true);
    expect(b.status().counts.applied).toBe(1);
    a.close();
    b.close();
  });
  it('does not repeat the successful prefix of a partially failed attachment operation', async () => {
    const root = directory();
    const q = await openShadowQueue(join(root, 'queue'), binding);
    const paths = [join(root, 'one.pdf'), join(root, 'two.pdf')];
    for (const p of paths) writeFileSync(p, '%PDF-synthetic');
    let uploads = 0;
    let links = 0;
    const request = vi.fn(async (endpoint: string) => {
      if (endpoint === 'inbox') {
        uploads++;
        if (uploads === 2) throw new Error('synthetic upload timeout');
        return { File: { Id: 'file-one' } };
      }
      if (endpoint === 'voucherfileconnections') {
        links++;
        return { VoucherFileConnection: { FileId: 'file-one' } };
      }
      throw new Error('unexpected synthetic endpoint');
    });
    const transport = {
      request,
      requestWithMetadata: vi.fn(),
      requestPdf: vi.fn(),
      requestPdfFromMutation: vi.fn(),
      requestFile: vi.fn(),
      fetchAllPages: vi.fn(),
    } as unknown as FortnoxTransport;
    const operations = createFortnoxOperations(
      transport,
      createQueueObserver(q, () => 'attachments'),
    );
    const params = { series: 'A', voucherNumber: '1', financialYear: 1, filePaths: paths };
    await expect(operations.attachVoucherFiles(params)).rejects.toThrow(/Failed attaching/);
    expect(uploads).toBe(2);
    expect(links).toBe(1);
    expect(q.status().counts.source_unknown).toBe(1);
    await expect(operations.attachVoucherFiles(params)).rejects.toThrow(/unknown|in flight/i);
    expect(uploads).toBe(2);
    expect(links).toBe(1);
    q.close();
  });
});
