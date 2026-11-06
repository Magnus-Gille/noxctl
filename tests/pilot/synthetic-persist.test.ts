import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('synthetic Fortnox persistence (phase B rehearsal across processes)', () => {
  it('shares created invoices and counters between instances using the same file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synthetic-'));
    roots.push(root);
    const file = join(root, 'synthetic-fortnox.json');
    const a = createSyntheticFortnox('559900-0009', { persistPath: file });
    const created = await a.transport.request<{ Invoice: { DocumentNumber: string } }>('invoices', {
      method: 'POST',
      body: {
        Invoice: {
          CustomerNumber: '1',
          InvoiceDate: '2026-11-06',
          DueDate: '2026-12-06',
          InvoiceRows: [{ Price: 10, DeliveredQuantity: 1 }],
        },
      },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const b = createSyntheticFortnox('559900-0009', { persistPath: file });
    const read = await b.transport.request<{ Invoice: { DocumentNumber: string } }>(
      `invoices/${created.Invoice.DocumentNumber}`,
    );
    expect(read.Invoice.DocumentNumber).toBe(created.Invoice.DocumentNumber);
    const next = await b.transport.request<{ Invoice: { DocumentNumber: string } }>('invoices', {
      method: 'POST',
      body: {
        Invoice: {
          CustomerNumber: '1',
          InvoiceDate: '2026-11-06',
          DueDate: '2026-12-06',
          InvoiceRows: [{ Price: 10, DeliveredQuantity: 1 }],
        },
      },
    });
    expect(next.Invoice.DocumentNumber).not.toBe(created.Invoice.DocumentNumber);
  });

  it('stays in memory without a persist path', async () => {
    const a = createSyntheticFortnox('559900-0009');
    await expect(a.transport.request('invoices/1')).rejects.toThrow(/not found/);
  });
});
