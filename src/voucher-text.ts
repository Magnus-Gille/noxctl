import { formatTable, stripControl } from './formatter.js';
import type { GetVouchersResult, VoucherAttachmentOverview } from './operations/vouchers.js';
import { voucherAttachmentOverviewColumns, voucherRowColumns } from './views.js';

// Plain-text renderings of the two composite voucher reads, shared by the MCP tools
// and the CLI. Everything that came from Fortnox goes through stripControl first:
// descriptions and error messages are server-supplied text.

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function voucherId(series: unknown, number: unknown): string {
  return stripControl(`${String(series ?? '')}/${String(number ?? '')}`);
}

/** One header line plus the rows table per voucher, then any errors and the truncation notice. */
export function formatVouchersWithRows(result: GetVouchersResult): string {
  const { vouchers, errors } = result;
  const lines: string[] = [`Vouchers: ${vouchers.length} fetched, ${errors.length} failed.`];
  if (result.truncated) {
    lines.push(
      `Truncated: the period holds ${result.totalInPeriod ?? '?'} vouchers; rows were fetched for the first ${vouchers.length + errors.length}. Narrow the period or series, or raise limit (max 200).`,
    );
  }

  for (const voucher of vouchers) {
    const header = [
      voucherId(voucher.VoucherSeries, voucher.VoucherNumber),
      stripControl(String(voucher.TransactionDate ?? '')),
      stripControl(String(voucher.Description ?? '')),
    ]
      .filter(Boolean)
      .join('  ');
    const rows = (voucher.VoucherRows as Record<string, unknown>[] | undefined) ?? [];
    lines.push('', header, rows.length ? formatTable(rows, voucherRowColumns) : '(no rows)');
  }

  if (errors.length) {
    lines.push('', `Errors (${errors.length}):`);
    for (const { series, number, error } of errors) {
      lines.push(`  ${voucherId(series, number)}: ${stripControl(error)}`);
    }
  }
  return lines.join('\n');
}

/** Summary counts line, an optional cap notice, then a compact table of the listed vouchers. */
export function formatVoucherAttachmentOverview(overview: VoucherAttachmentOverview): string {
  const { period } = overview;
  const scope = [
    period.series ? `series ${period.series}` : undefined,
    period.financialYear !== undefined ? `financial year ${period.financialYear}` : undefined,
  ].filter(Boolean);
  const lines = [
    `Period ${period.fromDate} to ${period.toDate}${scope.length ? ` (${scope.join(', ')})` : ''}: ${plural(overview.totalVouchers, 'voucher')}, ${overview.withAttachments} with attachments, ${overview.withoutAttachments} without.`,
  ];
  if (overview.truncated) {
    lines.push(
      `Truncated: only the first ${overview.vouchers.length} vouchers are listed; the counts above cover the whole period. Narrow the period or series, or use onlyMissing.`,
    );
  }
  lines.push(
    '',
    formatTable(
      overview.vouchers as unknown as Record<string, unknown>[],
      voucherAttachmentOverviewColumns,
    ),
  );
  return lines.join('\n');
}
