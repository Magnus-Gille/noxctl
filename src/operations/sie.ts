import { fortnoxRequestRaw } from '../fortnox-client.js';
import { parseSie, diffSie, type SieFile, type SieDiff, type DiffOptions } from '../sie.js';

/**
 * SIE export types, per the SIE specification:
 *   1 = year-end balances, 2 = period balances,
 *   3 = object balances, 4 = balances + all vouchers.
 * Type 4 is the one that carries the full ledger, so it is the default.
 */
export type SieType = 1 | 2 | 3 | 4;

export interface ExportSieParams {
  type?: SieType;
  /** Fortnox financial year id. Defaults to the account's current year. */
  financialYear?: number;
}

/**
 * Download a SIE export from Fortnox as raw bytes.
 *
 * Kept undecoded: SIE is CP437 by spec, and writing the bytes straight to disk
 * preserves whatever Fortnox actually sent, which is what an auditor or an
 * importing system expects to receive.
 */
export async function exportSie(params: ExportSieParams = {}): Promise<Buffer> {
  const type = params.type ?? 4;
  return fortnoxRequestRaw(`sie/${type}`, {
    params: { financialyear: params.financialYear },
  });
}

export interface ShadowCompareParams extends DiffOptions {
  /** The shadow ledger's SIE export, as bytes. */
  shadow: Buffer;
  type?: SieType;
  financialYear?: number;
}

export interface ShadowCompareResult {
  fortnox: SieFile;
  shadow: SieFile;
  diff: SieDiff;
}

/**
 * Compare a shadow ledger's SIE export against a freshly pulled Fortnox one.
 *
 * This is the verification half of running two systems in parallel: book the
 * period independently in both, then let the closing balances say whether the
 * two agree.
 */
export async function compareShadowLedger(
  params: ShadowCompareParams,
): Promise<ShadowCompareResult> {
  const fortnoxBytes = await exportSie({ type: params.type, financialYear: params.financialYear });
  const fortnox = parseSie(fortnoxBytes);
  const shadow = parseSie(params.shadow);
  return {
    fortnox,
    shadow,
    diff: diffSie(fortnox, shadow, { yearIndex: params.yearIndex, tolerance: params.tolerance }),
  };
}
