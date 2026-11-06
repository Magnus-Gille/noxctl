/**
 * An operator-refused record (NOX-215): an unmappable `pending` record, still at the head of the
 * queue, that the pilot host marked `blocked` without any target contact. It stays in the queue as
 * evidence but no longer counts as the oldest unresolved record. The pilot gate additionally
 * requires a matching `refused` journal entry before it stops refusing on such a record.
 */
export const OPERATOR_REFUSED_PREFIX = 'OPERATOR_REFUSED:';

export function isOperatorRefused(record: {
  state: string;
  reason?: string;
  targetId?: string;
  targetAttempts?: number;
}): boolean {
  return (
    record.state === 'blocked' &&
    typeof record.reason === 'string' &&
    record.reason.startsWith(OPERATOR_REFUSED_PREFIX) &&
    record.targetId === undefined &&
    (record.targetAttempts ?? 0) === 0
  );
}
