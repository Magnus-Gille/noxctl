import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalEncode } from '../../src/shadow/codec.js';
import type { ShadowBinding, ShadowRecord, ShadowSnapshotEntry } from '../../src/shadow/types.js';
import { projectInvoicePaymentLifecycle } from '../../src/shadow/payment-source-lifecycle.js';

const binding: ShadowBinding = { sourceCompany: 'source-1', targetCompany: 'target-1' };
const paymentId = '17';
const invoiceNumber = 42;

type EntryInput = {
  sequence: number;
  id: string;
  operation: string;
  args: unknown[];
  state?: ShadowRecord['state'];
  sourceResult?: unknown;
};

function entry(input: EntryInput): ShadowSnapshotEntry {
  const record: ShadowRecord = {
    ...binding,
    id: input.id,
    version: 1,
    operation: input.operation,
    args: input.args,
    requestHash: '',
    state: input.state ?? 'pending',
    createdAt: input.sequence,
    updatedAt: input.sequence,
    ...(Object.hasOwn(input, 'sourceResult') ? { sourceResult: input.sourceResult } : {}),
  };
  record.requestHash = createHash('sha256')
    .update(
      canonicalEncode({ version: 1, ...binding, operation: record.operation, args: record.args }),
    )
    .digest('hex');
  return { sequence: input.sequence, record };
}

function create(
  sequence = 1,
  number: unknown = paymentId,
  resultInvoiceNumber: unknown = invoiceNumber,
  booked: unknown = false,
): ShadowSnapshotEntry {
  return entry({
    sequence,
    id: `create-${sequence}`,
    operation: 'createInvoicePayment',
    args: [{ InvoiceNumber: invoiceNumber, Amount: 100 }],
    sourceResult: { Number: number, InvoiceNumber: resultInvoiceNumber, Booked: booked },
  });
}

describe('projectInvoicePaymentLifecycle', () => {
  it.each(['updateInvoicePayment', 'bookkeepInvoicePayment', 'deleteInvoicePayment'])(
    'does not ignore a %s receipt naming this payment when arguments name another',
    (operation) => {
      const contradictory = entry({
        sequence: 2,
        id: 'contradictory',
        operation,
        args: operation === 'updateInvoicePayment' ? ['18', { Amount: 50 }] : ['18'],
        sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
      });
      for (const booked of [false, true]) {
        const result = projectInvoicePaymentLifecycle(
          [create(1, paymentId, invoiceNumber, booked), contradictory],
          binding,
          paymentId,
        );
        expect(result.state).toBe('conflict');
        expect(result.chain.map((item) => item.intentId)).toEqual(['create-1', 'contradictory']);
      }
    },
  );

  it('waits on a created but unbooked payment and keeps the verified source result', () => {
    const sourceResult = { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false };
    const result = projectInvoicePaymentLifecycle([create()], binding, paymentId);

    expect(result).toMatchObject({
      state: 'waiting-for-bookkeeping',
      sourcePaymentId: paymentId,
      sourceInvoiceId: String(invoiceNumber),
      chain: [{ intentId: 'create-1', sequence: 1, operation: 'createInvoicePayment' }],
      sourceResult,
    });
    expect(result.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts by numeric sequence and projects a real bookkeep receipt across interleaved entries', () => {
    const entries = [
      create(2),
      entry({
        sequence: 3,
        id: 'unrelated',
        operation: 'getInvoice',
        args: [999],
        sourceResult: { Number: 999 },
      }),
      entry({
        sequence: 10,
        id: 'bookkeep',
        operation: 'bookkeepInvoicePayment',
        args: [paymentId],
        sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
      }),
    ];
    const result = projectInvoicePaymentLifecycle(entries, binding, paymentId);

    expect(result.state).toBe('booked');
    expect(result.chain.map(({ sequence }) => sequence)).toEqual([2, 10]);
    expect(result.chain.map(({ intentId }) => intentId)).toEqual(['create-2', 'bookkeep']);
    expect(result.sourceResult).toEqual({
      Number: paymentId,
      InvoiceNumber: invoiceNumber,
      Booked: true,
    });
  });

  it('marks a completed delete before booking as deleted even with an undefined source result', () => {
    const deleted = entry({
      sequence: 10,
      id: 'delete',
      operation: 'deleteInvoicePayment',
      args: [paymentId],
      sourceResult: undefined,
    });
    const result = projectInvoicePaymentLifecycle([create(2), deleted], binding, paymentId);

    expect(result.state).toBe('deleted');
    expect(result.chain.map(({ operation }) => operation)).toEqual([
      'createInvoicePayment',
      'deleteInvoicePayment',
    ]);
    expect(result.sourceResult).toBeUndefined();
  });

  it('rejects an undocumented delete response payload', () => {
    const deleted = entry({
      sequence: 2,
      id: 'delete-booked',
      operation: 'deleteInvoicePayment',
      args: [paymentId],
      sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
    });
    expect(projectInvoicePaymentLifecycle([create(), deleted], binding, paymentId).state).toBe(
      'unresolved',
    );
  });

  it.each([
    [
      'bookkeep explicitly reports false',
      [{ Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false }],
      'unresolved',
    ],
    [
      'selected update reports false',
      [{ Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false }],
      'waiting-for-bookkeeping',
    ],
  ] as const)('%s', (label, sourceResult, expectedState) => {
    const op = label.startsWith('bookkeep') ? 'bookkeepInvoicePayment' : 'updateInvoicePayment';
    const args = op === 'bookkeepInvoicePayment' ? [paymentId] : [paymentId, { Memo: 'changed' }];
    const result = projectInvoicePaymentLifecycle(
      [
        create(),
        entry({ sequence: 2, id: 'follow-up', operation: op, args, sourceResult: sourceResult[0] }),
      ],
      binding,
      paymentId,
    );
    expect(result.state).toBe(expectedState);
  });

  it.each(['prepared', 'source_in_flight', 'source_unknown'] as const)(
    'treats related %s source work as unresolved',
    (state) => {
      const inflight = entry({
        sequence: 2,
        id: `update-${state}`,
        operation: 'updateInvoicePayment',
        args: [paymentId, {}],
        state,
      });
      expect(projectInvoicePaymentLifecycle([create(), inflight], binding, paymentId).state).toBe(
        'unresolved',
      );
    },
  );

  it('conflicts on duplicate creators for a payment number', () => {
    expect(
      projectInvoicePaymentLifecycle([create(1), create(2, paymentId, 43)], binding, paymentId)
        .state,
    ).toBe('conflict');
  });

  it('conflicts when a payment update predates its observed creator', () => {
    const update = entry({
      sequence: 2,
      id: 'update-before-create',
      operation: 'updateInvoicePayment',
      args: [paymentId, {}],
      sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
    });
    const laterUpdate = entry({
      sequence: 12,
      id: 'update-after-create',
      operation: 'updateInvoicePayment',
      args: [paymentId, {}],
      sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
    });
    const result = projectInvoicePaymentLifecycle(
      [update, create(10), laterUpdate],
      binding,
      paymentId,
    );
    expect(result.state).toBe('conflict');
    expect(result.chain.map(({ intentId }) => intentId)).toEqual([
      'update-before-create',
      'create-10',
      'update-after-create',
    ]);
  });

  it.each([
    [
      'delete after booking',
      [
        create(),
        entry({
          sequence: 2,
          id: 'book',
          operation: 'bookkeepInvoicePayment',
          args: [paymentId],
          sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
        }),
        entry({
          sequence: 3,
          id: 'delete',
          operation: 'deleteInvoicePayment',
          args: [paymentId],
          sourceResult: undefined,
        }),
      ],
    ],
    [
      'update after deletion',
      [
        create(),
        entry({
          sequence: 2,
          id: 'delete',
          operation: 'deleteInvoicePayment',
          args: [paymentId],
          sourceResult: undefined,
        }),
        entry({
          sequence: 3,
          id: 'update',
          operation: 'updateInvoicePayment',
          args: [paymentId, {}],
          sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
        }),
      ],
    ],
    [
      'repeated bookkeep after booking',
      [
        create(),
        entry({
          sequence: 2,
          id: 'book',
          operation: 'bookkeepInvoicePayment',
          args: [paymentId],
          sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
        }),
        entry({
          sequence: 3,
          id: 'book-again',
          operation: 'bookkeepInvoicePayment',
          args: [paymentId],
          sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
        }),
      ],
    ],
  ])('conflicts on %s', (_label, entries) => {
    expect(projectInvoicePaymentLifecycle(entries, binding, paymentId).state).toBe('conflict');
  });

  it.each([
    ['missing creator Number', create(1, null)],
    ['invalid creator Number', create(1, '017')],
    ['creator InvoiceNumber mismatch', create(1, paymentId, 43)],
    ['non-boolean Booked', create(1, paymentId, invoiceNumber, 'false')],
  ])('leaves %s unresolved or conflicting', (label, item) => {
    expect(projectInvoicePaymentLifecycle([item], binding, paymentId).state).toBe(
      label === 'creator InvoiceNumber mismatch' ? 'conflict' : 'unresolved',
    );
  });

  it.each([0, -1, 17.5, Number.MAX_SAFE_INTEGER + 1, '0', '017', ' 17'])(
    'rejects non-canonical payment document Number %s',
    (number) => {
      expect(projectInvoicePaymentLifecycle([create(1, number)], binding, paymentId).state).toBe(
        'unresolved',
      );
    },
  );

  it('rejects a canonical update whose optional InvoiceNumber disagrees', () => {
    const update = entry({
      sequence: 2,
      id: 'update',
      operation: 'updateInvoicePayment',
      args: [paymentId, { InvoiceNumber: 43 }],
      sourceResult: { Number: paymentId, InvoiceNumber: 43, Booked: false },
    });
    expect(projectInvoicePaymentLifecycle([create(), update], binding, paymentId).state).toBe(
      'conflict',
    );
  });

  it.each([
    [
      'create',
      entry({
        sequence: 1,
        id: 'bad-create',
        operation: 'createInvoicePayment',
        args: [{ InvoiceNumber: invoiceNumber }, {}],
        sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
      }),
    ],
    [
      'update',
      entry({
        sequence: 1,
        id: 'bad-update',
        operation: 'updateInvoicePayment',
        args: [paymentId],
        sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: false },
      }),
    ],
    [
      'bookkeep',
      entry({
        sequence: 1,
        id: 'bad-bookkeep',
        operation: 'bookkeepInvoicePayment',
        args: [paymentId, {}],
        sourceResult: { Number: paymentId, InvoiceNumber: invoiceNumber, Booked: true },
      }),
    ],
    [
      'delete',
      entry({ sequence: 1, id: 'bad-delete', operation: 'deleteInvoicePayment', args: ['017'] }),
    ],
  ])('treats malformed relevant %s arguments as unresolved', (_label, item) => {
    expect(projectInvoicePaymentLifecycle([item], binding, paymentId).state).toBe('unresolved');
  });

  it.each([
    ['payment Number', { Number: '18', InvoiceNumber: invoiceNumber, Booked: false }],
    ['invoice Number', { Number: paymentId, InvoiceNumber: 43, Booked: false }],
  ])(
    'conflicts when a selected update result contradicts the %s chain identity',
    (_label, receipt) => {
      const update = entry({
        sequence: 2,
        id: 'contradictory-update',
        operation: 'updateInvoicePayment',
        args: [paymentId, {}],
        sourceResult: receipt,
      });
      expect(projectInvoicePaymentLifecycle([create(), update], binding, paymentId).state).toBe(
        'conflict',
      );
    },
  );

  it('cannot infer a selected create is unrelated when its number is missing', () => {
    expect(
      projectInvoicePaymentLifecycle([create(1, null), create(2, '18')], binding, paymentId).state,
    ).toBe('unresolved');
  });

  it('returns unresolved without a positive chain for invalid snapshots', () => {
    const malformed = create();
    malformed.record.requestHash = '0'.repeat(64);
    const result = projectInvoicePaymentLifecycle([malformed], binding, paymentId);

    expect(result).toMatchObject({ state: 'unresolved', chain: [] });
    expect(result.sourceResult).toBeUndefined();
    const duplicateSequence = [
      entry({ sequence: 1, id: 'read-a', operation: 'getInvoice', args: [1] }),
      entry({ sequence: 1, id: 'read-b', operation: 'getInvoice', args: [2] }),
    ];
    expect(projectInvoicePaymentLifecycle(duplicateSequence, binding, paymentId)).toMatchObject({
      state: 'unresolved',
      chain: [],
    });
    const duplicateIds = [
      entry({ sequence: 1, id: 'same-id', operation: 'getInvoice', args: [1] }),
      entry({ sequence: 2, id: 'same-id', operation: 'getInvoice', args: [2] }),
    ];
    expect(projectInvoicePaymentLifecycle(duplicateIds, binding, paymentId)).toMatchObject({
      state: 'unresolved',
      chain: [],
    });
  });

  it('rejects sequences that are not strictly increasing in the supplied snapshot', () => {
    expect(
      projectInvoicePaymentLifecycle([create(10), create(2)], binding, paymentId),
    ).toMatchObject({ state: 'unresolved', chain: [] });
  });

  it.each([
    [
      'whitespace-only record id',
      entry({ sequence: 1, id: ' ', operation: 'getInvoice', args: [1] }),
    ],
    [
      'control character record id',
      entry({ sequence: 1, id: 'bad\nkey', operation: 'getInvoice', args: [1] }),
    ],
    [
      'overlong record id',
      entry({ sequence: 1, id: 'x'.repeat(201), operation: 'getInvoice', args: [1] }),
    ],
  ])('rejects %s', (_label, item) => {
    expect(projectInvoicePaymentLifecycle([item], binding, paymentId)).toMatchObject({
      state: 'unresolved',
      chain: [],
    });
  });

  it.each([
    [
      'whitespace-only source company',
      { sourceCompany: ' ', targetCompany: binding.targetCompany },
    ],
    [
      'control character target company',
      { sourceCompany: binding.sourceCompany, targetCompany: 'target\n' },
    ],
    [
      'overlong source company',
      { sourceCompany: 'x'.repeat(201), targetCompany: binding.targetCompany },
    ],
  ])('rejects %s binding', (_label, invalidBinding) => {
    expect(projectInvoicePaymentLifecycle([create()], invalidBinding, paymentId)).toMatchObject({
      state: 'unresolved',
      chain: [],
    });
  });

  it('rejects malformed record binding fields', () => {
    const malformed = create();
    malformed.record.sourceCompany = ' ';
    expect(projectInvoicePaymentLifecycle([malformed], binding, paymentId)).toMatchObject({
      state: 'unresolved',
      chain: [],
    });
  });

  it('requires completed delete records to own an undefined sourceResult', () => {
    const missing = entry({
      sequence: 2,
      id: 'missing-result-delete',
      operation: 'deleteInvoicePayment',
      args: [paymentId],
    });
    const fabricated = entry({
      sequence: 2,
      id: 'fabricated-delete',
      operation: 'deleteInvoicePayment',
      args: [paymentId],
      sourceResult: {},
    });
    expect(projectInvoicePaymentLifecycle([create(), missing], binding, paymentId).state).toBe(
      'unresolved',
    );
    expect(projectInvoicePaymentLifecycle([create(), fabricated], binding, paymentId).state).toBe(
      'unresolved',
    );
  });

  it('ignores known unrelated operations but fails closed on unknown operation names', () => {
    const unrelated = entry({
      sequence: 1,
      id: 'get-invoice',
      operation: 'getInvoice',
      args: [999],
    });
    expect(projectInvoicePaymentLifecycle([unrelated], binding, paymentId).state).toBe('missing');
    const unknown = entry({
      sequence: 1,
      id: 'unknown',
      operation: 'newPaymentMutation',
      args: [],
    });
    expect(projectInvoicePaymentLifecycle([unknown], binding, paymentId).state).toBe('unresolved');
  });

  it('hashes the full snapshot and clones returned source evidence', () => {
    const created = create();
    const before = canonicalEncode(created);
    const first = projectInvoicePaymentLifecycle([created], binding, paymentId);
    const changed = entry({ ...created, id: 'unrelated-read', operation: 'getInvoice', args: [5] });
    const second = projectInvoicePaymentLifecycle([created, changed], binding, paymentId);

    expect(first.snapshotHash).not.toBe(second.snapshotHash);
    expect(canonicalEncode(created)).toBe(before);
    (first.sourceResult as Record<string, unknown>).Number = 'changed';
    expect((created.record.sourceResult as Record<string, unknown>).Number).toBe(paymentId);
  });
});
