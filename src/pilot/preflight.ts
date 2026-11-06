/**
 * Mapping preflight (NOX-215): runs the real Accounted mapping on the PLANNED arguments of a staged
 * Fortnox write, before Fortnox is contacted. It refuses only on input-level grounds; everything
 * that can only be decided from the real Fortnox response is left to the post-write mapping.
 */
import { decode, canonicalEncode } from '../shadow/codec.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../shadow/identity.js';
import { CUSTOMER_COUNTRY_UNVERIFIED } from '../shadow/accounted-adapter.js';
import { preflightInvoiceDraft } from '../shadow/invoice-draft-mapping.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord } from '../shadow/types.js';

export interface PreflightDeps {
  binding: ShadowBinding;
  adapterFor(operation: string): ShadowAdapter | undefined;
  resolveIdentity(resource: ShadowResourceKind, sourceId: string): ShadowIdentityResolution;
  now(): number;
}

/** Tool arguments that are not part of the Fortnox payload (the queue never stores them). */
const CONTROL_KEYS = new Set(['confirm', 'dryRun', 'includeRaw']);

/** The arguments exactly as the queue will store them: the Fortnox payload, without control keys. */
export function plannedPayload(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_KEYS.has(key)));
}

/** Returns a refusal reason, or undefined when the planned write may proceed. */
export function preflightStagedCall(
  deps: PreflightDeps,
  operation: string,
  args: Record<string, unknown>,
): string | undefined {
  const payload = decode(canonicalEncode(plannedPayload(args))) as Record<string, unknown>;
  const at = deps.now();
  const provisional = (sourceResult: Record<string, unknown>): ShadowRecord => ({
    version: 1,
    ...deps.binding,
    id: 'preflight',
    operation,
    args: [payload],
    requestHash: 'preflight',
    state: 'pending',
    createdAt: at,
    updatedAt: at,
    sourceResult,
  });
  try {
    if (operation === 'createCustomer') return preflightCustomer(deps, payload, provisional);
    if (operation === 'createInvoice') {
      const result = preflightInvoiceDraft(
        provisional({
          ...payload,
          Booked: false,
          Sent: false,
          Cancelled: false,
          DocumentNumber: '1',
        }),
        deps.binding,
        (resource, sourceId) => deps.resolveIdentity(resource, sourceId),
      );
      return 'blocked' in result ? result.blocked : undefined;
    }
  } catch (error) {
    return `Preflight failed (${error instanceof Error ? error.name : 'Error'})`;
  }
  return `Operation ${operation} has no preflight`;
}

function preflightCustomer(
  deps: PreflightDeps,
  payload: Record<string, unknown>,
  provisional: (sourceResult: Record<string, unknown>) => ShadowRecord,
): string | undefined {
  const adapter = deps.adapterFor('createCustomer');
  if (!adapter) return 'No customer mapping is available';
  // A given CustomerNumber must still be free; otherwise Fortnox assigns it and it is unknown here.
  const given = payload.CustomerNumber;
  if (typeof given === 'string' && deps.resolveIdentity('customer', given).state !== 'missing')
    return `Customer ${given} already has a queue record`;
  // Fields the arguments do not name are decided by Fortnox. Assume the values the mapping accepts
  // for them, so that only what the arguments themselves say can be refused here.
  const source = {
    Type: 'COMPANY',
    CountryCode: 'SE',
    ...payload,
    CustomerNumber: typeof given === 'string' ? given : 'PREFLIGHT',
  };
  const prepared = adapter.prepare(provisional(source));
  if (!('blocked' in prepared)) return undefined;
  if (!prepared.blocked.startsWith(CUSTOMER_COUNTRY_UNVERIFIED)) return prepared.blocked;
  // The country rule needs Currency/VATType from the response, which the arguments cannot carry.
  // Satisfy it with placeholders and still report every other input error.
  const rerun = adapter.prepare(provisional({ ...source, Currency: 'SEK', VATType: 'SEVAT' }));
  return 'blocked' in rerun ? rerun.blocked : undefined;
}
