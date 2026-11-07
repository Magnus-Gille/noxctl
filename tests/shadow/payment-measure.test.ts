import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  measurePaymentExportFile,
  measurePaymentMapping,
} from '../../src/shadow/payment-measure.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  dirs.push(dir);
  return dir;
};

const invoice = (number: string, extra: Record<string, unknown> = {}) => ({
  DocumentNumber: number,
  Currency: 'SEK',
  RoundOff: 0,
  Net: 100,
  TotalVAT: 25,
  Total: 125,
  InvoiceRows: [
    {
      Description: 'Synthetic',
      Price: 100,
      TotalExcludingVAT: 100,
      VAT: 25,
      Discount: 0,
      AccountNumber: 3001,
    },
    { Description: 'A text-only row', Price: 0, TotalExcludingVAT: 0, VAT: 0 },
  ],
  ...extra,
});
const payment = (number: number, invoiceNumber: string, extra: Record<string, unknown> = {}) => ({
  Number: number,
  InvoiceNumber: invoiceNumber,
  Booked: true,
  Amount: 125,
  AmountCurrency: 125,
  Currency: 'SEK',
  CurrencyRate: 1,
  CurrencyUnit: 1,
  InvoiceTotal: '125.00',
  WriteOffs: [],
  ModeOfPaymentAccount: '1930',
  PaymentDate: '2026-11-05',
  VoucherYear: 2026,
  VoucherSeries: 'A',
  VoucherNumber: number,
  ...extra,
});
const row = (Account: number, Debit: number, Credit: number) => ({
  Account,
  Debit,
  Credit,
  Removed: false,
  CostCenter: '',
  Project: '',
  Quantity: 0,
  Description: '',
  TransactionInformation: '',
});
const voucher = (
  number: number,
  invoiceNumber: string,
  rows = [row(1930, 125, 0), row(3001, 0, 100), row(2611, 0, 25)],
) => ({
  Year: 2026,
  VoucherSeries: 'A',
  VoucherNumber: number,
  ReferenceType: 'INVOICEPAYMENT',
  ReferenceNumber: invoiceNumber,
  TransactionDate: '2026-11-05',
  CostCenter: '',
  Project: '',
  VoucherRows: rows,
});

describe('payment mapping measurement (NOX-211)', () => {
  it('counts a supported booked full payment as mapped', () => {
    const result = measurePaymentMapping({
      InvoicePayments: [payment(1, '10')],
      Invoices: [invoice('10')],
      Vouchers: [voucher(1, '10')],
    });
    expect(result).toEqual({ payments: 1, mapped: 1, refused: {} });
  });

  it('counts refusals by fixed reason and nothing else', () => {
    const result = measurePaymentMapping({
      InvoicePayments: [
        payment(1, '10'),
        payment(2, '11', { Booked: false }),
        payment(3, '99'),
        payment(4, '12'),
        payment(5, '13', { Amount: 60, AmountCurrency: 60 }),
        payment(6, '14'),
        payment(7, '15'),
        payment(8, '16'),
      ],
      Invoices: [
        invoice('10'),
        invoice('11'),
        invoice('12'),
        invoice('13'),
        invoice('14', { Currency: 'EUR' }),
        invoice('15', {
          InvoiceRows: [
            {
              Description: 'x',
              Price: 100,
              TotalExcludingVAT: 100,
              VAT: 12,
              Discount: 0,
              AccountNumber: 3001,
            },
          ],
        }),
        invoice('16'),
      ],
      Vouchers: [
        voucher(1, '10'),
        voucher(2, '11'),
        voucher(5, '13'),
        voucher(6, '14'),
        voucher(7, '15'),
        voucher(8, '16', [row(1930, 125, 0), row(3001, 0, 100), row(3002, 0, 25)]),
      ],
    });
    expect(result).toEqual({
      payments: 8,
      mapped: 1,
      refused: {
        'payment-not-booked': 1,
        'invoice-missing-from-export': 1,
        'voucher-missing-from-export': 1,
        'Only the exact full payment of this strict invoice is supported': 1,
        'invoice-not-strict: currency': 1,
        'invoice-not-strict: vat-rate': 1,
        'Captured payment contains unsupported accounts or opposing/empty lines': 1,
      },
    });
  });

  it('never puts export values in a reason label', () => {
    const secret = 'Synthetic-Marker-AB-12345';
    const result = measurePaymentMapping({
      InvoicePayments: [payment(1, '10', { InvoiceCustomerName: secret, Extra: secret })],
      Invoices: [invoice('10')],
      Vouchers: [voucher(1, '10')],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('reports an unsupported export shape instead of guessing', () => {
    expect(measurePaymentMapping({ InvoicePayments: [] })).toEqual({
      payments: 0,
      mapped: 0,
      refused: { 'export-shape-unsupported': 1 },
    });
    expect(measurePaymentMapping('nope').refused).toEqual({ 'export-shape-unsupported': 1 });
  });

  it('reads a file and fails with a fixed message that holds no content', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ "Synthetic-Marker": ');
    expect(() => measurePaymentExportFile(bad)).toThrow(/^Export is not valid JSON$/);
    expect(() => measurePaymentExportFile(dir)).toThrow(/regular file/);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ InvoicePayments: [], Invoices: [], Vouchers: [] }));
    expect(measurePaymentExportFile(good)).toEqual({ payments: 0, mapped: 0, refused: {} });
  });

  const script = join(process.cwd(), 'scripts', 'measure-payment-mapping.mjs');
  it.skipIf(!existsSync(join(process.cwd(), 'dist', 'shadow', 'payment-measure.js')))(
    'the script prints counts only and rejects bad usage',
    () => {
      const dir = tmp();
      const file = join(dir, 'export.json');
      writeFileSync(
        file,
        JSON.stringify({
          InvoicePayments: [
            payment(1, '10', { InvoiceCustomerName: 'Synthetic-Marker-AB' }),
            payment(2, '11', { Booked: false }),
          ],
          Invoices: [invoice('10')],
          Vouchers: [voucher(1, '10')],
        }),
      );
      const ok = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
      expect(ok.status).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({
        payments: 2,
        mapped: 1,
        refused: { 'payment-not-booked': 1 },
      });
      expect(ok.stdout + ok.stderr).not.toContain('Synthetic-Marker');
      expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
      const missing = spawnSync(process.execPath, [script, join(dir, 'none.json')], {
        encoding: 'utf8',
      });
      expect(missing.status).toBe(1);
    },
  );
});
