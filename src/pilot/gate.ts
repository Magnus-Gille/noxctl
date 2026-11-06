import type { FortnoxTransport } from '../fortnox-client.js';
import type { ShadowStatus } from '../shadow/types.js';

export interface WriteGateInput {
  queue: { status(): ShadowStatus };
  /** Staged MCP calls in these states block new writes (counted by the host, own call excluded). */
  stagedStatus?: { executing: number; unknown: number };
  now: () => number;
  maxAgeMs?: number;
  storageOk: boolean;
  /** The one record a drain-one is about to take; its own pending state is not a refusal. */
  exceptId?: string;
  /** States of `exceptId` that do not refuse (default: pending, retry_wait). */
  exceptStates?: readonly string[];
}
export type GateResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      oldest?: { id: string; state: string; ageMs: number };
    };

const REFUSING = new Set([
  'blocked',
  'source_unknown',
  'source_in_flight',
  'target_unknown',
  'target_in_flight',
  'prepared',
  'retry_wait',
  'deferred',
]);

export function checkWriteGate(input: WriteGateInput): GateResult {
  const maxAgeMs = input.maxAgeMs ?? 86_400_000;
  const staged = input.stagedStatus;
  if (staged && (staged.executing > 0 || staged.unknown > 0))
    return { ok: false, reason: 'a staged call is executing or has an unknown outcome' };
  const items = input.queue.status().items;
  for (const item of items) {
    if (
      item.id === input.exceptId &&
      (input.exceptStates ?? ['pending', 'retry_wait']).includes(item.state)
    )
      continue;
    if (REFUSING.has(item.state))
      return {
        ok: false,
        reason: `record ${item.id} is ${item.state}; resolve it before any new write`,
        oldest: {
          id: item.id,
          state: item.state,
          ageMs: Math.max(0, input.now() - item.createdAt),
        },
      };
  }
  const oldest = items.find(
    (item) =>
      item.id !== input.exceptId && item.state !== 'applied' && item.state !== 'source_cancelled',
  );
  if (oldest) {
    const ageMs = Math.max(0, input.now() - oldest.createdAt);
    if (ageMs > maxAgeMs)
      return {
        ok: false,
        reason: `oldest unapplied record ${oldest.id} is older than the allowed backlog age`,
        oldest: { id: oldest.id, state: oldest.state, ageMs },
      };
  }
  if (!input.storageOk)
    return { ok: false, reason: 'storage or backup failed; run `backup` after fixing it' };
  return { ok: true };
}

/** Exact comparison, nothing normalized. Any failure to read is a refusal. */
export async function checkFortnoxCompany(
  transport: Pick<FortnoxTransport, 'request'>,
  expectedOrgNr: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const data = await transport.request<{ CompanyInformation?: Record<string, unknown> }>(
      'companyinformation',
    );
    return data?.CompanyInformation?.OrganizationNumber === expectedOrgNr
      ? { ok: true }
      : { ok: false, reason: 'Fortnox organization number does not match the pilot binding' };
  } catch {
    return { ok: false, reason: 'Fortnox company identity could not be read' };
  }
}
