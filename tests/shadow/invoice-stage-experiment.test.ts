import { describe, expect, it } from 'vitest';
import {
  compareExpectedStage,
  projectInvoiceStage,
  type StageEvidenceInput,
} from './fixtures/invoice-stage-experiment.js';

const binding = {
  sourceCompany: 'synthetic-source-company',
  targetCompany: 'synthetic-target-company',
};
const targetId = '7c5a1d28-27cf-4b99-b0c1-3b3df43f10ae';
const sourceId = 'source-invoice-1000';
const hash = 'sha256:synthetic-amount-1250';

function createFact(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    intentId: 'intent-create-1',
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    sourceId,
    targetId,
    kind: 'create',
    outcome: 'applied',
    expectedFieldsHash: hash,
    ...overrides,
  };
}

function issueFact(overrides: Record<string, unknown> = {}) {
  return {
    seq: 2,
    intentId: 'intent-issue-1',
    sourceCompany: binding.sourceCompany,
    targetCompany: binding.targetCompany,
    sourceId,
    targetId,
    kind: 'issue',
    outcome: 'applied',
    expectedFieldsHash: hash,
    sourceReadbackConfirmed: true,
    sourceSent: true,
    targetStatus: 'sent',
    invoiceNumber: '1000',
    journalEntryId: null,
    warnings: [],
    ...overrides,
  };
}

function input(facts: unknown[]): StageEvidenceInput {
  return { binding, sourceId, facts } as StageEvidenceInput;
}

describe('synthetic invoice stage projection experiment', () => {
  it('projects exactly one applied creator as draft', () => {
    expect(projectInvoiceStage(input([createFact()]))).toMatchObject({
      stage: 'draft',
      targetId,
      expectedFieldsHash: hash,
    });
  });

  it('does not treat a sent target readback as sent without issue evidence', () => {
    const projection = projectInvoiceStage(input([createFact()]));

    expect(
      compareExpectedStage(projection, {
        status: 'sent',
        number: '1000',
        hash,
        targetId,
      }),
    ).toMatchObject({ match: false });
  });

  it('projects sent only from the complete hypothetical synthetic v1 issue proof', () => {
    expect(projectInvoiceStage(input([createFact(), issueFact()]))).toMatchObject({
      stage: 'sent',
      targetId,
      expectedFieldsHash: hash,
      invoiceNumber: '1000',
      proof: 'hypothetical-synthetic-v1',
    });
  });

  it('keeps unknown outcomes unresolved even when later evidence is applied', () => {
    expect(
      projectInvoiceStage(input([createFact({ outcome: 'unknown' }), issueFact()])),
    ).toMatchObject({ stage: 'unresolved' });
  });

  it('keeps unknown outcomes unresolved when later issue proof is incomplete', () => {
    expect(
      projectInvoiceStage(
        input([createFact({ outcome: 'unknown' }), issueFact({ warnings: undefined })]),
      ),
    ).toMatchObject({ stage: 'unresolved' });
  });

  it('allows gaps between strictly increasing sequence numbers', () => {
    expect(
      projectInvoiceStage(input([createFact({ seq: 8 }), issueFact({ seq: 21 })])),
    ).toMatchObject({ stage: 'sent' });
  });

  it.each([
    ['missing creator', [issueFact()], 'missing'],
    ['wrong source company', [createFact({ sourceCompany: 'other-source' })], 'blocked'],
    ['wrong target company', [createFact({ targetCompany: 'other-target' })], 'blocked'],
    [
      'wrong target UUID',
      [createFact(), issueFact({ targetId: '11111111-1111-4111-8111-111111111111' })],
      'blocked',
    ],
    [
      'changed amount hash',
      [createFact(), issueFact({ expectedFieldsHash: 'sha256:other-amount' })],
      'blocked',
    ],
    [
      'duplicate creator receipt',
      [createFact(), createFact({ seq: 2, intentId: 'intent-create-2' })],
      'blocked',
    ],
    [
      'duplicate transition receipt',
      [createFact(), issueFact(), issueFact({ seq: 3, intentId: 'intent-issue-2' })],
      'blocked',
    ],
    [
      'confirmed source readback with source not sent',
      [createFact(), issueFact({ sourceSent: false })],
      'blocked',
    ],
    [
      'source readback not confirmed',
      [createFact(), issueFact({ sourceReadbackConfirmed: false })],
      'blocked',
    ],
    ['target status is not sent', [createFact(), issueFact({ targetStatus: 'draft' })], 'blocked'],
    [
      'journal entry unexpectedly present',
      [createFact(), issueFact({ journalEntryId: 'journal-1' })],
      'blocked',
    ],
    ['warnings are present', [createFact(), issueFact({ warnings: ['unexpected'] })], 'blocked'],
  ])('does not prove a stage for %s', (_name, facts, stage) => {
    expect(projectInvoiceStage(input(facts as unknown[]))).toMatchObject({ stage });
  });

  it('requires ordered positive safe integer sequence numbers and unique intent IDs', () => {
    expect(projectInvoiceStage(input([createFact({ seq: 0 })]))).toMatchObject({
      stage: 'blocked',
    });
    expect(projectInvoiceStage(input([createFact(), issueFact({ seq: 1 })]))).toMatchObject({
      stage: 'blocked',
    });
    expect(
      projectInvoiceStage(input([createFact({ seq: 2 }), issueFact({ seq: 1 })])),
    ).toMatchObject({ stage: 'blocked' });
    expect(
      projectInvoiceStage(input([createFact(), issueFact({ intentId: 'intent-create-1' })])),
    ).toMatchObject({ stage: 'blocked' });
  });

  it('does not promote unsupported or malformed evidence', () => {
    expect(projectInvoiceStage(input([createFact({ kind: 'delete' })]))).toMatchObject({
      stage: 'blocked',
    });
    expect(projectInvoiceStage(input([createFact({ outcome: 'failed' })]))).toMatchObject({
      stage: 'blocked',
    });
    expect(projectInvoiceStage(input([createFact({ expectedFieldsHash: '' })]))).toMatchObject({
      stage: 'blocked',
    });
  });

  it('returns missing when there is no evidence', () => {
    expect(projectInvoiceStage(input([]))).toMatchObject({ stage: 'missing' });
    expect(
      projectInvoiceStage(input([createFact(), issueFact({ warnings: undefined })])),
    ).toMatchObject({ stage: 'missing' });
  });

  it('matches only the proven stage and immutable target fields', () => {
    const projection = projectInvoiceStage(input([createFact(), issueFact()]));

    expect(
      compareExpectedStage(projection, { status: 'sent', number: '1000', hash, targetId }),
    ).toMatchObject({ match: true });
    expect(
      compareExpectedStage(projection, { status: 'sent', number: '1001', hash, targetId }),
    ).toMatchObject({ match: false, reason: 'invoice-number-mismatch' });
    expect(
      compareExpectedStage(projection, { status: 'draft', number: '1000', hash, targetId }),
    ).toMatchObject({ match: false });
    expect(
      compareExpectedStage(projection, {
        status: 'sent',
        number: '1000',
        hash: 'sha256:other-amount',
        targetId,
      }),
    ).toMatchObject({ match: false });
    expect(
      compareExpectedStage(projection, {
        status: 'sent',
        number: '1000',
        hash,
        targetId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toMatchObject({ match: false });
  });

  it('requires a proven draft to remain unnumbered', () => {
    const projection = projectInvoiceStage(input([createFact()]));

    expect(
      compareExpectedStage(projection, { status: 'draft', number: null, hash, targetId }),
    ).toMatchObject({ match: true });
    expect(
      compareExpectedStage(projection, { status: 'draft', number: '1000', hash, targetId }),
    ).toMatchObject({ match: false, reason: 'draft-has-invoice-number' });
  });

  it('preserves the projection across a serialized JSON round trip', () => {
    const evidence = input([createFact(), issueFact()]);

    expect(projectInvoiceStage(JSON.parse(JSON.stringify(evidence)))).toEqual(
      projectInvoiceStage(evidence),
    );
  });
});
