import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountedMasterDataAdapter } from '../../src/shadow/accounted-adapter.js';
import { openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';
import type { ShadowRecord } from '../../src/shadow/types.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';

const binding = { sourceCompany: 'source', targetCompany: 'target' };
const targetId = '11111111-1111-4111-8111-111111111111';
const supplierClassifications = new Map([['42', 'swedish_business' as const]]);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function queueDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'master-receipt-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeRecord(resource: 'customer' | 'supplier', id: string): ShadowRecord {
  return resource === 'customer'
    ? {
        ...binding,
        id,
        version: 1,
        requestHash: `${id}-hash`,
        operation: 'createCustomer',
        args: [{ Name: 'Example AB' }],
        sourceResult: {
          Name: 'Example AB',
          Type: 'COMPANY',
          CountryCode: 'SE',
          CustomerNumber: 'C-1',
        },
        state: 'pending',
        createdAt: 1,
        updatedAt: 1,
      }
    : {
        ...binding,
        id,
        version: 1,
        requestHash: `${id}-hash`,
        operation: 'createSupplier',
        args: [{ Name: 'Example AB', CountryCode: 'SE' }],
        sourceResult: { SupplierNumber: '42', Name: 'Example AB', CountryCode: 'SE' },
        state: 'pending',
        createdAt: 1,
        updatedAt: 1,
      };
}

function adapter(request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>) {
  return new AccountedMasterDataAdapter(binding, request, supplierClassifications);
}

describe('master-data create receipt preservation', () => {
  it.each([
    ['incomplete receipt kind', 'kind'],
    ['explicit incomplete flag', 'complete'],
    ['original receipt UUID mismatch', 'id'],
    ['original receipt mapping mismatch', 'mapping'],
  ] as const)('rejects %s before GET (%s)', async (_label, failure) => {
    for (const resource of ['customer', 'supplier'] as const) {
      const record = makeRecord(resource, `${resource}-verify-${failure}`);
      const prepared = adapter(async () => ({ status: 200, json: { data: {} } })).prepare(record);
      if (!('request' in prepared)) throw new Error('Expected supported master-data mapping');
      const expected = prepared.request as Record<string, unknown>;
      const data = { id: targetId, ...expected };
      const receipt: Record<string, unknown> = { data, expected };
      if (failure === 'kind') {
        receipt.kind = 'master-data-create-incomplete';
        receipt.complete = false;
      } else if (failure === 'complete') {
        receipt.complete = false;
      } else if (failure === 'id') {
        data.id = '22222222-2222-4222-8222-222222222222';
      } else {
        data.name = 'Contradictory AB';
      }
      const request = vi.fn(async () => ({
        status: 200,
        json: { data: { id: targetId, ...expected } },
      }));
      expect(await adapter(request).verify({ ...record, targetId, targetReceipt: receipt })).toBe(
        false,
      );
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each([false, undefined, null, 0, 'true'])(
    'rejects an explicit non-true complete marker %s before GET',
    async (complete) => {
      const record = makeRecord('customer', 'marker-test');
      const request = vi.fn(async () => ({ status: 200, json: {} }));
      const instance = adapter(request);
      const prepared = instance.prepare(record);
      if (!('request' in prepared)) throw new Error('Expected supported mapping');
      const expected = prepared.request as Record<string, unknown>;
      expect(
        await instance.verify({
          ...record,
          targetId,
          targetReceipt: {
            data: { id: targetId, ...expected },
            expected,
            complete,
          },
        }),
      ).toBe(false);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['customer', 201, true],
    ['customer', 200, false],
    ['supplier', 201, true],
    ['supplier', 200, false],
  ] as const)(
    '%s %s create with a known UUID stays unknown and cannot be promoted',
    async (resource, status, mismatch) => {
      const directory = queueDirectory();
      let queue: ShadowQueue = await openShadowQueue(directory, binding);
      const record = makeRecord(resource, `${resource}-${status}-${mismatch}`);
      const calls: AccountedRequest[] = [];
      let targetData: Record<string, unknown> | undefined;
      const request = vi.fn(async (input: AccountedRequest) => {
        calls.push(input);
        if (input.method === 'POST') {
          const body = input.body as Record<string, unknown>;
          targetData = { id: targetId, ...body, ...(mismatch ? { name: 'Different AB' } : {}) };
          return { status, json: { data: { ...targetData } } };
        }
        return { status: 200, json: { data: targetData } };
      });

      try {
        await queue.execute(
          { id: record.id, operation: record.operation, args: record.args },
          async () => record.sourceResult,
        );
        expect(await queue.drainOne(adapter(request))).toBe(false);
        const unknown = queue.get(record.id);
        expect(unknown).toMatchObject({ state: 'target_unknown', targetId });
        expect(unknown?.targetReceipt).toMatchObject({
          kind: 'master-data-create-incomplete',
          version: 1,
          complete: false,
          data: { id: targetId },
          mutation: { status },
        });
        expect(calls.map(({ method }) => method)).toEqual(['POST']);
        const followerId = `${record.id}-follower`;
        await queue.execute(
          { id: followerId, operation: record.operation, args: record.args },
          async () => record.sourceResult,
        );
        expect(queue.get(followerId)?.state).toBe('pending');

        queue.close();
        queue = await openShadowQueue(directory, binding);
        expect(queue.get(record.id)).toMatchObject({
          state: 'target_unknown',
          targetId,
          targetReceipt: {
            kind: 'master-data-create-incomplete',
            complete: false,
            mutation: { status },
          },
        });
        targetData = { id: targetId, ...(calls[0].body as Record<string, unknown>) };
        expect(await queue.drainOne(adapter(request))).toBe(false);
        expect(await queue.reconcileTarget(record.id, adapter(request))).toBe(false);
        expect(queue.get(record.id)?.state).toBe('target_unknown');
        expect(queue.get(followerId)?.state).toBe('pending');
        expect(calls.map(({ method }) => method)).toEqual(['POST']);
      } finally {
        queue.close();
      }
    },
  );

  it.each(['customer', 'supplier'] as const)(
    '%s valid create receipt still reconciles by GET after the initial readback fails',
    async (resource) => {
      const directory = queueDirectory();
      let queue: ShadowQueue = await openShadowQueue(directory, binding);
      const record = makeRecord(resource, `${resource}-valid-readback-outage`);
      const calls: AccountedRequest[] = [];
      let readable = false;
      let targetData: Record<string, unknown> | undefined;
      const request = vi.fn(async (input: AccountedRequest) => {
        calls.push(input);
        if (input.method === 'POST') {
          targetData = { id: targetId, ...(input.body as Record<string, unknown>) };
          return { status: 201, json: { data: targetData } };
        }
        return readable ? { status: 200, json: { data: targetData } } : { status: 503, json: {} };
      });

      try {
        await queue.execute(
          { id: record.id, operation: record.operation, args: record.args },
          async () => record.sourceResult,
        );
        expect(await queue.drainOne(adapter(request))).toBe(false);
        expect(queue.get(record.id)).toMatchObject({
          state: 'target_unknown',
          targetId,
          targetReceipt: { data: { id: targetId }, expected: expect.any(Object) },
        });
        queue.close();
        queue = await openShadowQueue(directory, binding);
        readable = true;
        expect(await queue.reconcileTarget(record.id, adapter(request))).toBe(true);
        expect(queue.get(record.id)?.state).toBe('applied');
        expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET', 'GET']);
      } finally {
        queue.close();
      }
    },
  );
});
