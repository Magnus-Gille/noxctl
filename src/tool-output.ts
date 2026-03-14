import {
  formatDetail,
  formatMeta,
  formatTable,
  formatTaxReport,
  type Column,
} from './formatter.js';

type TextContent = {
  content: [{ type: 'text'; text: string }];
};

export function textResponse(text: string): TextContent {
  return {
    content: [{ type: 'text', text }],
  };
}

function appendRawJson(text: string, raw: unknown, includeRaw?: boolean): string {
  if (!includeRaw) return text;

  const rawJson = JSON.stringify(raw, null, 2);
  const warning =
    'Warning: includeRaw may expose additional accounting and personal data in logs, terminals, and AI transcripts.';
  if (!text) return `${warning}\n\nRaw JSON:\n${rawJson}`;
  return `${text}\n\n${warning}\n\nRaw JSON:\n${rawJson}`;
}

export function listResponse(
  rows: Record<string, unknown>[],
  columns: Column[],
  rawData: unknown,
  meta?: Record<string, unknown>,
  includeRaw?: boolean,
): TextContent {
  const table = formatTable(rows, columns);
  const metaLine = formatMeta(meta);
  const text = metaLine ? `${table}${metaLine}` : table;
  return textResponse(appendRawJson(text, rawData, includeRaw));
}

export function detailResponse(
  record: Record<string, unknown>,
  columns: Column[],
  rawData: unknown = record,
  includeRaw?: boolean,
): TextContent {
  const summary = formatDetail(record, columns) || 'No visible fields.';
  return textResponse(appendRawJson(summary, rawData, includeRaw));
}

export function confirmationResponse(
  message: string,
  rawData: unknown,
  columns?: Column[],
  includeRaw?: boolean,
): TextContent {
  let text = message;
  if (columns && rawData && typeof rawData === 'object') {
    const detail = formatDetail(rawData as Record<string, unknown>, columns);
    if (detail) text += `\n${detail}`;
  }
  return textResponse(appendRawJson(text, rawData, includeRaw));
}

export function taxReportResponse(
  report: Record<string, unknown>,
  includeRaw?: boolean,
): TextContent {
  return textResponse(appendRawJson(formatTaxReport(report), report, includeRaw));
}

export function dryRunResponse(action: string, payload?: unknown): TextContent {
  let text = `Dry run: ${action}. No request was sent to Fortnox.`;
  if (payload !== undefined) {
    text += `\n\nRequest payload:\n${JSON.stringify(payload, null, 2)}`;
  }
  return textResponse(text);
}

export function requireConfirmation(action: string): never {
  throw new Error(
    `Confirmation required to ${action}. Re-run with confirm: true, or dryRun: true to preview without executing.`,
  );
}
