/**
 * Lookups over the captured read-only Fortnox evidence (NOX-211): objects that a source receipt only
 * refers to (the voucher of a booked payment, the credit note of a credit). They are captured once
 * by an explicit operator step and then pinned, so a later Fortnox change cannot alter a plan.
 */
import type { CapturedPaymentVoucher } from './payment-source-mapping.js';
import type { ShadowQueue } from './queue.js';
import type { ShadowPaymentGroup } from './types.js';

const POSITIVE = /^[1-9]\d{0,17}$/;
const SERIES = /^[A-Za-z0-9]{1,10}$/;

const positive = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && POSITIVE.test(value)) return value;
  return undefined;
};

export interface PaymentVoucherRef {
  key: string;
  year: string;
  series: string;
  number: string;
}

/** The voucher reference of a booked Fortnox invoice payment, or undefined when there is none. */
export function paymentVoucherRef(payment: unknown): PaymentVoucherRef | undefined {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return undefined;
  const value = payment as Record<string, unknown>;
  if (value.Booked !== true) return undefined;
  const year = positive(value.VoucherYear);
  const number = positive(value.VoucherNumber);
  const series = typeof value.VoucherSeries === 'string' ? value.VoucherSeries : '';
  if (!year || !number || !SERIES.test(series)) return undefined;
  return { key: `${year}:${series}:${number}`, year, series, number };
}
export const paymentVoucherKey = (payment: unknown): string | undefined =>
  paymentVoucherRef(payment)?.key;

/** A credit note number as a strict positive decimal string ("0" means "no credit note"). */
export function creditNoteNumber(value: unknown): string | undefined {
  return typeof value === 'string' && POSITIVE.test(value) ? value : undefined;
}

type EvidenceReader = Pick<ShadowQueue, 'getEvidence' | 'binding'>;

/** `voucherLookup` for AccountedInvoicePaymentAdapter. The voucher year is the financial year id. */
export function evidenceVoucherLookup(
  queue: EvidenceReader,
): (group: ShadowPaymentGroup) => CapturedPaymentVoucher | undefined {
  return (group) => {
    const ref = paymentVoucherRef(group?.sourceResult);
    if (!ref) return undefined;
    const evidence = queue.getEvidence('payment-voucher', ref.key);
    if (!evidence) return undefined;
    return {
      sourceCompany: queue.binding.sourceCompany,
      financialYearId: ref.year,
      data: evidence.data,
    };
  };
}

/** `creditNoteLookup` for AccountedInvoiceCreditAdapter. */
export function evidenceCreditNoteLookup(
  queue: EvidenceReader,
): (creditDocumentNumber: string) => Record<string, unknown> | undefined {
  return (number) => {
    const key = creditNoteNumber(number);
    return key ? queue.getEvidence('credit-note', key)?.data : undefined;
  };
}
