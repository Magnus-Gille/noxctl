import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFortnoxOperations } from '../../src/operations/index.js';
import { createQueueObserver } from '../../src/shadow/observer.js';
import { openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowBinding } from '../../src/shadow/types.js';

const binding: ShadowBinding = {
  sourceCompany: 'synthetic-fortnox-company',
  targetCompany: 'synthetic-accounted-company',
};
const pdf = Buffer.from('%PDF-synthetic-invoice-print');
const roots: string[] = [];
const activeQueues = new Set<ShadowQueue>();

afterEach(async () => {
  for (const queue of activeQueues) {
    activeQueues.delete(queue);
    queue.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeTransport() {
  const calls: Array<{ endpoint: string; method: string }> = [];
  const transport: FortnoxTransport = {
    async request<T>(endpoint: string, options: { method?: string } = {}): Promise<T> {
      const method = options.method ?? 'GET';
      calls.push({ endpoint, method });
      if (method === 'PUT' && endpoint.endsWith('/externalprint')) {
        const documentNumber = endpoint.split('/')[1]!;
        return {
          Invoice: { DocumentNumber: documentNumber, Sent: true, Source: 'externalprint' },
        } as T;
      }
      if (method === 'GET' && /^invoices\/\d+$/.test(endpoint)) {
        const documentNumber = endpoint.split('/')[1]!;
        if (documentNumber === '102') throw new Error('synthetic readback failure');
        if (documentNumber === '106') {
          return {
            Invoice: { DocumentNumber: documentNumber, Sent: false, Source: 'readback' },
          } as T;
        }
        return {
          Invoice: { DocumentNumber: documentNumber, Sent: true, Source: 'readback' },
        } as T;
      }
      throw new Error(`Unexpected synthetic Fortnox call: ${method} ${endpoint}`);
    },
    async requestWithMetadata<T>(): Promise<T> {
      throw new Error('Unexpected synthetic metadata request');
    },
    async requestPdf(endpoint: string): Promise<Buffer> {
      calls.push({ endpoint, method: 'PDF' });
      if (!/^invoices\/\d+\/preview$/.test(endpoint))
        throw new Error(`Unexpected synthetic PDF request: ${endpoint}`);
      return pdf;
    },
    async requestPdfFromMutation(endpoint: string): Promise<Buffer | undefined> {
      calls.push({ endpoint, method: 'PDF_MUTATION' });
      if (!/^invoices\/\d+\/print$/.test(endpoint))
        throw new Error(`Unexpected synthetic PDF mutation: ${endpoint}`);
      return pdf;
    },
    async requestFile(): Promise<never> {
      throw new Error('Unexpected synthetic file request');
    },
    async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
      items: T[];
      totalResources: number;
    }> {
      throw new Error('Unexpected synthetic pagination request');
    },
  };
  return { transport, calls };
}

function operationsFor(queue: ShadowQueue, transport: FortnoxTransport) {
  const observer = createQueueObserver(
    queue,
    (operation, args) => `invoice-print:${operation}:${String(args[0])}`,
  );
  return createFortnoxOperations(transport, observer);
}

async function openTrackedQueue(path: string): Promise<ShadowQueue> {
  const queue = await openShadowQueue(path, binding);
  activeQueues.add(queue);
  return queue;
}

function closeTrackedQueue(queue: ShadowQueue): void {
  if (activeQueues.delete(queue)) queue.close();
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'noxctl-print-receipts-'));
  roots.push(root);
  const { transport, calls } = makeTransport();
  const queuePath = join(root, 'queue');
  const queue = await openTrackedQueue(queuePath);
  return { calls, operations: operationsFor(queue, transport), queue, queuePath, transport };
}

describe('invoice print source receipts', () => {
  it('persists the direct mark receipt exactly, replays without another source mutation, and survives reopen', async () => {
    const { calls, operations, queue, queuePath, transport } = await setup();
    const first = await operations.markInvoicePrinted('101');
    expect(first).toEqual({
      invoice: { DocumentNumber: '101', Sent: true, Source: 'readback' },
      confirmed: true,
      pdf,
    });
    expect(Buffer.isBuffer(first.pdf)).toBe(true);
    expect(calls).toEqual([
      { endpoint: 'invoices/101/print', method: 'PDF_MUTATION' },
      { endpoint: 'invoices/101', method: 'GET' },
    ]);

    closeTrackedQueue(queue);
    const reopened = await openTrackedQueue(queuePath);
    const replayingOperations = operationsFor(reopened, transport);
    await expect(replayingOperations.markInvoicePrinted('101')).resolves.toEqual(first);
    expect(calls).toHaveLength(2);
    expect(reopened.get('invoice-print:markInvoicePrinted:101')?.sourceResult).toEqual(first);
    expect(
      Buffer.isBuffer(
        (
          reopened.get('invoice-print:markInvoicePrinted:101')?.sourceResult as {
            pdf: unknown;
          }
        ).pdf,
      ),
    ).toBe(true);
    closeTrackedQueue(reopened);
  });

  it('keeps an accepted print with failed readback unconfirmed and preserves that source outcome', async () => {
    const { calls, operations, queue, queuePath, transport } = await setup();
    const result = await operations.markInvoicePrinted('102');
    expect(result).toMatchObject({
      invoice: {
        DocumentNumber: '102',
        Note: expect.stringMatching(/could not be confirmed/),
      },
      confirmed: false,
      pdf,
    });
    expect(result.invoice).not.toHaveProperty('Sent', true);
    expect(queue.get('invoice-print:markInvoicePrinted:102')?.sourceResult).toEqual(result);
    expect(queue.get('invoice-print:markInvoicePrinted:102')?.state).toBe('pending');
    expect(calls).toEqual([
      { endpoint: 'invoices/102/print', method: 'PDF_MUTATION' },
      { endpoint: 'invoices/102', method: 'GET' },
    ]);

    closeTrackedQueue(queue);
    const reopened = await openTrackedQueue(queuePath);
    await expect(operationsFor(reopened, transport).markInvoicePrinted('102')).resolves.toEqual(
      result,
    );
    expect(calls).toHaveLength(2);
    expect(reopened.get('invoice-print:markInvoicePrinted:102')?.sourceResult).toMatchObject({
      confirmed: false,
      invoice: { DocumentNumber: '102' },
    });
    closeTrackedQueue(reopened);
  });

  it('preserves Sent false when readback succeeds and confirms the print request', async () => {
    const { calls, operations, queue, queuePath, transport } = await setup();
    const result = await operations.markInvoicePrinted('106');
    expect(result).toEqual({
      invoice: { DocumentNumber: '106', Sent: false, Source: 'readback' },
      confirmed: true,
      pdf,
    });
    expect(queue.get('invoice-print:markInvoicePrinted:106')?.sourceResult).toEqual(result);
    expect(queue.get('invoice-print:markInvoicePrinted:106')?.state).toBe('pending');
    expect(calls).toEqual([
      { endpoint: 'invoices/106/print', method: 'PDF_MUTATION' },
      { endpoint: 'invoices/106', method: 'GET' },
    ]);

    closeTrackedQueue(queue);
    const reopened = await openTrackedQueue(queuePath);
    await expect(operationsFor(reopened, transport).markInvoicePrinted('106')).resolves.toEqual(
      result,
    );
    expect(calls).toHaveLength(2);
    expect(reopened.get('invoice-print:markInvoicePrinted:106')?.sourceResult).toEqual(result);
    closeTrackedQueue(reopened);
  });

  it('records send-print and external-print as their distinct exact results and source calls', async () => {
    const { calls, operations, queue } = await setup();
    const sent = await operations.sendInvoice('103', 'print');
    expect(sent).toEqual({ DocumentNumber: '103', Sent: true, Source: 'readback' });
    expect(queue.get('invoice-print:sendInvoice:103')?.sourceResult).toEqual(sent);
    expect(queue.get('invoice-print:sendInvoice:103')?.sourceResult).not.toHaveProperty(
      'confirmed',
    );

    const external = await operations.externalPrintInvoice('104');
    expect(external).toEqual({ DocumentNumber: '104', Sent: true, Source: 'externalprint' });
    expect(queue.get('invoice-print:externalPrintInvoice:104')?.sourceResult).toEqual(external);
    expect(calls).toEqual([
      { endpoint: 'invoices/103/print', method: 'PDF_MUTATION' },
      { endpoint: 'invoices/103', method: 'GET' },
      { endpoint: 'invoices/104/externalprint', method: 'PUT' },
    ]);
    expect(queue.status().items.map(({ operation }) => operation)).toEqual([
      'sendInvoice',
      'externalPrintInvoice',
    ]);
    closeTrackedQueue(queue);
  });

  it('keeps preview PDF retrieval read-only and outside the write-intent queue', async () => {
    const { calls, operations, queue } = await setup();
    await expect(operations.getInvoicePdf('105')).resolves.toEqual(pdf);
    expect(calls).toEqual([{ endpoint: 'invoices/105/preview', method: 'PDF' }]);
    expect(queue.status().items).toEqual([]);
    closeTrackedQueue(queue);
  });
});
