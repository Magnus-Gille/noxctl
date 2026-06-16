import { describe, it, expect } from 'vitest';
import {
  summarizeOverdue,
  summarizeUnpaid,
  topCustomersFrom,
  monthlyRevenueFrom,
  localIsoDate,
  netVatFromVatAccounts,
} from '../../src/operations/analytics.js';

const today = '2026-06-10';

const invoices = [
  // paid
  {
    DocumentNumber: '1',
    CustomerName: 'Acme',
    CustomerNumber: '10',
    InvoiceDate: '2026-01-15',
    DueDate: '2026-02-14',
    Total: 1000,
    Balance: 0,
    FinalPayDate: '2026-02-01',
  },
  // unpaid, not overdue
  {
    DocumentNumber: '2',
    CustomerName: 'Acme',
    CustomerNumber: '10',
    InvoiceDate: '2026-06-01',
    DueDate: '2026-07-01',
    Total: 2000,
    Balance: 2000,
  },
  // unpaid, overdue
  {
    DocumentNumber: '3',
    CustomerName: 'Beta AB',
    CustomerNumber: '11',
    InvoiceDate: '2026-04-01',
    DueDate: '2026-05-01',
    Total: 3000,
    Balance: 1500,
  },
  // overdue, older
  {
    DocumentNumber: '4',
    CustomerName: 'Beta AB',
    CustomerNumber: '11',
    InvoiceDate: '2026-02-01',
    DueDate: '2026-03-03',
    Total: 500,
    Balance: 500,
  },
  // cancelled — must be excluded everywhere
  {
    DocumentNumber: '5',
    CustomerName: 'Ghost',
    CustomerNumber: '12',
    InvoiceDate: '2026-06-05',
    DueDate: '2026-07-05',
    Total: 9999,
    Balance: 9999,
    Cancelled: true,
  },
];

describe('summarizeOverdue', () => {
  it('counts overdue invoices and sums outstanding balance', () => {
    const s = summarizeOverdue(invoices, today);
    expect(s.count).toBe(2);
    expect(s.totalBalance).toBe(2000);
    expect(s.oldestDueDate).toBe('2026-03-03');
    expect(s.invoices.map((i) => i.DocumentNumber)).toEqual(['4', '3']); // oldest first
  });

  it('excludes cancelled and fully paid invoices', () => {
    const s = summarizeOverdue(invoices, today);
    expect(s.invoices.find((i) => i.DocumentNumber === '5')).toBeUndefined();
    expect(s.invoices.find((i) => i.DocumentNumber === '1')).toBeUndefined();
  });
});

describe('summarizeUnpaid', () => {
  it('sums all open balances and splits out the overdue part', () => {
    const s = summarizeUnpaid(invoices, today);
    expect(s.count).toBe(3);
    expect(s.totalBalance).toBe(4000);
    expect(s.overdueCount).toBe(2);
    expect(s.overdueBalance).toBe(2000);
  });
});

describe('topCustomersFrom', () => {
  it('ranks customers by invoiced total, excluding cancelled', () => {
    const top = topCustomersFrom(invoices, 10);
    expect(top[0]).toMatchObject({ CustomerName: 'Beta AB', total: 3500, invoiceCount: 2 });
    expect(top[1]).toMatchObject({ CustomerName: 'Acme', total: 3000, invoiceCount: 2 });
    expect(top.find((c) => c.CustomerName === 'Ghost')).toBeUndefined();
  });

  it('respects the limit', () => {
    expect(topCustomersFrom(invoices, 1)).toHaveLength(1);
  });
});

describe('monthlyRevenueFrom', () => {
  it('groups invoiced totals by month, excluding cancelled', () => {
    const months = monthlyRevenueFrom(invoices);
    expect(months).toEqual([
      { month: '2026-01', total: 1000, invoiceCount: 1 },
      { month: '2026-02', total: 500, invoiceCount: 1 },
      { month: '2026-04', total: 3000, invoiceCount: 1 },
      { month: '2026-06', total: 2000, invoiceCount: 1 },
    ]);
  });
});

describe('localIsoDate', () => {
  it('formats local Y-M-D with zero padding', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
    expect(localIsoDate(new Date(2026, 8, 9, 0, 0, 0))).toBe('2026-09-09');
    expect(localIsoDate(new Date(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31');
  });

  it('uses the LOCAL date near midnight, not the UTC date (off-by-one guard)', () => {
    const origTz = process.env.TZ;
    process.env.TZ = 'Europe/Stockholm';
    try {
      // 23:30 UTC on 2026-06-16 is 01:30 on 2026-06-17 in Stockholm (UTC+2).
      // The previous toISOString()-based implementation would wrongly yield
      // 2026-06-16; localIsoDate must report the local date.
      const d = new Date('2026-06-16T23:30:00Z');
      expect(localIsoDate(d)).toBe('2026-06-17');
    } finally {
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
    }
  });
});

describe('netVatFromVatAccounts', () => {
  it('sums debit - credit across accounts (negative = owed to Skatteverket)', () => {
    // 5000 output VAT (credit) and 1200.50 input VAT (debit) => net 1200.50 - 5000.
    const net = netVatFromVatAccounts({
      2610: { debit: 0, credit: 5000 },
      2640: { debit: 1200.5, credit: 0 },
    });
    expect(net).toBeCloseTo(-3799.5, 2);
  });

  it('returns a positive figure when input VAT exceeds output VAT (refund due)', () => {
    const net = netVatFromVatAccounts({
      2610: { debit: 0, credit: 1000 },
      2640: { debit: 2500, credit: 0 },
    });
    expect(net).toBeCloseTo(1500, 2);
  });

  it('treats undefined/empty account maps as zero', () => {
    expect(netVatFromVatAccounts(undefined)).toBe(0);
    expect(netVatFromVatAccounts({})).toBe(0);
  });
});
