import { describe, it, expect } from 'vitest';
import {
  formatTable,
  formatDetail,
  formatMeta,
  formatTaxReport,
  isJsonMode,
  type Column,
} from '../src/formatter.js';

const cols: Column[] = [
  { key: 'id', header: 'ID', width: 5, align: 'right' },
  { key: 'name', header: 'Name', width: 15 },
  { key: 'amount', header: 'Amount', width: 10, align: 'right', format: (v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '')) },
];

describe('formatTable', () => {
  it('renders rows with headers and alignment', () => {
    const rows = [
      { id: 1, name: 'Alice', amount: 100 },
      { id: 42, name: 'Bob', amount: 2500.5 },
    ];
    const output = formatTable(rows, cols);
    const lines = output.split('\n');

    expect(lines[0]).toContain('ID');
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Amount');
    // separator
    expect(lines[1]).toMatch(/^─+/);
    // right-aligned ID
    expect(lines[2]).toMatch(/^\s+1/);
    // formatted amount
    expect(lines[3]).toContain('2500.50');
  });

  it('returns "No results." for empty array', () => {
    expect(formatTable([], cols)).toBe('No results.');
  });

  it('truncates long values with ellipsis', () => {
    const rows = [{ id: 1, name: 'A very long name that exceeds width', amount: 0 }];
    const output = formatTable(rows, cols);
    expect(output).toContain('…');
    // truncated to 15 chars (14 + ellipsis)
    const dataLine = output.split('\n')[2];
    const nameSection = dataLine.slice(7, 22); // after "   1  "
    expect(nameSection.length).toBe(15);
  });

  it('handles null and undefined values', () => {
    const rows = [{ id: null, name: undefined, amount: null }];
    const output = formatTable(rows, cols);
    const lines = output.split('\n');
    expect(lines.length).toBe(3); // header + separator + 1 row
  });

  it('handles boolean values', () => {
    const boolCols: Column[] = [{ key: 'active', header: 'Active', width: 6 }];
    const rows = [{ active: true }, { active: false }];
    const output = formatTable(rows, boolCols);
    expect(output).toContain('Yes');
    expect(output).toContain('No');
  });

  it('sanitizes newlines in values', () => {
    const rows = [{ id: 1, name: 'Line1\nLine2', amount: 0 }];
    const output = formatTable(rows, cols);
    expect(output).not.toContain('\nLine2');
    expect(output).toContain('Line1 Line2');
  });
});

describe('formatDetail', () => {
  it('renders key-value pairs vertically', () => {
    const record = { id: 42, name: 'Test Corp', amount: 1234.56 };
    const output = formatDetail(record, cols);
    expect(output).toContain('ID');
    expect(output).toContain('42');
    expect(output).toContain('Name');
    expect(output).toContain('Test Corp');
    expect(output).toContain('1234.56');
  });

  it('skips null/undefined/empty fields', () => {
    const record = { id: 1, name: null, amount: undefined };
    const output = formatDetail(record, cols);
    expect(output).toContain('ID');
    expect(output).not.toContain('Name');
    expect(output).not.toContain('Amount');
  });

  it('aligns labels to same width', () => {
    const record = { id: 1, name: 'Test', amount: 100 };
    const output = formatDetail(record, cols);
    const lines = output.split('\n');
    // All labels should be padded to length of longest header ("Amount" = 6)
    for (const line of lines) {
      // format: "  Label   value"
      expect(line).toMatch(/^\s{2}\w/);
    }
  });
});

describe('formatMeta', () => {
  it('renders pagination info', () => {
    const meta = { '@TotalResources': 150, '@TotalPages': 3, '@CurrentPage': 1 };
    const output = formatMeta(meta);
    expect(output).toContain('Page 1/3');
    expect(output).toContain('150 total');
  });

  it('returns empty string for undefined meta', () => {
    expect(formatMeta(undefined)).toBe('');
  });

  it('returns empty string when no @TotalResources', () => {
    expect(formatMeta({})).toBe('');
  });
});

describe('formatTaxReport', () => {
  const report = {
    period: { from: '2025-01-01', to: '2025-03-31' },
    vatAccounts: {
      '2610': { debit: 0, credit: 5000.0, description: 'Utgående moms 25%' },
      '2640': { debit: 1200.5, credit: 0, description: 'Ingående moms' },
    },
    accountBalances: [
      { account: 2610, description: 'Utgående moms 25%', balance: -5000.0 },
      { account: 2640, description: 'Ingående moms', balance: 1200.5 },
    ],
    summary: { note: 'Kontrollera beloppen mot Fortnox momsrapport.' },
  };

  it('renders period header', () => {
    const output = formatTaxReport(report);
    expect(output).toContain('2025-01-01');
    expect(output).toContain('2025-03-31');
  });

  it('renders VAT accounts table', () => {
    const output = formatTaxReport(report);
    expect(output).toContain('VAT Accounts');
    expect(output).toContain('2610');
    expect(output).toContain('5000.00');
    expect(output).toContain('Utgående moms 25%');
  });

  it('renders account balances table', () => {
    const output = formatTaxReport(report);
    expect(output).toContain('Account Balances');
    expect(output).toContain('1200.50');
  });

  it('renders summary note', () => {
    const output = formatTaxReport(report);
    expect(output).toContain('Kontrollera beloppen');
  });

  it('handles empty report gracefully', () => {
    const output = formatTaxReport({});
    expect(output).toBe('');
  });
});

describe('isJsonMode', () => {
  it('returns true when output is "json"', () => {
    expect(isJsonMode({ output: 'json' })).toBe(true);
  });

  it('returns false when output is "table"', () => {
    expect(isJsonMode({ output: 'table' })).toBe(false);
  });

  it('returns true when no TTY (piped)', () => {
    const fakeStdout = { isTTY: false } as NodeJS.WriteStream;
    expect(isJsonMode({}, fakeStdout)).toBe(true);
  });

  it('returns false when TTY (interactive)', () => {
    const fakeStdout = { isTTY: true } as NodeJS.WriteStream;
    expect(isJsonMode({}, fakeStdout)).toBe(false);
  });

  it('explicit flag overrides TTY detection', () => {
    const fakeStdout = { isTTY: true } as NodeJS.WriteStream;
    expect(isJsonMode({ output: 'json' }, fakeStdout)).toBe(true);
  });
});
