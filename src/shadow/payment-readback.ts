import { z } from 'zod';
import { canonicalEncode } from './codec.js';
import type { AccountedRequestCallback } from './accounted-adapter.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const cents = z
  .number()
  .finite()
  .nonnegative()
  .refine((value) => {
    const scaled = Math.round(value * 100);
    return Number.isSafeInteger(scaled) && scaled / 100 === value;
  });
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const timestamp = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  });
const dimensions = z.record(z.string().min(1), z.string().min(1));
const line = z
  .object({
    account_number: z.string().regex(/^\d{4}$/),
    debit_amount: cents,
    credit_amount: cents,
    dimensions,
  })
  .strict();
const sourceType = z.enum(['invoice_paid', 'invoice_cash_payment']);
const expectation = z
  .object({
    companyId: uuid,
    invoiceId: uuid,
    paymentId: uuid,
    journalId: uuid,
    paymentDate: date,
    amount: cents.refine((value) => value > 0),
    currency: z.literal('SEK'),
    journalSourceType: sourceType,
    lines: z.array(line).min(2),
  })
  .strict();

export type PaymentReadbackExpected = z.infer<typeof expectation>;
type SemanticLine = z.infer<typeof line>;

const invoice = z.object({
  id: uuid,
  currency: z.literal('SEK'),
  document_type: z.literal('invoice'),
  payments: z.array(z.unknown()),
});
const payment = z.object({
  id: uuid,
  payment_date: date,
  amount: cents,
  currency: z.literal('SEK'),
  journal_entry_id: uuid,
  transaction_id: z.null(),
});
const actualLine = line
  .extend({
    id: uuid,
    currency: z.literal('SEK'),
    amount_in_currency: z.null(),
    exchange_rate: z.null(),
    tax_code: z.null(),
    cost_center: z.string().nullable(),
    project: z.string().nullable(),
  })
  .passthrough();
const journal = z.object({
  id: uuid,
  status: z.literal('posted'),
  entry_date: date,
  source_type: sourceType,
  source_id: uuid,
  reverses_id: z.null(),
  reversed_by_id: z.null(),
  correction_of_id: z.null(),
  lines: z.array(actualLine).min(2),
});
const response = z.object({ status: z.literal(200), json: z.object({ data: z.unknown() }) });

function balanced(lines: SemanticLine[]): boolean {
  let debit = 0;
  let credit = 0;
  for (const value of lines) {
    if (value.debit_amount > 0 === value.credit_amount > 0) return false;
    debit += Math.round(value.debit_amount * 100);
    credit += Math.round(value.credit_amount * 100);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) return false;
  }
  return debit > 0 && debit === credit;
}

function semanticMultiset(lines: SemanticLine[]): string[] {
  return lines
    .map(({ account_number, debit_amount, credit_amount, dimensions: tags }) =>
      canonicalEncode({ account_number, debit_amount, credit_amount, dimensions: tags }),
    )
    .sort();
}

/**
 * Compare source-backed expectations to two read-only target observations.
 * Neither an atomic remote snapshot nor authorization to retry a payment mutation.
 */
export async function verifyAccountedPaymentReadback(
  expected: PaymentReadbackExpected,
  request: AccountedRequestCallback,
): Promise<boolean> {
  // Parsing validates and detaches expectations before the first asynchronous read.
  const parsed = expectation.safeParse(expected);
  if (!parsed.success) return false;
  const plan = parsed.data;
  if (
    new Set([plan.invoiceId, plan.paymentId, plan.journalId].map((id) => id.toLowerCase())).size !==
      3 ||
    !balanced(plan.lines)
  )
    return false;

  async function read(path: string): Promise<unknown> {
    let raw: unknown;
    try {
      raw = await request({ method: 'GET', path });
    } catch (cause) {
      throw new Error('Accounted payment readback transport failed', { cause });
    }
    const result = response.safeParse(raw);
    return result.success ? result.data.json.data : undefined;
  }
  const base = `/api/v1/companies/${plan.companyId}`;
  const parent = invoice.safeParse(
    await read(`${base}/invoices/${plan.invoiceId}?expand=payments`),
  );
  if (!parent.success || parent.data.id !== plan.invoiceId) return false;
  const seen = new Set<string>();
  let selected: unknown;
  for (const row of parent.data.payments) {
    const identity = z.object({ id: uuid }).safeParse(row);
    if (!identity.success || seen.has(identity.data.id.toLowerCase())) return false;
    seen.add(identity.data.id.toLowerCase());
    if (identity.data.id === plan.paymentId) selected = row;
  }
  const row = payment.safeParse(selected);
  if (
    !row.success ||
    row.data.payment_date !== plan.paymentDate ||
    row.data.amount !== plan.amount ||
    row.data.journal_entry_id !== plan.journalId
  )
    return false;

  const posted = journal.safeParse(await read(`${base}/journal-entries/${plan.journalId}`));
  if (!posted.success) return false;
  const actual = posted.data;
  if (
    actual.id !== plan.journalId ||
    actual.entry_date !== plan.paymentDate ||
    actual.source_type !== plan.journalSourceType ||
    actual.source_id !== plan.invoiceId ||
    !balanced(actual.lines) ||
    new Set(actual.lines.map((value) => value.id.toLowerCase())).size !== actual.lines.length
  )
    return false;
  for (const value of actual.lines) {
    if (
      value.cost_center !== (value.dimensions['1'] ?? null) ||
      value.project !== (value.dimensions['6'] ?? null)
    )
      return false;
  }
  return (
    canonicalEncode(semanticMultiset(actual.lines)) ===
    canonicalEncode(semanticMultiset(plan.lines))
  );
}
