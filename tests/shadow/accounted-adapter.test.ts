import { TargetNotDispatchedError } from '../../src/shadow/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { ShadowRecord } from '../../src/shadow/types.js';
import { AccountedShadowAdapter } from '../../src/shadow/accounted-adapter.js';

const companyId = 'company-123';
const sourceCustomer = {
  CustomerNumber: 'C-100',
  Name: 'Exempel AB',
  Type: 'COMPANY',
  CountryCode: 'SE',
  OrganisationNumber: '556677-8899',
  Email: 'ekonomi@example.se',
  Phone1: '+46123456789',
  Address1: 'Storgatan 1',
  City: 'Stockholm',
};

function makeRecord(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    id: 'intent-1',
    version: 1,
    operation: 'createCustomer',
    args: [{ ...sourceCustomer }],
    sourceCompany: 'source-1',
    targetCompany: companyId,
    requestHash: 'request-hash-1',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: { ...sourceCustomer },
    ...overrides,
  };
}

function apiCustomer(body: Record<string, unknown>, id = '11111111-1111-4111-8111-111111111111') {
  return { id, ...body };
}

function sortedClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortedClone(nested)]),
    );
  }
  return value;
}

describe('AccountedShadowAdapter', () => {
  it('maps a confirmed Swedish business customer and verifies the persisted record', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string }> =
      [];
    const body = {
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: 'C-100',
      org_number: '556677-8899',
      email: 'ekonomi@example.se',
      phone: '+46123456789',
      address_line1: 'Storgatan 1',
      city: 'Stockholm',
    };
    const request = vi.fn(async (input: (typeof calls)[number]) => {
      calls.push(input);
      return input.method === 'POST'
        ? { status: 201, json: { data: apiCustomer(body), meta: {} } }
        : { status: 200, json: { data: apiCustomer(body), meta: {} } };
    });
    const adapter = new AccountedShadowAdapter(companyId, request);
    const record = makeRecord();
    const prepared = adapter.prepare(record);

    expect(prepared).toEqual({ request: body });
    if (!('request' in prepared)) throw new Error('expected prepared request');
    const applied = await adapter.apply(record, sortedClone(prepared.request));

    expect(applied.targetId).toBe('11111111-1111-4111-8111-111111111111');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/companies/${companyId}/customers`,
      body,
    });
    expect(calls[0].idempotencyKey).toMatch(/^shadow_[a-f0-9]{64}$/);
    expect(calls[1]).toMatchObject({
      method: 'GET',
      path: `/api/v1/companies/${companyId}/customers/${applied.targetId}`,
    });
    expect(
      await adapter.verify({
        ...record,
        targetId: applied.targetId,
        targetReceipt: sortedClone(applied.receipt),
      }),
    ).toBe(true);
  });

  it.each([
    ['unsupported operation', { operation: 'createInvoice' }],
    ['wrong target company', { targetCompany: 'other-company' }],
    ['unsupported input field', { args: [{ ...sourceCustomer, Notes: 'do not drop' }] }],
    ['wrong customer type', { sourceResult: { ...sourceCustomer, Type: 'PERSON' } }],
    ['wrong country', { sourceResult: { ...sourceCustomer, CountryCode: 'NO' } }],
    ['missing confirmed country', { sourceResult: { ...sourceCustomer, CountryCode: undefined } }],
    ['missing confirmed name', { sourceResult: { ...sourceCustomer, Name: undefined } }],
    ['inconsistent confirmed name', { sourceResult: { ...sourceCustomer, Name: 'Other AB' } }],
  ])('blocks %s', (_label, overrides) => {
    const adapter = new AccountedShadowAdapter(companyId, vi.fn());
    expect(adapter.prepare(makeRecord(overrides as Partial<ShadowRecord>))).toHaveProperty(
      'blocked',
    );
  });

  it.each([30, '30'])('blocks unmapped Fortnox TermsOfPayment code %s', (terms) => {
    const customer = { ...sourceCustomer, TermsOfPayment: terms };
    const adapter = new AccountedShadowAdapter(companyId, vi.fn());
    const prepared = adapter.prepare(makeRecord({ args: [customer], sourceResult: customer }));

    expect(prepared).toHaveProperty('blocked');
    if ('blocked' in prepared) expect(prepared.blocked).toContain('TermsOfPayment');
  });

  it('blocks application when the response receipt or readback does not match', async () => {
    const body = {
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: 'C-100',
    };
    const request = vi.fn(async (input: { method: string }) =>
      input.method === 'POST'
        ? { status: 201, json: { data: { ...apiCustomer(body), id: 'not-a-uuid' }, meta: {} } }
        : { status: 200, json: { data: apiCustomer(body), meta: {} } },
    );
    const adapter = new AccountedShadowAdapter(companyId, request);
    const record = makeRecord({
      args: [
        { Name: sourceCustomer.Name, Type: 'COMPANY', CountryCode: 'SE', CustomerNumber: 'C-100' },
      ],
    });
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error('expected prepared request');

    await expect(adapter.apply(record, prepared.request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses one POST attempt and throws on transient failure without retrying', async () => {
    const request = vi.fn(async () => ({ status: 429, json: { error: 'rate limited' } }));
    const adapter = new AccountedShadowAdapter(companyId, request);
    const record = makeRecord();
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error('expected prepared request');

    await expect(adapter.apply(record, prepared.request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('verify is read-only and returns false for a persisted mapping mismatch', async () => {
    const expected = {
      name: 'Exempel AB',
      customer_type: 'swedish_business',
      country: 'SE',
      customer_number: 'C-100',
      org_number: '556677-8899',
      email: 'ekonomi@example.se',
      phone: '+46123456789',
      address_line1: 'Storgatan 1',
      city: 'Stockholm',
    };
    const record = makeRecord({
      targetId: '11111111-1111-4111-8111-111111111111',
      targetReceipt: {
        data: apiCustomer(expected),
        expected,
      },
    });
    const request = vi.fn(async () => ({
      status: 200,
      json: { data: apiCustomer({ ...expected, name: 'Different AB' }), meta: {} },
    }));
    const adapter = new AccountedShadowAdapter(companyId, request);

    expect(await adapter.verify(record)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }));
  });
  it('never classifies a readback outage after successful POST as a safe mutation retry', async () => {
    const record = makeRecord();
    const request = vi.fn(async (input: { method: string; body?: unknown }) => {
      if (input.method === 'POST')
        return { status: 201, json: { data: apiCustomer(input.body as Record<string, unknown>) } };
      throw new TargetNotDispatchedError();
    });
    const adapter = new AccountedShadowAdapter(companyId, request);
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error('Expected supported request');
    try {
      await adapter.apply(record, prepared.request);
      throw new Error('Expected readback failure');
    } catch (error) {
      expect(error).not.toBeInstanceOf(TargetNotDispatchedError);
      expect(error).toMatchObject({ targetId: '11111111-1111-4111-8111-111111111111' });
    }
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['x'.repeat(33), 'x'.repeat(50), ' padded '])(
    'blocks target-incompatible customer number %s before POST',
    async (number) => {
      const record = makeRecord({
        args: [{ ...sourceCustomer, CustomerNumber: number }],
        sourceResult: { ...sourceCustomer, CustomerNumber: number },
      });
      const request = vi.fn();
      const adapter = new AccountedShadowAdapter(companyId, request);
      expect(adapter.prepare(record)).toEqual({
        blocked: expect.stringMatching(/customer number/i),
      });
      await expect(adapter.apply(record, {})).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('blocks a Fortnox email value the native target schema rejects', () => {
    const record = makeRecord({
      args: [{ ...sourceCustomer, Email: 'invalid' }],
      sourceResult: { ...sourceCustomer, Email: 'invalid' },
    });
    const request = vi.fn();
    const adapter = new AccountedShadowAdapter(companyId, request);
    expect(adapter.prepare(record)).toEqual({ blocked: expect.stringMatching(/Email/) });
    expect(request).not.toHaveBeenCalled();
  });
});
