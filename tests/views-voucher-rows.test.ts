import { describe, it, expect } from 'vitest';
import { formatTable } from '../src/formatter.js';
import { voucherRowColumns } from '../src/views.js';

// Issue #96: Fortnox lets a single voucher row be voided (Removed: true) without
// deleting it — the corrected replacement row lives in the same voucher. Rendering
// both identically makes a voided line look like a live double-booking.
describe('voucher row rendering', () => {
  const rows = [
    { Account: 4000, Debit: 100, Credit: 0, Description: 'Office supplies', Removed: true },
    {
      Account: 4010,
      Debit: 100,
      Credit: 0,
      Description: 'Office supplies (correction)',
      Removed: false,
    },
    { Account: 1930, Debit: 0, Credit: 100, Description: 'Bank' },
  ];

  it('marks a removed row so it cannot be mistaken for a live one', () => {
    const [, , voided] = formatTable(rows, voucherRowColumns).split('\n');
    expect(voided).toContain('[REMOVED]');
  });

  it('leaves live rows unmarked', () => {
    const lines = formatTable(rows, voucherRowColumns).split('\n');
    expect(lines[3]).not.toContain('[REMOVED]');
    expect(lines[4]).not.toContain('[REMOVED]');
  });

  it('keeps the marker visible even when the description is truncated', () => {
    const long = [{ Account: 4000, Description: 'x'.repeat(200), Removed: true }];
    expect(formatTable(long, voucherRowColumns)).toContain('[REMOVED]');
  });

  it('renders a removed row with an empty description', () => {
    const bare = [{ Account: 4000, Debit: 100, Removed: true }];
    expect(formatTable(bare, voucherRowColumns)).toContain('[REMOVED]');
  });

  it('strips terminal control sequences from a removed row description', () => {
    const nasty = [{ Account: 4000, Description: 'safe\u001b]52;c;Zm9v\u0007tail', Removed: true }];
    const out = formatTable(nasty, voucherRowColumns);
    expect(out).toContain('[REMOVED]');
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });
});
