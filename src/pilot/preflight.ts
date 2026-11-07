/**
 * Mapping preflight (NOX-215): runs the real Accounted mapping on the PLANNED arguments of a staged
 * Fortnox write, before Fortnox is contacted. It refuses only on input-level grounds; everything
 * that can only be decided from the real Fortnox response is left to the post-write mapping.
 */
import { decode, canonicalEncode } from '../shadow/codec.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../shadow/identity.js';
import { CUSTOMER_COUNTRY_UNVERIFIED } from '../shadow/accounted-adapter.js';
import { mapInvoiceDraft, preflightInvoiceDraft } from '../shadow/invoice-draft-mapping.js';
import { PAYMENT_OPERATIONS } from '../shadow/payment-queue-plan.js';
import type { ShadowAdapter, ShadowBinding, ShadowRecord } from '../shadow/types.js';

export interface PreflightDeps {
  binding: ShadowBinding;
  adapterFor(operation: string): ShadowAdapter | undefined;
  resolveIdentity(resource: ShadowResourceKind, sourceId: string): ShadowIdentityResolution;
  /** Read-only queue lookup; required to preflight invoice payments. */
  getRecord?(id: string): ShadowRecord | undefined;
  /** Read-only ordered queue records; required to preflight invoice payments. */
  records?(): readonly ShadowRecord[];
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
    if (operation === 'createInvoicePayment') return preflightInvoicePayment(deps, payload);
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

const PAYMENT_INPUT_KEYS = new Set(['InvoiceNumber', 'Amount', 'PaymentDate', 'Source']);
/**
 * Input-only check of a planned customer invoice payment (NOX-211). The Fortnox response decides
 * booking and voucher evidence later; here only what the arguments and the mirrored invoice say is
 * judged. It deliberately covers no more than the payment mapping supports: the exact full payment
 * of one mirrored strict invoice, once.
 */
function preflightInvoicePayment(
  deps: PreflightDeps,
  payload: Record<string, unknown>,
): string | undefined {
  const unsupported = Object.keys(payload).filter((key) => !PAYMENT_INPUT_KEYS.has(key));
  if (unsupported.length)
    return `Unsupported payment input fields: ${unsupported.sort().join(', ')}`;
  const { InvoiceNumber: number, Amount: amount, PaymentDate: date, Source: source } = payload;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)
    return 'InvoiceNumber must be a positive integer';
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.round(amount * 100) / 100 !== amount
  )
    return 'Amount must be a positive amount in whole cents';
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
  )
    return 'PaymentDate must be a real date (YYYY-MM-DD)';
  if (
    source !== undefined &&
    (typeof source !== 'string' ||
      !source.trim() ||
      source.length > 100 ||
      /[\x00-\x1f]/.test(source))
  )
    return 'Source must be a short single-line text';
  if (!deps.getRecord || !deps.records) return 'No invoice payment mapping is available';
  const sourceInvoiceId = String(number);
  const invoice = deps.resolveIdentity('invoice', sourceInvoiceId);
  if (invoice.state !== 'ready')
    return `Invoice ${sourceInvoiceId} is not mirrored (identity is ${invoice.state})`;
  const creator = deps.getRecord(invoice.intentId);
  if (!creator || creator.operation !== 'createInvoice' || creator.state !== 'applied')
    return `Invoice ${sourceInvoiceId} has no applied strict invoice record`;
  const mapped = mapInvoiceDraft(creator, deps.binding, (resource, id) =>
    deps.resolveIdentity(resource, id),
  );
  if ('blocked' in mapped)
    return `Invoice ${sourceInvoiceId} is not a supported strict invoice: ${mapped.blocked}`;
  if (mapped.expected.currency !== 'SEK') return 'Only SEK invoice payments are supported';
  if (amount !== mapped.expected.total)
    return 'Only the exact full payment of the mirrored invoice is supported';
  // One payment per invoice: any earlier payment-chain record (even a refused one) forbids another.
  const earlier = deps.records().find((record) => {
    if (!PAYMENT_OPERATIONS.has(record.operation) || record.state === 'source_cancelled')
      return false;
    const sourceNumber = (record.sourceResult as Record<string, unknown> | undefined)
      ?.InvoiceNumber;
    const argNumber = (record.args?.[0] as Record<string, unknown> | undefined)?.InvoiceNumber;
    return String(sourceNumber ?? argNumber) === sourceInvoiceId;
  });
  if (earlier) return `Invoice ${sourceInvoiceId} already has payment record ${earlier.id}`;
  return undefined;
}
