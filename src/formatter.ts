export interface Column {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  format?: (value: unknown) => string;
}

function stripControl(str: string): string {
  return (
    str
      // Strip ANSI CSI sequences (e.g. \x1b[31m)
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // Strip OSC sequences (e.g. \x1b]52;c;...\x07)
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Strip remaining individual control characters
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
      .replace(/[\n\r]+/g, ' ')
  );
}

function toString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return stripControl(String(value));
}

function truncate(str: string, width: number): string {
  if (str.length <= width) return str;
  return str.slice(0, width - 1) + '…';
}

function pad(str: string, width: number, align: 'left' | 'right'): string {
  const truncated = truncate(str, width);
  return align === 'right' ? truncated.padStart(width) : truncated.padEnd(width);
}

export function formatTable(rows: Record<string, unknown>[], columns: Column[]): string {
  if (rows.length === 0) return 'No results.';

  const header = columns.map((c) => pad(c.header, c.width, c.align ?? 'left')).join('  ');
  const separator = columns.map((c) => '─'.repeat(c.width)).join('──');
  const body = rows.map((row) =>
    columns
      .map((c) => {
        const raw = row[c.key];
        const str = c.format ? c.format(raw) : toString(raw);
        return pad(str, c.width, c.align ?? 'left');
      })
      .join('  '),
  );

  return [header, separator, ...body].join('\n');
}

export function formatDetail(record: Record<string, unknown>, columns: Column[]): string {
  const maxLabel = Math.max(...columns.map((c) => c.header.length));
  return columns
    .map((c) => {
      const raw = record[c.key];
      if (raw === null || raw === undefined || raw === '') return null;
      const str = c.format ? c.format(raw) : toString(raw);
      return `  ${c.header.padEnd(maxLabel)}  ${str}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const total = meta['@TotalResources'];
  const pages = meta['@TotalPages'];
  const current = meta['@CurrentPage'];
  if (total === undefined) return '';
  return `\nPage ${current}/${pages} (${total} total)`;
}

export function formatTaxReport(report: Record<string, unknown>): string {
  const period = report.period as { from: string; to: string } | undefined;
  const vatAccounts = report.vatAccounts as
    | Record<string, { debit: number; credit: number; description: string }>
    | undefined;
  const accountBalances = report.accountBalances as
    | Array<{ account: number; description: string; balance: number }>
    | undefined;
  const summary = report.summary as { note: string } | undefined;

  const lines: string[] = [];

  if (period) {
    lines.push(`Period: ${period.from} — ${period.to}`);
    lines.push('');
  }

  if (vatAccounts && Object.keys(vatAccounts).length > 0) {
    lines.push('VAT Accounts');
    lines.push('─'.repeat(60));
    lines.push(
      `${'Account'.padEnd(8)}  ${'Description'.padEnd(25)}  ${'Debit'.padStart(10)}  ${'Credit'.padStart(10)}`,
    );
    lines.push('─'.repeat(60));
    for (const [acct, data] of Object.entries(vatAccounts)) {
      lines.push(
        `${acct.padEnd(8)}  ${truncate(stripControl(data.description), 25).padEnd(25)}  ${data.debit.toFixed(2).padStart(10)}  ${data.credit.toFixed(2).padStart(10)}`,
      );
    }
    lines.push('');
  }

  if (accountBalances && accountBalances.length > 0) {
    lines.push('Account Balances');
    lines.push('─'.repeat(50));
    lines.push(`${'Account'.padEnd(8)}  ${'Description'.padEnd(25)}  ${'Balance'.padStart(10)}`);
    lines.push('─'.repeat(50));
    for (const row of accountBalances) {
      lines.push(
        `${String(row.account).padEnd(8)}  ${truncate(stripControl(row.description), 25).padEnd(25)}  ${row.balance.toFixed(2).padStart(10)}`,
      );
    }
    lines.push('');
  }

  if (summary?.note) {
    lines.push(`Note: ${stripControl(summary.note)}`);
  }

  return lines.join('\n');
}

export function formatFinancialReport(report: {
  type: string;
  sections?: {
    label: string;
    lines: { account: number; description: string; balance: number }[];
    total: number;
  }[];
  netResult?: number;
  assets?: {
    label: string;
    lines: { account: number; description: string; balance: number }[];
    total: number;
  }[];
  totalAssets?: number;
  liabilitiesAndEquity?: {
    label: string;
    lines: { account: number; description: string; balance: number }[];
    total: number;
  }[];
  totalLiabilitiesAndEquity?: number;
  financialYear?: number;
  period?: { from: string; to: string };
  asOfDate?: string;
}): string {
  const lines: string[] = [];
  const W = 70;

  let subtitle = '';
  if (report.period?.from && report.period?.to) {
    subtitle = ` ${report.period.from} — ${report.period.to}`;
  } else if (report.period?.from) {
    subtitle = ` från ${report.period.from}`;
  } else if (report.period?.to) {
    subtitle = ` t.o.m. ${report.period.to}`;
  } else if (report.asOfDate) {
    subtitle = ` per ${report.asOfDate}`;
  } else if (report.financialYear) {
    subtitle = ` (år ${report.financialYear})`;
  }

  // sign = 1 keeps BAS convention, sign = -1 flips for display readability
  function formatSection(
    section: {
      label: string;
      lines: { account: number; description: string; balance: number }[];
      total: number;
    },
    sign: number,
  ) {
    lines.push('');
    lines.push(section.label);
    lines.push('─'.repeat(W));
    for (const line of section.lines) {
      const acct = String(line.account).padEnd(6);
      const desc = truncate(stripControl(line.description), 40).padEnd(40);
      const amount = (line.balance * sign).toFixed(2).padStart(15);
      lines.push(`  ${acct}  ${desc}  ${amount}`);
    }
    lines.push(`${''.padEnd(50)}${'─'.repeat(15)}`);
    lines.push(`${'Summa'.padEnd(50)}${(section.total * sign).toFixed(2).padStart(15)}`);
  }

  if (report.type === 'income-statement') {
    // Negate: revenue (credit) becomes positive, costs (debit) become negative
    lines.push(`RESULTATRÄKNING${subtitle}`);
    lines.push('═'.repeat(W));
    for (const section of report.sections ?? []) {
      formatSection(section, -1);
    }
    lines.push('');
    lines.push('═'.repeat(W));
    lines.push(`${'RESULTAT'.padEnd(50)}${(-(report.netResult ?? 0)).toFixed(2).padStart(15)}`);
  } else {
    lines.push(`BALANSRÄKNING${subtitle}`);
    lines.push('═'.repeat(W));

    lines.push('');
    lines.push('TILLGÅNGAR');
    for (const section of report.assets ?? []) {
      formatSection(section, 1); // Assets: debit = positive, keep as-is
    }
    lines.push('');
    lines.push('═'.repeat(W));
    lines.push(
      `${'SUMMA TILLGÅNGAR'.padEnd(50)}${(report.totalAssets ?? 0).toFixed(2).padStart(15)}`,
    );

    lines.push('');
    lines.push('SKULDER OCH EGET KAPITAL');
    for (const section of report.liabilitiesAndEquity ?? []) {
      formatSection(section, -1); // Liabilities: credit = negative in BAS, negate to show positive
    }
    lines.push('');
    lines.push('═'.repeat(W));
    lines.push(
      `${'SUMMA SKULDER OCH EGET KAPITAL'.padEnd(50)}${(-(report.totalLiabilitiesAndEquity ?? 0)).toFixed(2).padStart(15)}`,
    );
  }

  return lines.join('\n');
}

export interface OutputOptions {
  json: boolean;
}

export function isJsonMode(programOpts: { output?: string }, stdout = process.stdout): boolean {
  if (programOpts.output === 'json') return true;
  if (programOpts.output === 'table') return false;
  // Default: JSON when piped, table on TTY
  return !stdout.isTTY;
}

export function outputList(
  data: Record<string, unknown>[],
  columns: Column[],
  json: boolean,
  rawData: unknown,
  meta?: Record<string, unknown>,
): void {
  if (json) {
    console.log(JSON.stringify(rawData, null, 2));
    return;
  }
  console.log(formatTable(data, columns));
  const metaLine = formatMeta(meta);
  if (metaLine) console.log(metaLine);
}

export function outputDetail(
  record: Record<string, unknown>,
  columns: Column[],
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  console.log(formatDetail(record, columns));
}

export function outputConfirmation(
  message: string,
  json: boolean,
  rawData: unknown,
  columns?: Column[],
): void {
  if (json) {
    console.log(JSON.stringify(rawData, null, 2));
    return;
  }
  console.log(message);
  if (columns && rawData && typeof rawData === 'object') {
    console.log(formatDetail(rawData as Record<string, unknown>, columns));
  }
}
