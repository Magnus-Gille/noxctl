// Natural date-period parsing for CLI --period arguments.
//
// Periods are CALENDAR-year based. Fortnox supports broken fiscal years;
// a fiscal-year-aware design is tracked separately — until then "Q1" always
// means January–March of the named (or current) calendar year.

export interface DateRange {
  from: string;
  to: string;
}

const EN_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const SV_MONTHS = [
  'januari',
  'februari',
  'mars',
  'april',
  'maj',
  'juni',
  'juli',
  'augusti',
  'september',
  'oktober',
  'november',
  'december',
];

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function monthRange(year: number, month: number): DateRange {
  return { from: iso(year, month, 1), to: iso(year, month, lastDayOfMonth(year, month)) };
}

function quarterRange(year: number, quarter: number): DateRange {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: iso(year, startMonth, 1),
    to: iso(year, endMonth, lastDayOfMonth(year, endMonth)),
  };
}

function yearRange(year: number): DateRange {
  return { from: iso(year, 1, 1), to: iso(year, 12, 31) };
}

export function resolvePeriod(period: string, today: Date = new Date()): DateRange {
  const input = period.trim().toLowerCase();
  const year = today.getFullYear();
  const month = today.getMonth() + 1; // 1-based
  const quarter = Math.ceil(month / 3);

  // Q1..Q4, optionally year-qualified (2025-Q3 or 2025Q3)
  const quarterMatch = /^(?:(\d{4})-?)?q([1-4])$/.exec(input);
  if (quarterMatch) {
    return quarterRange(
      quarterMatch[1] ? parseInt(quarterMatch[1], 10) : year,
      parseInt(quarterMatch[2], 10),
    );
  }

  // Bare year
  if (/^\d{4}$/.test(input)) return yearRange(parseInt(input, 10));

  // Month names (English and Swedish), current calendar year
  const enIdx = EN_MONTHS.indexOf(input);
  if (enIdx !== -1) return monthRange(year, enIdx + 1);
  const svIdx = SV_MONTHS.indexOf(input);
  if (svIdx !== -1) return monthRange(year, svIdx + 1);

  switch (input) {
    case 'this-quarter':
      return quarterRange(year, quarter);
    case 'last-quarter':
      return quarter === 1 ? quarterRange(year - 1, 4) : quarterRange(year, quarter - 1);
    case 'this-month':
      return monthRange(year, month);
    case 'last-month':
      return month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1);
    case 'this-year':
      return yearRange(year);
    case 'last-year':
      return yearRange(year - 1);
    case 'ytd':
      return { from: iso(year, 1, 1), to: iso(year, month, today.getDate()) };
  }

  throw new Error(
    `Unrecognized period "${period}". Supported: Q1–Q4, 2025-Q3, month names (march/mars), ` +
      'this-quarter, last-quarter, this-month, last-month, this-year, last-year, ytd, or a bare year. ' +
      'Periods are calendar-year based.',
  );
}

// Shared by CLI actions: merge --period into from/to, rejecting ambiguous mixes.
export function applyPeriod(opts: { period?: string; from?: string; to?: string }): {
  from?: string;
  to?: string;
} {
  if (!opts.period) return { from: opts.from, to: opts.to };
  if (opts.from || opts.to) {
    throw new Error('--period cannot be combined with --from/--to.');
  }
  return resolvePeriod(opts.period);
}
