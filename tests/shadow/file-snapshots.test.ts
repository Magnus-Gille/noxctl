import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFortnoxOperations } from '../../src/operations/index.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import { createQueueObserver } from '../../src/shadow/observer.js';
import type { OperationObserver } from '../../src/shadow/types.js';

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'nox-file-snapshot-'));
}

function transport(request: FortnoxTransport['request']): FortnoxTransport {
  return {
    request,
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn(),
    requestPdfFromMutation: vi.fn(),
    requestFile: vi.fn(),
    fetchAllPages: vi.fn(),
  } as unknown as FortnoxTransport;
}

async function uploadedFile(request: ReturnType<typeof vi.fn>, call = 0): Promise<File> {
  const uploadCalls = request.mock.calls.filter(
    ([, options]) => options?.rawBody instanceof FormData,
  );
  const form = uploadCalls[call]?.[1]?.rawBody as FormData;
  return form.get('file') as File;
}

async function fileBytes(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}

function gatedObserver(onDispatch: (args: unknown[]) => void): {
  observer: OperationObserver;
  release: () => void;
  started: Promise<void>;
} {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    observer: {
      async execute(_operation, args, invoke) {
        onDispatch(args);
        signalStarted();
        await gate;
        return invoke();
      },
      status: () => {
        throw new Error('not used');
      },
    },
    release: () => release(),
    started,
  };
}

describe('operation file snapshots', () => {
  it('conflicts on same-path changed bytes before a second source dispatch', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'receipt.pdf');
    writeFileSync(path, '%PDF-first');
    const request = vi.fn().mockResolvedValue({ File: { Id: 'archive-1' } });
    const queue = await openShadowQueue(join(directory, 'queue'), {
      sourceCompany: 'source',
      targetCompany: 'target',
    });
    const observer = createQueueObserver(queue, () => 'same-command:0');
    const operations = createFortnoxOperations(transport(request), observer);
    try {
      await operations.uploadArchiveFile(path);
      writeFileSync(path, '%PDF-second');
      await expect(operations.uploadArchiveFile(path)).rejects.toThrow(
        'Shadow intent identity conflict',
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(await fileBytes(await uploadedFile(request))).toEqual(Buffer.from('%PDF-first'));
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses captured bytes when the path changes while the observer is awaiting', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'receipt.pdf');
    writeFileSync(path, '%PDF-captured');
    const request = vi.fn().mockResolvedValue({});
    let seenArgs: unknown[] = [];
    const gate = gatedObserver((args) => (seenArgs = args));
    const operations = createFortnoxOperations(transport(request), gate.observer);
    try {
      const pending = operations.uploadInboxEntry(path);
      await gate.started;
      writeFileSync(path, '%PDF-replaced');
      gate.release();
      await pending;
      expect(seenArgs[0]).toMatchObject({
        fileName: 'receipt.pdf',
        content: Buffer.from('%PDF-captured'),
      });
      expect(await fileBytes(await uploadedFile(request))).toEqual(Buffer.from('%PDF-captured'));
    } finally {
      gate.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: 'default', observed: false, expected: 'replaced' },
    { mode: 'observed', observed: true, expected: 'original' },
  ] as const)(
    '$mode attachment batches keep the expected bytes across financial-year lookup',
    async ({ observed, expected }) => {
      const directory = tempDirectory();
      const first = join(directory, 'first.pdf');
      const second = join(directory, 'second.pdf');
      writeFileSync(first, 'first-original');
      writeFileSync(second, 'second-original');
      let signalYearLookup!: () => void;
      let releaseYearLookup!: () => void;
      const yearLookupStarted = new Promise<void>((resolve) => (signalYearLookup = resolve));
      const yearLookupGate = new Promise<void>((resolve) => (releaseYearLookup = resolve));
      const request = vi.fn(async (endpoint: string, options?: Record<string, unknown>) => {
        if (endpoint === 'vouchers/A/60') return { Voucher: { TransactionDate: '2026-06-01' } };
        if (endpoint === 'financialyears') {
          signalYearLookup();
          await yearLookupGate;
          return { FinancialYears: [{ Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' }] };
        }
        if (endpoint === 'inbox' && options?.method === 'POST')
          return { File: { Id: `file-${request.mock.calls.length}` } };
        if (endpoint === 'voucherfileconnections')
          return { VoucherFileConnection: { FileId: 'file' } };
        return {};
      });
      const observer: OperationObserver | undefined = observed
        ? {
            execute: (_operation, _args, invoke) => invoke(),
            status: () => {
              throw new Error('not used');
            },
          }
        : undefined;
      const operations = createFortnoxOperations(
        transport(request as FortnoxTransport['request']),
        observer,
      );
      try {
        const pending = operations.attachVoucherFiles({
          series: 'A',
          voucherNumber: '60',
          filePaths: [first, second],
        });
        await yearLookupStarted;
        writeFileSync(first, 'first-replaced');
        writeFileSync(second, 'second-replaced');
        releaseYearLookup();
        await pending;
        expect(await fileBytes(await uploadedFile(request))).toEqual(
          Buffer.from(`first-${expected}`),
        );
        expect(await fileBytes(await uploadedFile(request, 1))).toEqual(
          Buffer.from(`second-${expected}`),
        );
        expect((await uploadedFile(request)).name).toBe('first.pdf');
        expect((await uploadedFile(request, 1)).name).toBe('second.pdf');
      } finally {
        releaseYearLookup();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects missing and unsupported inputs before observer or transport dispatch', async () => {
    const request = vi.fn().mockResolvedValue({});
    const observer: OperationObserver = {
      execute: vi.fn((_operation, _args, invoke) => invoke()),
      status: () => {
        throw new Error('not used');
      },
    };
    const operations = createFortnoxOperations(transport(request), observer);
    await expect(operations.uploadArchiveFile('/missing/nox-file.pdf')).rejects.toThrow(
      /File not found/,
    );
    await expect(
      operations.uploadArchiveFile({ fileName: 'bad.pdf', content: 'not-a-buffer' } as never),
    ).rejects.toThrow(/Unsupported operation file/);
    expect(observer.execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
