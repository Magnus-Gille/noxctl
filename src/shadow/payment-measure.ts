/**
 * Offline measurement (NOX-211): how much of a Fortnox export the invoice-payment mapping can carry.
 * Pure and counts-only: it never returns, logs or throws a value taken from the export, only fixed
 * reason labels and integers. It makes no network request and writes nothing.
 *
 * Export shape (a JSON object; arrays may also be wrapped in Fortnox list objects):
 *   InvoicePayments: Fortnox InvoicePayment objects
 *   Invoices:        full Fortnox Invoice objects (with InvoiceRows)
 *   Vouchers:        full Fortnox Voucher objects (with VoucherRows)
 *
 * The expected target invoice is DERIVED from the Fortnox invoice by a documented approximation, so
 * the result measures source-side support only. It authorizes nothing and is no substitute for the
 * queue-backed `AccountedInvoicePaymentAdapter.prepare` check.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { canonicalEncode } from './codec.js';
import type { InvoiceDraftExpected } from './invoice-draft-mapping.js';
import { mapBookedInvoicePayment, type CapturedPaymentVoucher } from './payment-source-mapping.js';
import { groupOf } from './payment-queue-plan.js';
import type { ShadowBinding } from './types.js';

export interface PaymentMeasurement {
  payments: number;
  mapped: number;
  /** Fixed reason label to count. Labels never contain export values. */
  refused: Record<string, number>;
}

const MAX_BYTES = 256 * 1024 * 1024;
const BINDING: ShadowBinding = {
  sourceCompany: 'measure-source',
  targetCompany: '00000000-0000-4000-8000-000000000000',
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function list(value: unknown, key: string): Obj[] | undefined {
  // The export must be a root object; a bare array is never read as any collection.
  if (!isObj(value)) return undefined;
  const raw = value[key];
  const items = isObj(raw) ? raw[key] : raw;
  return Array.isArray(items) && items.every(isObj) ? (items as Obj[]) : undefined;
}
/** Decimal text or number to a number; undefined when it is neither. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}
const cents = (value: number) => Math.round(value * 100) / 100;
const key = (...parts: unknown[]) => parts.map(String).join('|');

/** Fixed facets only; returns the label of the first reason the invoice is outside the strict lane. */
function deriveExpected(invoice: Obj): { expected: InvoiceDraftExpected } | { label: string } {
  if (invoice.Currency !== 'SEK') return { label: 'invoice-not-strict: currency' };
  // The invoice mapper's strict lane is CASH accounting and a standard INVOICE. A facet absent from
  // the export is not checked, so `mapped` stays an upper bound (docs/shadow-evaluation.md).
  if (invoice.AccountingMethod !== undefined && invoice.AccountingMethod !== 'CASH')
    return { label: 'invoice-not-strict: accounting-method' };
  if (invoice.InvoiceType !== undefined && invoice.InvoiceType !== 'INVOICE')
    return { label: 'invoice-not-strict: invoice-type' };
  const roundOff = num(invoice.RoundOff);
  if (roundOff === undefined || roundOff !== 0) return { label: 'invoice-not-strict: rounding' };
  const rows = invoice.InvoiceRows;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isObj))
    return { label: 'invoice-not-strict: rows' };
  const items: unknown[] = [];
  for (const row of rows as Obj[]) {
    const total = num(row.TotalExcludingVAT ?? row.Total);
    const price = num(row.Price);
    if (price === undefined || price === 0 || total === undefined) {
      // A purely descriptive row carries no amount.
      if ((price === undefined || price === 0) && (total === undefined || total === 0)) {
        items.push({ line_type: 'text', line_total: 0, vat_amount: 0 });
        continue;
      }
      return { label: 'invoice-not-strict: rows' };
    }
    if (num(row.VAT) !== 25) return { label: 'invoice-not-strict: vat-rate' };
    if ((num(row.Discount) ?? 0) !== 0) return { label: 'invoice-not-strict: discount' };
    const account = num(row.AccountNumber);
    if (account === undefined) return { label: 'invoice-not-strict: rows' };
    items.push({
      revenue_account: String(account),
      vat_rate: 25,
      line_total: total,
      vat_amount: cents(total / 4),
      discount_percent: 0,
    });
  }
  const total = num(invoice.Total);
  const net = num(invoice.Net);
  const vat = num(invoice.TotalVAT);
  if (total === undefined || net === undefined || vat === undefined)
    return { label: 'invoice-not-strict: totals' };
  return {
    expected: {
      currency: 'SEK',
      document_type: 'invoice',
      payment_link_auto: false,
      ore_rounding: false,
      subtotal: net,
      vat_amount: vat,
      total,
      remaining_amount: total,
      items,
    } as unknown as InvoiceDraftExpected,
  };
}

/** Static mapping reasons only; strips any trailing parenthesised detail. */
const label = (reason: string) => reason.replace(/\s*\([^)]*\)\.?$/, '').replace(/\.$/, '');

export function measurePaymentMapping(data: unknown): PaymentMeasurement {
  const out: PaymentMeasurement = { payments: 0, mapped: 0, refused: {} };
  const refuse = (reason: string) => {
    out.refused[reason] = (out.refused[reason] ?? 0) + 1;
  };
  const payments = list(data, 'InvoicePayments');
  const invoices = list(data, 'Invoices');
  const vouchers = list(data, 'Vouchers');
  if (!payments || !invoices || !vouchers) {
    out.refused['export-shape-unsupported'] = 1;
    return out;
  }
  const invoiceByNumber = new Map(
    invoices.map((invoice) => [String(invoice.DocumentNumber), invoice]),
  );
  const voucherByKey = new Map(
    vouchers.map((voucher) => [
      key(voucher.Year, voucher.VoucherSeries, voucher.VoucherNumber),
      voucher,
    ]),
  );
  for (const payment of payments) {
    out.payments++;
    if (payment.Booked !== true) {
      refuse('payment-not-booked');
      continue;
    }
    const invoice = invoiceByNumber.get(String(payment.InvoiceNumber));
    if (!invoice) {
      refuse('invoice-missing-from-export');
      continue;
    }
    const voucher = voucherByKey.get(
      key(payment.VoucherYear, payment.VoucherSeries, payment.VoucherNumber),
    );
    if (!voucher) {
      refuse('voucher-missing-from-export');
      continue;
    }
    const derived = deriveExpected(invoice);
    if ('label' in derived) {
      refuse(derived.label);
      continue;
    }
    try {
      const args = [
        {
          InvoiceNumber: payment.InvoiceNumber,
          Amount: payment.Amount,
          PaymentDate: payment.PaymentDate,
        },
      ];
      const requestHash = createHash('sha256')
        .update(
          canonicalEncode({ version: 1, ...BINDING, operation: 'createInvoicePayment', args }),
        )
        .digest('hex');
      const group = groupOf(
        [
          {
            sequence: 1,
            record: {
              version: 1,
              ...BINDING,
              id: 'measure',
              operation: 'createInvoicePayment',
              args,
              requestHash,
              state: 'pending',
              createdAt: 0,
              updatedAt: 0,
              sourceResult: payment,
            },
          },
        ],
        BINDING,
        String(payment.Number),
        String(payment.InvoiceNumber),
      );
      const captured: CapturedPaymentVoucher = {
        sourceCompany: BINDING.sourceCompany,
        // The export carries no financial-year id; the voucher year is the only available value.
        financialYearId: voucher.Year as string | number,
        data: voucher,
      };
      const mapped = mapBookedInvoicePayment(group, BINDING, captured, derived.expected);
      if ('blocked' in mapped) refuse(label(mapped.blocked));
      else out.mapped++;
    } catch (error) {
      refuse(`measurement-error: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }
  return out;
}

/** Reads a regular file (bounded) and measures it. Errors carry no file content. */
export function measurePaymentExportFile(path: string): PaymentMeasurement {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    // Fixed message: a filesystem error would otherwise echo the path.
    throw new Error('Export file could not be opened');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error('Export must be a regular file within the size limit');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8', 0, offset));
    } catch {
      throw new Error('Export is not valid JSON');
    }
    return measurePaymentMapping(parsed);
  } finally {
    closeSync(fd);
  }
}
