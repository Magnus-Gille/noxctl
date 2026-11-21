import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCommand } from '../../src/pilot/commands.js';
import {
  evidenceCreditNoteLookup,
  evidenceVoucherLookup,
  paymentVoucherKey,
} from '../../src/shadow/source-evidence.js';
import { createSyntheticFortnox } from '../../src/pilot/synthetic.js';
import { COMPANY, ORG, makeHost } from './helpers.js';

const booked = {
  Number: '9',
  InvoiceNumber: '1',
  Booked: true,
  VoucherYear: 3,
  VoucherSeries: 'D',
  VoucherNumber: 5,
};
const voucher = {
  Year: 3,
  VoucherSeries: 'D',
  VoucherNumber: 5,
  ReferenceType: 'INVOICEPAYMENT',
  ReferenceNumber: '1',
  TransactionDate: '2026-11-05',
  VoucherRows: [{ Account: 1930, Debit: 125, Credit: 0 }],
};
const creditNote = {
  DocumentNumber: '2',
  Credit: 'true',
  CreditInvoiceReference: '0',
  InvoiceReference: '1',
  Total: -125,
};

async function setup(extra?: (s: ReturnType<typeof createSyntheticFortnox>) => void) {
  const synthetic = createSyntheticFortnox(ORG);
  synthetic.state.vouchers.set('3:D:5', structuredClone(voucher));
  synthetic.state.invoices.set('2', structuredClone(creditNote));
  extra?.(synthetic);
  const h = await makeHost({ synthetic });
  return h;
}
async function bookkeep(h: Awaited<ReturnType<typeof setup>>, result: unknown = booked) {
  await h.host.queue.execute(
    { id: 'book-1', operation: 'bookkeepInvoicePayment', args: ['9'] },
    async () => result,
  );
}
async function credit(h: Awaited<ReturnType<typeof setup>>, reference: unknown = '2') {
  await h.host.queue.execute(
    { id: 'credit-1', operation: 'creditInvoice', args: ['1'] },
    async () => ({ DocumentNumber: '1', Credit: 'false', CreditInvoiceReference: reference }),
  );
}
const reads = (h: Awaited<ReturnType<typeof setup>>) =>
  h.synthetic.state.requests.filter((r) => !r.endsWith('companyinformation'));

describe('capture of read-only source evidence (NOX-211)', () => {
  it('keys a booked payment by voucher year, series and number', () => {
    expect(paymentVoucherKey(booked)).toBe('3:D:5');
    expect(paymentVoucherKey({ ...booked, VoucherYear: '3', VoucherNumber: '5' })).toBe('3:D:5');
    for (const bad of [
      { ...booked, Booked: false },
      { ...booked, VoucherNumber: 0 },
      { ...booked, VoucherSeries: '' },
      { ...booked, VoucherSeries: 'D:1' },
      { ...booked, VoucherYear: '03' },
      null,
    ])
      expect(paymentVoucherKey(bad)).toBeUndefined();
  });

  it('captures the voucher of a booked payment record, then serves it to the payment adapter', async () => {
    const h = await setup();
    await bookkeep(h);
    const result = await captureCommand(h.host, 'book-1');
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toMatch(/captured payment-voucher 3:D:5/);
    expect(reads(h)).toEqual(['GET vouchers/D/5']);
    const lookup = evidenceVoucherLookup(h.host.queue);
    expect(lookup({ sourceResult: booked } as never)).toEqual({
      sourceCompany: ORG,
      financialYearId: '3',
      data: voucher,
    });
    expect(lookup({ sourceResult: { ...booked, VoucherNumber: 6 } } as never)).toBeUndefined();
    // A capture is a local state change: it is backed up like any other.
    expect(existsSync(join(h.host.directory, 'backup-pending'))).toBe(false);
    expect(readdirSync(join(h.host.directory, 'backups')).length).toBeGreaterThan(0);
  });

  it('accepts an identical re-capture and refuses a changed source object, keeping the first copy', async () => {
    const h = await setup();
    await bookkeep(h);
    expect((await captureCommand(h.host, 'book-1')).ok).toBe(true);
    const again = await captureCommand(h.host, 'book-1');
    expect(again.ok, again.message).toBe(true);
    expect(again.message).toMatch(/already captured/);
    h.synthetic.state.vouchers.get('3:D:5')!.TransactionDate = '2026-11-06';
    const changed = await captureCommand(h.host, 'book-1');
    expect(changed.ok).toBe(false);
    expect(changed.message).toMatch(/differs from the captured evidence/);
    expect(h.host.queue.getEvidence('payment-voucher', '3:D:5')?.data).toEqual(voucher);
  });

  it('refuses a payment record without a booked voucher reference, before reading Fortnox', async () => {
    const h = await setup();
    await bookkeep(h, { ...booked, Booked: false });
    const result = await captureCommand(h.host, 'book-1');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no booked voucher reference/);
    expect(reads(h)).toEqual([]);
  });

  it.each([
    ['another voucher number', { VoucherNumber: 6 }],
    ['another reference type', { ReferenceType: 'INVOICE' }],
    ['another invoice', { ReferenceNumber: '7' }],
  ])('refuses a fetched voucher with %s and stores nothing', async (_n, patch) => {
    const h = await setup((s) => Object.assign(s.state.vouchers.get('3:D:5')!, patch));
    await bookkeep(h);
    const result = await captureCommand(h.host, 'book-1');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the payment/);
    expect(h.host.queue.getEvidence('payment-voucher', '3:D:5')).toBeUndefined();
  });

  it('refuses when Fortnox cannot be read and stores nothing', async () => {
    const h = await setup((s) => s.state.vouchers.clear());
    await bookkeep(h);
    const result = await captureCommand(h.host, 'book-1');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not be read from Fortnox; nothing was stored/);
  });

  it('captures the credit note of a credit record and serves it to the credit adapter', async () => {
    const h = await setup();
    await credit(h);
    const result = await captureCommand(h.host, 'credit-1');
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toMatch(/captured credit-note 2/);
    expect(reads(h)).toEqual(['GET invoices/2']);
    expect(evidenceCreditNoteLookup(h.host.queue)('2')).toEqual(creditNote);
    expect(evidenceCreditNoteLookup(h.host.queue)('3')).toBeUndefined();
  });

  it.each([
    ['not a credit note', { Credit: 'false' }],
    ['credits another invoice', { InvoiceReference: '7' }],
    ['another document', { DocumentNumber: '3' }],
  ])('refuses a fetched credit note that is %s', async (_n, patch) => {
    const h = await setup((s) => Object.assign(s.state.invoices.get('2')!, patch));
    await credit(h);
    const result = await captureCommand(h.host, 'credit-1');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the credit/);
    expect(h.host.queue.getEvidence('credit-note', '2')).toBeUndefined();
  });

  it.each([['0'], [''], [0], [null]])(
    'refuses a credit record whose CreditInvoiceReference is %j',
    async (reference) => {
      const h = await setup();
      await credit(h, reference);
      const result = await captureCommand(h.host, 'credit-1');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no credit note number/);
      expect(reads(h)).toEqual([]);
    },
  );

  it('refuses unknown records and operations that have no source evidence', async () => {
    const h = await setup();
    expect((await captureCommand(h.host, 'nope')).message).toMatch(/no record nope/);
    await h.host.queue.execute(
      { id: 'cust', operation: 'createCustomer', args: [{ Name: 'X' }] },
      async () => ({ CustomerNumber: '5' }),
    );
    expect((await captureCommand(h.host, 'cust')).message).toMatch(/has no source evidence/);
    expect((await captureCommand(h.host, 'a b')).message).toMatch(/invalid record id/);
  });

  it('is not blocked by queue states, but is by the Fortnox company check', async () => {
    const h = await setup();
    await h.host.queue.execute(
      { id: 'pay-1', operation: 'createInvoicePayment', args: [{ InvoiceNumber: 1 }] },
      async () => ({ ...booked, Booked: false }),
    );
    await bookkeep(h);
    expect(h.host.queue.get('pay-1')?.state).not.toBe('applied');
    expect((await captureCommand(h.host, 'book-1')).ok).toBe(true);
    h.synthetic.state.orgNr = '556999-9999';
    const refused = await captureCommand(h.host, 'book-1');
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/organization number/);
    expect(COMPANY).toBeTruthy();
  });
});
