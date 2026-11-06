import { describe, expect, it } from 'vitest';
import type { ShadowBinding, ShadowRecord } from '../../src/shadow/types.js';
import { resolveShadowIdentity } from '../../src/shadow/identity.js';

const binding: ShadowBinding = {
  sourceCompany: 'source-company',
  targetCompany: 'target-company',
};
const targetId = '550e8400-e29b-41d4-a716-446655440000';

type Fixture = {
  kind: 'customer' | 'supplier' | 'invoice' | 'invoice-payment';
  operation: string;
  sourceField: string;
  sourceId: string | number;
};

function makeRecord(fixture: Fixture, overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    version: 1,
    id: `intent-${fixture.operation}`,
    operation: fixture.operation,
    args: [{ Name: 'Args must not define identity' }],
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    requestHash: 'request-hash',
    state: 'applied',
    createdAt: 1,
    updatedAt: 2,
    sourceResult: { [fixture.sourceField]: fixture.sourceId },
    targetId,
    targetReceipt: { data: { id: targetId } },
    ...overrides,
  };
}

const fixtures: Fixture[] = [
  {
    kind: 'customer',
    operation: 'createCustomer',
    sourceField: 'CustomerNumber',
    sourceId: 'C-001',
  },
  {
    kind: 'supplier',
    operation: 'createSupplier',
    sourceField: 'SupplierNumber',
    sourceId: 'S-001',
  },
  { kind: 'invoice', operation: 'createInvoice', sourceField: 'DocumentNumber', sourceId: 'I-001' },
  { kind: 'invoice', operation: 'creditInvoice', sourceField: 'DocumentNumber', sourceId: 'I-002' },
  {
    kind: 'invoice-payment',
    operation: 'createInvoicePayment',
    sourceField: 'Number',
    sourceId: 'P-001',
  },
];

describe('resolveShadowIdentity', () => {
  it.each(fixtures)('resolves the persisted $kind identity from $operation receipt', (fixture) => {
    const record = makeRecord(fixture);

    expect(
      resolveShadowIdentity([record], binding, fixture.kind, fixture.sourceId as string),
    ).toEqual({
      state: 'ready',
      resource: fixture.kind,
      sourceId: fixture.sourceId,
      targetId,
      intentId: record.id,
      requestHash: record.requestHash,
      sourceCompany: binding.sourceCompany,
      targetCompany: binding.targetCompany,
      ...(fixture.kind === 'customer'
        ? {
            sourceCustomer: {
              Name: '',
              OrganisationNumber: '',
              Phone1: '',
              Phone2: '',
              Address1: '',
              Address2: '',
              ZipCode: '',
              City: '',
            },
          }
        : {}),
    });
  });

  it('normalizes positive safe numeric receipt IDs to decimal strings', () => {
    const fixture: Fixture = {
      kind: 'customer',
      operation: 'createCustomer',
      sourceField: 'CustomerNumber',
      sourceId: 27,
    };
    const record = makeRecord(fixture);

    expect(resolveShadowIdentity([record], binding, 'customer', '27')).toMatchObject({
      state: 'ready',
      sourceId: '27',
    });
    expect(resolveShadowIdentity([record], binding, 'customer', '027')).toEqual({
      state: 'missing',
    });
  });

  it('preserves exact string IDs, including leading zeros and case', () => {
    const fixture: Fixture = {
      kind: 'customer',
      operation: 'createCustomer',
      sourceField: 'CustomerNumber',
      sourceId: '001AbC',
    };
    const record = makeRecord(fixture);

    expect(resolveShadowIdentity([record], binding, 'customer', '001AbC')).toMatchObject({
      state: 'ready',
      sourceId: '001AbC',
    });
    expect(resolveShadowIdentity([record], binding, 'customer', '1AbC')).toEqual({
      state: 'missing',
    });
    expect(resolveShadowIdentity([record], binding, 'customer', '001abc')).toEqual({
      state: 'missing',
    });
  });

  it('returns missing for an empty history and ignores non-creator operations', () => {
    const fixture = fixtures[0]!;
    const unrelated = makeRecord(fixture, { operation: 'updateCustomer', id: 'update-intent' });
    const creation = makeRecord(fixture);
    const unrelatedOperations = [
      'updateCustomer',
      'externalPrintInvoice',
      'bookkeepInvoice',
      'bookkeepInvoicePayment',
    ].map((operation) => makeRecord(fixture, { operation, id: `${operation}-intent` }));

    expect(resolveShadowIdentity([], binding, 'customer', 'C-001')).toEqual({ state: 'missing' });
    expect(resolveShadowIdentity([unrelated], binding, 'customer', 'C-001')).toEqual({
      state: 'missing',
    });
    expect(
      resolveShadowIdentity([creation, ...unrelatedOperations], binding, 'customer', 'C-001'),
    ).toMatchObject({ state: 'ready', intentId: creation.id });
  });

  it('uses only the source result and never the business arguments as identity evidence', () => {
    const record = makeRecord(fixtures[0]!, { args: ['C-001'], sourceResult: undefined });

    expect(resolveShadowIdentity([record], binding, 'customer', 'C-001')).toEqual({
      state: 'missing',
    });
  });

  it.each([
    ['source company', { sourceCompany: 'other-source' }],
    ['target company', { targetCompany: 'other-target' }],
  ])('fails closed when a relevant record has a different %s', (_label, override) => {
    const unrelatedSource = makeRecord(fixtures[0]!, {
      sourceResult: { CustomerNumber: 'another-customer' },
      ...override,
    });

    expect(() => resolveShadowIdentity([unrelatedSource], binding, 'customer', 'C-001')).toThrow(
      /binding/i,
    );
  });

  it.each([
    ['source', { sourceCompany: '' }],
    ['target', { targetCompany: '   ' }],
  ])('rejects an empty host %s company binding', (_label, override) => {
    expect(() =>
      resolveShadowIdentity([], { ...binding, ...override }, 'customer', 'C-001'),
    ).toThrow(/binding/i);
  });

  it.each([
    'prepared',
    'source_in_flight',
    'source_unknown',
    'pending',
    'retry_wait',
    'target_in_flight',
    'target_unknown',
    'blocked',
  ] as const)(
    'does not resolve a creator in %s state even with durable target evidence',
    (state) => {
      const record = makeRecord(fixtures[0]!, { state });

      expect(resolveShadowIdentity([record], binding, 'customer', 'C-001')).toMatchObject({
        state: 'unresolved',
        intentIds: [record.id],
      });
    },
  );

  it.each([
    ['missing target id', { targetId: undefined }],
    ['malformed target id', { targetId: 'customer-1' }],
    ['missing receipt', { targetReceipt: undefined }],
    ['non-object receipt data', { targetReceipt: { data: [] } }],
    ['missing receipt id', { targetReceipt: { data: {} } }],
    ['mismatched receipt id', { targetReceipt: { data: { id: 'different-id' } } }],
    ['missing record id', { id: '' }],
    ['missing request hash', { requestHash: '' }],
  ])('leaves applied creator with %s unresolved', (_label, override) => {
    const record = makeRecord(fixtures[0]!, override);

    expect(resolveShadowIdentity([record], binding, 'customer', 'C-001')).toMatchObject({
      state: 'unresolved',
      intentIds: [record.id],
    });
  });

  it.each([
    '00000000-0000-0000-0000-000000000000',
    '550e8400-e29b-01d4-a716-446655440000',
    '550e8400-e29b-41d4-0716-446655440000',
  ])('rejects a UUID with an invalid version or variant: %s', (invalidTargetId) => {
    const record = makeRecord(fixtures[0]!, {
      targetId: invalidTargetId,
      targetReceipt: { data: { id: invalidTargetId } },
    });

    expect(resolveShadowIdentity([record], binding, 'customer', 'C-001')).toMatchObject({
      state: 'unresolved',
      intentIds: [record.id],
    });
  });

  it.each([
    ['same target', targetId],
    ['different target', '7a1c89b0-d2f3-41c6-a7f1-879a44c3d177'],
  ])(
    'reports multiple matching creator intents with %s as a conflict',
    (_label, duplicateTarget) => {
      const first = makeRecord(fixtures[0]!, { id: 'first-intent' });
      const second = makeRecord(fixtures[0]!, {
        id: 'second-intent',
        targetId: duplicateTarget,
        targetReceipt: { data: { id: duplicateTarget } },
      });

      expect(resolveShadowIdentity([first, second], binding, 'customer', 'C-001')).toMatchObject({
        state: 'conflict',
        intentIds: ['first-intent', 'second-intent'],
      });
    },
  );

  it('detects a same-kind target UUID reused by a different source receipt in target_unknown state', () => {
    const selected = makeRecord(fixtures[0]!, { id: 'selected-intent' });
    const reused = makeRecord(
      { ...fixtures[0]!, sourceId: 'C-002' },
      { id: 'unknown-intent', state: 'target_unknown', targetReceipt: undefined },
    );

    expect(resolveShadowIdentity([selected, reused], binding, 'customer', 'C-001')).toMatchObject({
      state: 'conflict',
      intentIds: ['selected-intent', 'unknown-intent'],
    });
  });

  it('treats same-kind target reuse with an unknown source receipt as a conflict', () => {
    const selected = makeRecord(fixtures[0]!, { id: 'selected-intent' });
    const unknownSource = makeRecord(fixtures[0]!, {
      id: 'unknown-source-intent',
      state: 'target_unknown',
      sourceResult: undefined,
      targetReceipt: undefined,
    });

    expect(
      resolveShadowIdentity([selected, unknownSource], binding, 'customer', 'C-001'),
    ).toMatchObject({
      state: 'conflict',
      intentIds: ['selected-intent', 'unknown-source-intent'],
    });
  });

  it('allows the same target UUID for a different resource kind', () => {
    const customer = makeRecord(fixtures[0]!);
    const supplier = makeRecord(fixtures[1]!, {
      id: 'supplier-intent',
      targetId,
      targetReceipt: { data: { id: targetId } },
    });

    expect(resolveShadowIdentity([customer, supplier], binding, 'customer', 'C-001')).toMatchObject(
      {
        state: 'ready',
        resource: 'customer',
        intentId: customer.id,
      },
    );
  });

  it('does not mutate records or their receipts', () => {
    const record = makeRecord(fixtures[0]!);
    const records = [record];
    const before = structuredClone(records);

    resolveShadowIdentity(records, binding, 'customer', 'C-001');

    expect(records).toEqual(before);
  });

  it.each(['', ' C-001', 'C-001 ', 'C-\u00001', 'x'.repeat(201)])(
    'rejects invalid query source ID %j',
    (sourceId) => {
      expect(() => resolveShadowIdentity([], binding, 'customer', sourceId)).toThrow(/source/i);
    },
  );

  it('rejects numeric query IDs and invalid resource kinds', () => {
    expect(() => resolveShadowIdentity([], binding, 'customer', 1 as unknown as string)).toThrow(
      /source/i,
    );
    expect(() => resolveShadowIdentity([], binding, 'archive' as 'customer', 'C-001')).toThrow(
      /kind/i,
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'does not match invalid numeric receipt ID %s',
    (sourceId) => {
      const record = makeRecord({ ...fixtures[0]!, sourceId });

      expect(resolveShadowIdentity([record], binding, 'customer', '1')).toEqual({
        state: 'missing',
      });
    },
  );

  it.each(['', ' C-001', 'C-001 ', 'C-\u00001', 'x'.repeat(201)])(
    'ignores invalid string source receipt ID %j',
    (sourceId) => {
      const record = makeRecord({ ...fixtures[0]!, sourceId });

      expect(resolveShadowIdentity([record], binding, 'customer', 'C-001')).toEqual({
        state: 'missing',
      });
    },
  );
});

describe('customer source address evidence', () => {
  it('exposes the confirmed source customer address on the ready resolution', () => {
    const record = makeRecord({
      kind: 'customer',
      operation: 'createCustomer',
      sourceField: 'CustomerNumber',
      sourceId: 'C-ADDR',
    });
    record.sourceResult = {
      CustomerNumber: 'C-ADDR',
      Name: 'Exempel AB',
      OrganisationNumber: '556000-0000',
      Address1: 'Testgatan 1',
      ZipCode: '11122',
      City: 'Teststad',
    };
    expect(resolveShadowIdentity([record], binding, 'customer', 'C-ADDR')).toMatchObject({
      state: 'ready',
      sourceCustomer: {
        Name: 'Exempel AB',
        OrganisationNumber: '556000-0000',
        Phone1: '',
        Phone2: '',
        Address1: 'Testgatan 1',
        Address2: '',
        ZipCode: '11122',
        City: 'Teststad',
      },
    });
  });
});
