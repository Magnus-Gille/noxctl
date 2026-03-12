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
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // Strip OSC sequences (e.g. \x1b]52;c;...\x07)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Strip remaining individual control characters
      // eslint-disable-next-line no-control-regex
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
