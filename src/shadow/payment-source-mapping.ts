import { z } from 'zod';
import { canonicalEncode } from './codec.js';
import { copy, digest } from './payment-queue-plan.js';
import { projectInvoicePaymentLifecycle } from './payment-source-lifecycle.js';
import type { InvoiceDraftExpected } from './invoice-draft-mapping.js';
import type { ShadowBinding, ShadowPaymentGroup } from './types.js';

export interface CapturedPaymentVoucher {
  sourceCompany: string;
  financialYearId: string | number;
  data: unknown;
}
export interface BookedPaymentPlan {
  sourcePaymentId: string;
  sourceInvoiceId: string;
  paymentDate: string;
  amount: number;
  currency: 'SEK';
  sourceVoucher: { year: string; series: string; number: string; hash: string };
  lines: Array<{
    account_number: string;
    debit_amount: number;
    credit_amount: number;
    dimensions: Record<string, string>;
  }>;
}

const id = z.union([
  z.number().int().positive().safe().transform(String),
  z.string().regex(/^[1-9]\d*$/),
]);
const account = z.union([
  z.number().int().min(1000).max(9999).transform(String),
  z.string().regex(/^[1-9]\d{3}$/),
]);
const money = z
  .number()
  .finite()
  .nonnegative()
  .refine(
    (value) =>
      Number.isSafeInteger(Math.round(value * 100)) && Math.round(value * 100) / 100 === value,
  );
// Captured Fortnox payment responses use decimal strings for InvoiceTotal.
// Parse only that wire field, preserving exact cents and the original capture.
const invoiceTotal = z.union([
  money,
  z
    .string()
    .max(32)
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
    .transform((value, context) => {
      const [whole, fraction = ''] = value.split('.');
      const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
      const amount = Number(cents) / 100;
      if (cents > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(Math.round(amount * 100)) !== cents) {
        context.addIssue({ code: 'custom', message: 'InvoiceTotal cannot preserve exact cents' });
        return z.NEVER;
      }
      return amount;
    })
    .pipe(money),
]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const n = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value;
  });
const paymentSchema = z
  .object({
    Number: id,
    InvoiceNumber: id,
    Booked: z.literal(true),
    Amount: money.refine((n) => n > 0),
    AmountCurrency: money,
    Currency: z.literal('SEK'),
    CurrencyRate: z.literal(1),
    CurrencyUnit: z.literal(1),
    InvoiceTotal: invoiceTotal,
    WriteOffs: z.array(z.unknown()).length(0),
    ModeOfPaymentAccount: account.refine((n) => n === '1930'),
    PaymentDate: date,
    VoucherYear: id,
    VoucherSeries: z.string().min(1),
    VoucherNumber: id,
  })
  .passthrough();
const rowSchema = z
  .object({
    Account: account,
    Debit: money,
    Credit: money,
    Removed: z.literal(false),
    CostCenter: z.literal(''),
    Project: z.literal(''),
    Quantity: z.literal(0),
    Description: z.string(),
    TransactionInformation: z.string(),
  })
  .strict();
const voucherSchema = z
  .object({
    Year: id,
    VoucherSeries: z.string().min(1),
    VoucherNumber: id,
    ReferenceType: z.literal('INVOICEPAYMENT'),
    ReferenceNumber: id,
    TransactionDate: date,
    CostCenter: z.literal(''),
    Project: z.literal(''),
    VoucherRows: z.array(rowSchema).min(3),
  })
  .passthrough();
const expectedSchema = z.object({
  currency: z.literal('SEK'),
  document_type: z.literal('invoice'),
  payment_link_auto: z.literal(false),
  ore_rounding: z.literal(false),
  subtotal: money.refine((n) => n > 0),
  vat_amount: money.refine((n) => n > 0),
  total: money,
  remaining_amount: money,
  items: z
    .array(
      z.union([
        z.object({
          revenue_account: z.string().regex(/^3\d{3}$/),
          vat_rate: z.literal(25),
          line_total: money.refine((n) => n > 0),
          vat_amount: money,
          discount_percent: z.literal(0),
        }),
        // Purely descriptive rows carry no amount and are excluded from every total.
        z.object({
          line_type: z.literal('text'),
          line_total: z.literal(0),
          vat_amount: z.literal(0),
        }),
      ]),
    )
    .min(1),
});
const PAYMENT_KEYS = new Set([
  ...Object.keys(paymentSchema.shape),
  '@url',
  'ExternalInvoiceReference1',
  'ExternalInvoiceReference2',
  'InvoiceCustomerName',
  'InvoiceCustomerNumber',
  'InvoiceDueDate',
  'InvoiceOCR',
  'ModeOfPayment',
  'Source',
]);
const VOUCHER_KEYS = new Set([
  ...Object.keys(voucherSchema.shape),
  '@url',
  'ApprovalState',
  'Comments',
  'Description',
]);

/** Pure source comparison for the existing strict CASH/SEK invoice lane. No target access. */
export function mapBookedInvoicePayment(
  group: ShadowPaymentGroup,
  binding: ShadowBinding,
  voucher: CapturedPaymentVoucher,
  expectedInvoice: InvoiceDraftExpected,
): { request: BookedPaymentPlan } | { blocked: string } {
  let captured: CapturedPaymentVoucher;
  let sourceGroup: ShadowPaymentGroup;
  try {
    captured = copy(voucher);
    sourceGroup = copy(group);
  } catch (cause) {
    return {
      blocked: `Payment source capture cannot be encoded (${cause instanceof Error ? cause.name : 'UnknownError'})`,
    };
  }
  if (
    !sourceGroup ||
    !captured ||
    !binding ||
    typeof binding.sourceCompany !== 'string' ||
    !binding.sourceCompany.trim() ||
    captured.sourceCompany !== binding.sourceCompany
  )
    return { blocked: 'Payment voucher capture company does not match.' };
  const projection = projectInvoicePaymentLifecycle(
    sourceGroup.members,
    binding,
    sourceGroup.sourcePaymentId,
  );
  if (
    projection.state !== 'booked' ||
    projection.sourceInvoiceId !== sourceGroup.sourceInvoiceId ||
    projection.chain.length !== sourceGroup.members.length ||
    canonicalEncode(projection.sourceResult) !== canonicalEncode(sourceGroup.sourceResult)
  )
    return { blocked: 'Payment group is not the complete confirmed booked source chain.' };
  const parsedPayment = paymentSchema.safeParse(projection.sourceResult);
  const parsedVoucher = voucherSchema.safeParse(captured.data);
  const parsedYear = id.safeParse(captured.financialYearId);
  const parsedInvoice = expectedSchema.safeParse(expectedInvoice);
  if (
    !parsedPayment.success ||
    !parsedVoucher.success ||
    !parsedYear.success ||
    !parsedInvoice.success
  )
    return {
      blocked: 'Payment, voucher or strict invoice source fields are unsupported or malformed.',
    };
  const payment = parsedPayment.data;
  const entry = parsedVoucher.data;
  const invoice = parsedInvoice.data;
  if (
    !Object.keys(payment).every((key) => PAYMENT_KEYS.has(key)) ||
    !Object.keys(entry).every((key) => VOUCHER_KEYS.has(key))
  )
    return { blocked: 'Unrecognized payment or voucher fields require explicit mapping.' };
  if (
    payment.Number !== sourceGroup.sourcePaymentId ||
    payment.InvoiceNumber !== sourceGroup.sourceInvoiceId ||
    payment.Amount !== payment.AmountCurrency ||
    payment.Amount !== invoice.total ||
    payment.InvoiceTotal !== invoice.total
  )
    return { blocked: 'Only the exact full payment of this strict invoice is supported.' };
  if (
    parsedYear.data !== payment.VoucherYear ||
    entry.Year !== payment.VoucherYear ||
    entry.VoucherSeries !== payment.VoucherSeries ||
    entry.VoucherNumber !== payment.VoucherNumber ||
    entry.ReferenceNumber !== sourceGroup.sourceInvoiceId ||
    entry.TransactionDate !== payment.PaymentDate
  )
    return { blocked: 'Payment and captured voucher references/date disagree.' };
  const net = Math.round(invoice.subtotal * 100);
  const vat = Math.round(invoice.vat_amount * 100);
  const total = Math.round(invoice.total * 100);
  const credits = new Map<string, number>();
  let itemNet = 0;
  let itemVat = 0;
  for (const item of invoice.items) {
    if ('line_type' in item) continue;
    const rowNet = Math.round(item.line_total * 100);
    const rowVat = Math.round(item.vat_amount * 100);
    if (Math.round(rowNet / 4) !== rowVat)
      return { blocked: 'Invoice item VAT does not match its confirmed line amount.' };
    itemNet += rowNet;
    itemVat += rowVat;
    const accountNet = (credits.get(item.revenue_account) ?? 0) + rowNet;
    if (
      !Number.isSafeInteger(itemNet) ||
      !Number.isSafeInteger(itemVat) ||
      !Number.isSafeInteger(accountNet)
    )
      return { blocked: 'Invoice item aggregates exceed safe integer cents.' };
    credits.set(item.revenue_account, accountNet);
  }
  if (
    !Number.isSafeInteger(net + vat) ||
    net + vat !== total ||
    itemNet !== net ||
    itemVat !== vat ||
    invoice.remaining_amount !== invoice.total
  )
    return { blocked: 'Invoice item and header totals are inconsistent.' };
  credits.set('2611', vat);
  const observed = new Map<string, number>();
  let bankRows = 0;
  const lines: BookedPaymentPlan['lines'] = [];
  for (const row of entry.VoucherRows) {
    if (row.Account === '1930') {
      bankRows++;
      if (bankRows !== 1 || row.Debit !== invoice.total || row.Credit !== 0)
        return { blocked: 'Captured payment requires one exact full bank debit.' };
    } else {
      if (!credits.has(row.Account) || row.Debit !== 0 || row.Credit <= 0)
        return {
          blocked: 'Captured payment contains unsupported accounts or opposing/empty lines.',
        };
      const value = (observed.get(row.Account) ?? 0) + Math.round(row.Credit * 100);
      if (!Number.isSafeInteger(value))
        return { blocked: 'Captured payment account totals exceed safe integer cents.' };
      observed.set(row.Account, value);
    }
    lines.push({
      account_number: row.Account,
      debit_amount: row.Debit,
      credit_amount: row.Credit,
      dimensions: {},
    });
  }
  if (
    bankRows !== 1 ||
    observed.size !== credits.size ||
    [...credits].some(([account, cents]) => observed.get(account) !== cents)
  )
    return {
      blocked: 'Complete source voucher credits do not match the invoice accounts and VAT.',
    };
  return {
    request: {
      sourcePaymentId: sourceGroup.sourcePaymentId,
      sourceInvoiceId: sourceGroup.sourceInvoiceId,
      paymentDate: payment.PaymentDate,
      amount: payment.Amount,
      currency: 'SEK',
      sourceVoucher: {
        year: entry.Year,
        series: entry.VoucherSeries,
        number: entry.VoucherNumber,
        hash: digest(captured),
      },
      lines,
    },
  };
}
