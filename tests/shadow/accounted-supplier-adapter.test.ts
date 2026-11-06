import { describe, expect, it, vi } from 'vitest';
import { AccountedMasterDataAdapter } from '../../src/shadow/accounted-adapter.js';
import { TargetNotDispatchedError, TargetReceiptPendingError } from '../../src/shadow/types.js';
import type { ShadowRecord } from '../../src/shadow/types.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';

const binding = { sourceCompany: 'source', targetCompany: 'target' };
const targetId = '11111111-1111-4111-8111-111111111111';
const supplier: ShadowRecord = {
  ...binding,
  id: 'supplier-intent',
  version: 1,
  requestHash: 'supplier-hash',
  operation: 'createSupplier',
  args: [{ Name: 'Synthetic AB', CountryCode: 'SE' }],
  sourceResult: { SupplierNumber: '42', Name: 'Synthetic AB', CountryCode: 'SE' },
  state: 'pending',
  createdAt: 1,
  updatedAt: 1,
};
const classifications = new Map([['42', 'swedish_business' as const]]);

describe('AccountedMasterDataAdapter', () => {
  it('creates a classified supplier, persists its native UUID and verifies it with GET only', async () => {
    let data: unknown;
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'POST') data = { id: targetId, ...(input.body as object) };
      return { status: input.method === 'POST' ? 201 : 200, json: { data } };
    });
    const adapter = new AccountedMasterDataAdapter(binding, request, classifications);
    const prepared = adapter.prepare(supplier);
    expect(prepared).toEqual({
      request: { name: 'Synthetic AB', country: 'SE', supplier_type: 'swedish_business' },
    });
    if (!('request' in prepared)) throw new Error('Expected supported supplier');
    const receipt = await adapter.apply(supplier, prepared.request);
    expect(receipt.targetId).toBe(targetId);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/companies/target/suppliers',
      idempotencyKey: expect.stringMatching(/^shadow_[a-f0-9]{64}$/),
    });
    expect(request.mock.calls[1][0]).toEqual({
      method: 'GET',
      path: `/api/v1/companies/target/suppliers/${targetId}`,
    });
    expect(await adapter.verify({ ...supplier, targetId, targetReceipt: receipt.receipt })).toBe(
      true,
    );
    expect(request.mock.calls.map(([r]) => r.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each(['sourceCompany', 'targetCompany'] as const)(
    'rejects an unbound %s without target calls',
    async (field) => {
      const request = vi.fn();
      const adapter = new AccountedMasterDataAdapter(binding, request, classifications);
      const foreign = { ...supplier, [field]: 'foreign' };
      expect(adapter.prepare(foreign)).toHaveProperty('blocked');
      await expect(adapter.apply(foreign, {})).rejects.toThrow();
      expect(await adapter.verify({ ...foreign, targetId })).toBe(false);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('leaves suppliers blocked without host classification and blocks other operations', async () => {
    const request = vi.fn();
    const adapter = new AccountedMasterDataAdapter(binding, request);
    expect(adapter.prepare(supplier)).toHaveProperty('blocked');
    expect(adapter.prepare({ ...supplier, operation: 'createArticle' })).toHaveProperty('blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([429, 500, 409])(
    'does not retry HTTP %s or infer an existing supplier identity',
    async (status) => {
      const request = vi.fn(async () => ({ status, json: {} }));
      const adapter = new AccountedMasterDataAdapter(binding, request, classifications);
      const prepared = adapter.prepare(supplier);
      if (!('request' in prepared)) throw new Error('Expected supported supplier');
      await expect(adapter.apply(supplier, prepared.request)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('retains a successful supplier receipt across a readback outage without retrying POST', async () => {
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'GET') throw new TargetNotDispatchedError();
      return { status: 201, json: { data: { id: targetId, ...(input.body as object) } } };
    });
    const adapter = new AccountedMasterDataAdapter(binding, request, classifications);
    const prepared = adapter.prepare(supplier);
    if (!('request' in prepared)) throw new Error('Expected supported supplier');
    await expect(adapter.apply(supplier, prepared.request)).rejects.toBeInstanceOf(
      TargetReceiptPendingError,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed mapping and a forged persisted receipt without issuing a mutation', async () => {
    const request = vi.fn();
    const adapter = new AccountedMasterDataAdapter(binding, request, classifications);
    await expect(adapter.apply(supplier, { name: 'Wrong' })).rejects.toThrow();
    expect(
      await adapter.verify({
        ...supplier,
        targetId,
        targetReceipt: { data: { id: targetId }, expected: { name: 'Wrong' } },
      }),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('routes customers to the unchanged customer contract and copies host bindings', async () => {
    const mutableBinding = { ...binding };
    const mutableClasses = new Map(classifications);
    const request = vi.fn(async (input: AccountedRequest) => ({
      status: input.method === 'POST' ? 201 : 200,
      json: {
        data: {
          id: targetId,
          name: 'Customer AB',
          customer_type: 'swedish_business',
          customer_number: 'C1',
          country: 'SE',
        },
      },
    }));
    const adapter = new AccountedMasterDataAdapter(mutableBinding, request, mutableClasses);
    mutableBinding.targetCompany = 'foreign';
    mutableClasses.clear();
    expect(adapter.prepare(supplier)).toHaveProperty('request');
    const customer = {
      ...supplier,
      operation: 'createCustomer',
      args: [{ Name: 'Customer AB' }],
      sourceResult: {
        Name: 'Customer AB',
        Type: 'COMPANY',
        CountryCode: 'SE',
        CustomerNumber: 'C1',
      },
    };
    const prepared = adapter.prepare(customer);
    if (!('request' in prepared)) throw new Error('Expected supported customer');
    await adapter.apply(customer, prepared.request);
    expect(request.mock.calls[0][0].path).toBe('/api/v1/companies/target/customers');
    expect(adapter.prepare({ ...customer, sourceCompany: 'foreign' })).toHaveProperty('blocked');
  });
});
