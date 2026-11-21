/**
 * Opt-in routing of the invoice, offer, order and article families to
 * Fortnox's `-v2` endpoints (`/3/invoices-v2`, `/3/offers-v2`, `/3/orders-v2`,
 * `/3/articles-v2`).
 *
 * Fortnox added the v2 families for bundle articles ("paketartiklar"). The
 * classic endpoints do not understand bundles: a bundle sent to them is
 * dissolved into its contained articles, and Fortnox says the classic versions
 * will be deprecated at an unannounced date. The v2 families otherwise keep the
 * same envelopes, field names, actions and filters.
 *
 * v2 is the default. Set `NOXCTL_FORTNOX_DOCUMENT_API=classic` to fall back to
 * the classic endpoints while Fortnox still serves them. The value is read on
 * every call so that one process can be switched without rebuilding operations.
 */
export const DOCUMENT_API_ENV = 'NOXCTL_FORTNOX_DOCUMENT_API';

export type DocumentApiVersion = 'classic' | 'v2';

export type DocumentFamily = 'invoices' | 'offers' | 'orders' | 'articles';

/** Raised for an unrecognized NOXCTL_FORTNOX_DOCUMENT_API value; no request is made. */
export class InvalidDocumentApiEnvError extends Error {
  constructor() {
    super(
      `${DOCUMENT_API_ENV} has an invalid value. Leave it unset or use v2 for the Fortnox v2 document endpoints, or use classic for the classic endpoints.`,
    );
    this.name = 'InvalidDocumentApiEnvError';
  }
}

/**
 * Parse NOXCTL_FORTNOX_DOCUMENT_API. Unset or empty means v2. Any value
 * other than classic or v2 (any case) throws, so a typo can never silently send
 * writes to an endpoint the user did not choose. The rejected value is not echoed.
 */
export function parseDocumentApiEnv(value: string | undefined): DocumentApiVersion {
  if (value === undefined || value === '') return 'v2';
  const normalized = value.toLowerCase();
  if (normalized === 'classic') return 'classic';
  if (normalized === 'v2') return 'v2';
  throw new InvalidDocumentApiEnvError();
}

/** The configured document API version, read from the environment on each call. */
export function documentApiVersion(): DocumentApiVersion {
  return parseDocumentApiEnv(process.env[DOCUMENT_API_ENV]);
}

/** Collection path for a document family under the configured API version. */
export function documentResource(family: DocumentFamily): string {
  return documentApiVersion() === 'v2' ? `${family}-v2` : family;
}
