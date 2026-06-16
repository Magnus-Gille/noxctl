import { describe, it, expect } from 'vitest';
import { resolvePeriod } from '../src/date-periods.js';

// Fixed "today" for determinism: 2026-06-10 (Q2).
const TODAY = new Date(2026, 5, 10);

describe('resolvePeriod', () => {
  it('resolves quarters of the current calendar year', () => {
    expect(resolvePeriod('Q1', TODAY)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolvePeriod('q2', TODAY)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(resolvePeriod('Q4', TODAY)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });

  it('resolves year-qualified quarters', () => {
    expect(resolvePeriod('2025-Q3', TODAY)).toEqual({ from: '2025-07-01', to: '2025-09-30' });
  });

  it('resolves English month names in the current year', () => {
    expect(resolvePeriod('march', TODAY)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(resolvePeriod('February', TODAY)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('resolves Swedish month names', () => {
    expect(resolvePeriod('mars', TODAY)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(resolvePeriod('maj', TODAY)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });

  it('handles leap-year February', () => {
    expect(resolvePeriod('february', new Date(2028, 0, 15))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('resolves relative periods', () => {
    expect(resolvePeriod('this-quarter', TODAY)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(resolvePeriod('last-quarter', TODAY)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolvePeriod('this-month', TODAY)).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(resolvePeriod('last-month', TODAY)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(resolvePeriod('ytd', TODAY)).toEqual({ from: '2026-01-01', to: '2026-06-10' });
    expect(resolvePeriod('last-year', TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(resolvePeriod('this-year', TODAY)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('last-quarter crosses the year boundary from Q1', () => {
    expect(resolvePeriod('last-quarter', new Date(2026, 1, 1))).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });

  it('resolves a bare year', () => {
    expect(resolvePeriod('2025', TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('throws a helpful error on unknown input', () => {
    expect(() => resolvePeriod('banana', TODAY)).toThrow(/Unrecognized period/);
  });
});
