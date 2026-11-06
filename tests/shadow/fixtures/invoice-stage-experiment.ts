/**
 * Test-only projection of prevalidated synthetic evidence envelopes. This helper
 * does not consume ShadowRecords or native operation receipts. Its issue proof
 * is hypothetical synthetic v1 evidence, not native validation or authority.
 */

export type StageEvidenceInput = {
  binding: { sourceCompany: string; targetCompany: string };
  sourceId: string;
  facts: unknown[];
};

export type StageProjection =
  | { stage: 'missing' | 'blocked' | 'unresolved'; reason: string }
  | {
      stage: 'draft';
      reason: string;
      targetId: string;
      expectedFieldsHash: string;
    }
  | {
      stage: 'sent';
      reason: string;
      proof: 'hypothetical-synthetic-v1';
      targetId: string;
      expectedFieldsHash: string;
      invoiceNumber: string;
    };

type NormalizedFact = {
  seq: number;
  intentId: string;
  sourceCompany: string;
  targetCompany: string;
  sourceId: string;
  targetId: string;
  kind: 'create' | 'issue';
  outcome: 'applied' | 'unknown';
  expectedFieldsHash: string;
  sourceReadbackConfirmed?: unknown;
  sourceSent?: unknown;
  targetStatus?: unknown;
  invoiceNumber?: unknown;
  journalEntryId?: unknown;
  warnings?: unknown;
};

export type ActualStage = {
  status: string;
  number: string | null;
  hash: string;
  targetId: string;
};

export type StageComparison = { match: boolean; reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function blocked(reason: string): StageProjection {
  return { stage: 'blocked', reason };
}

function missing(reason: string): StageProjection {
  return { stage: 'missing', reason };
}

function unresolved(reason: string): StageProjection {
  return { stage: 'unresolved', reason };
}

function normalizeFact(value: unknown, index: number): NormalizedFact | StageProjection {
  if (!isRecord(value)) return blocked(`fact-${index}-not-an-object`);

  if (!Number.isSafeInteger(value.seq) || (value.seq as number) <= 0) {
    return blocked(`fact-${index}-invalid-sequence`);
  }
  if (!nonEmptyString(value.intentId)) return blocked(`fact-${index}-invalid-intent-id`);
  if (!nonEmptyString(value.sourceCompany)) return blocked(`fact-${index}-invalid-source-company`);
  if (!nonEmptyString(value.targetCompany)) return blocked(`fact-${index}-invalid-target-company`);
  if (!nonEmptyString(value.sourceId)) return blocked(`fact-${index}-invalid-source-id`);
  if (!nonEmptyString(value.targetId) || !UUID_PATTERN.test(value.targetId)) {
    return blocked(`fact-${index}-invalid-target-uuid`);
  }
  if (value.kind !== 'create' && value.kind !== 'issue') {
    return blocked(`fact-${index}-unsupported-kind`);
  }
  if (value.outcome !== 'applied' && value.outcome !== 'unknown') {
    return blocked(`fact-${index}-unsupported-outcome`);
  }
  if (!nonEmptyString(value.expectedFieldsHash)) {
    return blocked(`fact-${index}-invalid-expected-fields-hash`);
  }

  return {
    seq: value.seq as number,
    intentId: value.intentId,
    sourceCompany: value.sourceCompany,
    targetCompany: value.targetCompany,
    sourceId: value.sourceId,
    targetId: value.targetId,
    kind: value.kind,
    outcome: value.outcome,
    expectedFieldsHash: value.expectedFieldsHash,
    sourceReadbackConfirmed: value.sourceReadbackConfirmed,
    sourceSent: value.sourceSent,
    targetStatus: value.targetStatus,
    invoiceNumber: value.invoiceNumber,
    journalEntryId: value.journalEntryId,
    warnings: value.warnings,
  };
}

function issueProofProblem(fact: NormalizedFact): 'missing' | 'blocked' | null {
  for (const key of [
    'sourceReadbackConfirmed',
    'sourceSent',
    'targetStatus',
    'invoiceNumber',
    'journalEntryId',
    'warnings',
  ] as const) {
    if (fact[key] === undefined) return 'missing';
  }

  if (fact.sourceReadbackConfirmed !== true || fact.sourceSent !== true) return 'blocked';
  if (fact.targetStatus !== 'sent') return 'blocked';
  if (!nonEmptyString(fact.invoiceNumber)) return 'missing';
  if (fact.journalEntryId !== null) return 'blocked';
  if (!Array.isArray(fact.warnings) || fact.warnings.length !== 0) return 'blocked';
  return null;
}

/** Project one ordered set of synthetic evidence envelopes into an expected stage. */
export function projectInvoiceStage(input: unknown): StageProjection {
  if (!isRecord(input) || !isRecord(input.binding) || !Array.isArray(input.facts)) {
    return blocked('invalid-input-envelope');
  }
  const { binding } = input;
  if (!nonEmptyString(binding.sourceCompany) || !nonEmptyString(binding.targetCompany)) {
    return blocked('invalid-binding');
  }
  if (!nonEmptyString(input.sourceId)) return blocked('invalid-source-id');
  if (input.facts.length === 0) return missing('no-evidence');

  const facts: NormalizedFact[] = [];
  for (let index = 0; index < input.facts.length; index += 1) {
    const fact = normalizeFact(input.facts[index], index);
    if ('stage' in fact) return fact;
    facts.push(fact);
  }

  const intentIds = new Set<string>();
  let previousSeq = 0;
  const targetId = facts[0]?.targetId;
  for (const fact of facts) {
    if (fact.seq <= previousSeq) return blocked('duplicate-or-out-of-order-sequence');
    previousSeq = fact.seq;
    if (intentIds.has(fact.intentId)) return blocked('duplicate-intent-id');
    intentIds.add(fact.intentId);
    if (
      fact.sourceCompany !== binding.sourceCompany ||
      fact.targetCompany !== binding.targetCompany ||
      fact.sourceId !== input.sourceId
    ) {
      return blocked('binding-or-source-mismatch');
    }
    if (fact.targetId !== targetId) return blocked('target-uuid-mismatch');
    if (fact.expectedFieldsHash !== facts[0]?.expectedFieldsHash) {
      return blocked('immutable-fields-hash-changed');
    }
  }

  const creators = facts.filter((fact) => fact.kind === 'create');
  const issues = facts.filter((fact) => fact.kind === 'issue');
  if (creators.length > 1) return blocked('duplicate-creator-receipt');
  if (issues.length > 1) return blocked('duplicate-transition-receipt');
  const creator = creators[0];
  const issue = issues[0];

  const issueProblem = issue?.outcome === 'applied' ? issueProofProblem(issue) : null;
  if (issueProblem === 'blocked') return blocked('issue-proof-contradictory');

  if (facts.some((fact) => fact.outcome === 'unknown')) {
    return unresolved('unknown-outcome-remains-unresolved');
  }
  if (issueProblem === 'missing') return missing('issue-proof-incomplete');
  if (!creator) return missing('creator-evidence-missing');
  if (creator.outcome !== 'applied') return unresolved('creator-outcome-unknown');
  if (!issue) {
    return {
      stage: 'draft',
      reason: 'exactly-one-applied-creator',
      targetId: creator.targetId,
      expectedFieldsHash: creator.expectedFieldsHash,
    };
  }
  if (issue.seq <= creator.seq) return blocked('issue-precedes-creator');
  if (issue.targetId !== creator.targetId) return blocked('issue-target-mismatch');
  if (issue.expectedFieldsHash !== creator.expectedFieldsHash) {
    return blocked('issue-immutable-fields-hash-changed');
  }

  return {
    stage: 'sent',
    reason: 'issue-readback-and-target-evidence-confirmed',
    proof: 'hypothetical-synthetic-v1',
    targetId: creator.targetId,
    expectedFieldsHash: creator.expectedFieldsHash,
    invoiceNumber: issue.invoiceNumber as string,
  };
}

/** Compare actual target state only against a stage established by this projection. */
export function compareExpectedStage(
  projection: StageProjection,
  actual: ActualStage,
): StageComparison {
  if (projection.stage !== 'draft' && projection.stage !== 'sent') {
    return { match: false, reason: 'projection-has-no-proven-stage' };
  }
  if (
    !isRecord(actual) ||
    typeof actual.status !== 'string' ||
    typeof actual.hash !== 'string' ||
    typeof actual.targetId !== 'string' ||
    !(typeof actual.number === 'string' || actual.number === null)
  ) {
    return { match: false, reason: 'actual-state-malformed' };
  }
  if (actual.status !== projection.stage) {
    return { match: false, reason: 'stage-mismatch' };
  }
  if (actual.targetId !== projection.targetId) {
    return { match: false, reason: 'target-id-mismatch' };
  }
  if (actual.hash !== projection.expectedFieldsHash) {
    return { match: false, reason: 'immutable-fields-hash-mismatch' };
  }
  if (projection.stage === 'draft' && actual.number !== null) {
    return { match: false, reason: 'draft-has-invoice-number' };
  }
  if (projection.stage === 'sent' && actual.number !== projection.invoiceNumber) {
    return { match: false, reason: 'invoice-number-mismatch' };
  }
  return { match: true, reason: 'proven-stage-and-fields-match' };
}
