import { extname } from 'node:path';
import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { pathSegment, voucherSeriesSegment } from '../identifiers.js';
import {
  snapshotOperationFile,
  type OperationFile,
  type OperationFileSnapshot,
  validateOperationFile,
} from '../operation-file.js';
import { createFinancialYearOperations } from './financial-years.js';

interface VoucherResponse {
  Voucher: Record<string, unknown>;
}

export interface VouchersResponse {
  Vouchers: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListVouchersParams {
  financialYear?: number;
  series?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export interface AttachVoucherFilesParams {
  series: string;
  voucherNumber: string;
  filePaths: OperationFile[];
  financialYear?: number;
}

export interface VoucherFileAttachment {
  fileName: string;
  fileId: string;
  voucherYear: number;
  connection: Record<string, unknown>;
}

export interface VoucherAttachment {
  fileName: string;
  fileId: string;
  voucherSeries: string;
  voucherNumber: string;
  voucherYear?: number;
}

export interface VoucherFileContent {
  fileId: string;
  contentType: string;
  buffer: Buffer;
}

/** Explicit-list mode accepts at most this many vouchers per call. */
export const MAX_VOUCHERS_PER_BULK_READ = 50;
/** Period mode fetches rows for this many vouchers unless `limit` says otherwise. */
export const DEFAULT_PERIOD_VOUCHER_LIMIT = 100;
/** Hard ceiling for `limit` in period mode: each voucher is one rate-limited request. */
export const MAX_PERIOD_VOUCHER_LIMIT = 200;
/** The attachment overview returns at most this many voucher rows (counts stay exact). */
export const MAX_ATTACHMENT_OVERVIEW_VOUCHERS = 500;

export interface VoucherReference {
  series: string;
  number: string;
}

export interface GetVouchersParams {
  /** Explicit mode: 1..50 series/number pairs. Mutually exclusive with the period fields. */
  vouchers?: VoucherReference[];
  /** Period mode: both dates required (YYYY-MM-DD). */
  fromDate?: string;
  toDate?: string;
  /** Period mode only: restrict the period to one voucher series. */
  series?: string;
  /** Both modes. Voucher numbers restart every financial year. */
  financialYear?: number;
  /** Period mode only: how many vouchers get their rows fetched (default 100, max 200). */
  limit?: number;
}

export interface VoucherFetchError extends VoucherReference {
  error: string;
}

export interface GetVouchersResult {
  vouchers: Record<string, unknown>[];
  errors: VoucherFetchError[];
  /** Period mode only, present (true) when the period held more vouchers than were fetched. */
  truncated?: boolean;
  /** Period mode only, present together with `truncated`: how many vouchers the period holds. */
  totalInPeriod?: number;
}

export interface VoucherAttachmentOverviewParams {
  fromDate: string;
  toDate: string;
  series?: string;
  financialYear?: number;
  /** List only vouchers without attachments (the counts still cover the whole period). */
  onlyMissing?: boolean;
}

export interface VoucherAttachmentOverviewRow {
  series: string;
  number: string;
  transactionDate: string;
  description: string;
  attachmentCount: number;
  fileNames: string[];
}

export interface VoucherAttachmentOverview {
  period: { fromDate: string; toDate: string; series?: string; financialYear?: number };
  totalVouchers: number;
  withAttachments: number;
  withoutAttachments: number;
  vouchers: VoucherAttachmentOverviewRow[];
  /** Present (true) when `vouchers` was capped; the counts above still cover the whole period. */
  truncated?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A real calendar date, not just something shaped like one: round-trip the parsed
// value so overflow dates such as 2026-02-30 are rejected.
function assertIsoDate(name: string, value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(
      `Invalid "${name}": ${JSON.stringify(value)} is not a real date in YYYY-MM-DD format.`,
    );
  }
  return value;
}

function assertPeriod(fromDate: unknown, toDate: unknown): { fromDate: string; toDate: string } {
  if (fromDate === undefined || toDate === undefined) {
    throw new Error('A period needs both "fromDate" and "toDate" (YYYY-MM-DD).');
  }
  const from = assertIsoDate('fromDate', fromDate);
  const to = assertIsoDate('toDate', toDate);
  if (to < from) {
    throw new Error(`Invalid period: "toDate" (${to}) is before "fromDate" (${from}).`);
  }
  return { fromDate: from, toDate: to };
}

function assertFinancialYear(financialYear: number | undefined): void {
  if (financialYear !== undefined && (!Number.isInteger(financialYear) || financialYear <= 0)) {
    throw new Error(`Invalid "financialYear": ${financialYear} is not a positive integer.`);
  }
}

// The financial year a list item belongs to (`Year`), when Fortnox reports one.
function listItemYear(item: Record<string, unknown>): number | undefined {
  const year = Number(item.Year);
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

export function createVoucherOperations(transport: FortnoxTransport) {
  const { listFinancialYears } = createFinancialYearOperations(transport);

  async function listVouchers(params: ListVouchersParams = {}): Promise<VouchersResponse> {
    const subpath = params.series ? `sublist/${voucherSeriesSegment(params.series)}` : '';
    const endpoint = `vouchers/${subpath}`;
    const queryParams: Record<string, string | number | undefined> = {
      financialyear: params.financialYear,
      fromdate: params.fromDate,
      todate: params.toDate,
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        endpoint,
        'Vouchers',
        queryParams,
      );
      return {
        Vouchers: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<VouchersResponse>(endpoint, {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getVoucher(
    series: string,
    voucherNumber: string,
    financialYear?: number,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string | number | undefined> = {};
    if (financialYear) params.financialyear = financialYear;
    const data = await transport.request<VoucherResponse>(
      `vouchers/${voucherSeriesSegment(series)}/${pathSegment('voucher number', voucherNumber)}`,
      { params },
    );
    return data.Voucher;
  }

  async function createVoucher(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<VoucherResponse>('vouchers', {
      method: 'POST',
      body: {
        Voucher: {
          ...params,
          VoucherSeries: (params.VoucherSeries as string) || 'A',
        },
      },
    });
    return data.Voucher;
  }

  interface InboxFileResponse {
    File: Record<string, unknown>;
  }
  interface VoucherFileConnectionResponse {
    VoucherFileConnection: Record<string, unknown>;
  }
  interface VoucherFileConnectionListResponse {
    VoucherFileConnections: Record<string, unknown>[];
  }

  const MIME_BY_EXT: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
  };

  function mimeForFile(fileName: string): string {
    return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
  }

  // Best-effort reverse of MIME_BY_EXT, for naming a downloaded file when the
  // caller doesn't specify an output path.
  const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
    Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
  );

  function extensionForMime(contentType: string): string {
    return EXT_BY_MIME[contentType] ?? '';
  }

  // Upload a single file to the Fortnox inbox; returns the archived File object (has .Id).
  function uploadInboxFileSnapshot(
    snapshot: OperationFileSnapshot,
  ): Promise<Record<string, unknown>> {
    const content = new Uint8Array(snapshot.content.byteLength);
    content.set(snapshot.content);
    const form = new FormData();
    form.append(
      'file',
      new Blob([content], { type: mimeForFile(snapshot.fileName) }),
      snapshot.fileName,
    );
    return transport
      .request<InboxFileResponse>('inbox', {
        method: 'POST',
        rawBody: form,
      })
      .then((data) => data.File);
  }

  async function uploadInboxFile(filePath: OperationFile): Promise<Record<string, unknown>> {
    return uploadInboxFileSnapshot(snapshotOperationFile(filePath));
  }

  // Link an already-uploaded file (by id) to a voucher. The financial year goes in
  // the `financialyear` query param, NOT the body: Fortnox treats VoucherYear in
  // the body as read-only (rejects it with error 2000321) and derives it from the
  // voucher itself.
  async function createVoucherFileConnection(
    series: string,
    voucherNumber: string,
    fileId: string,
    financialYear?: number,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<VoucherFileConnectionResponse>('voucherfileconnections', {
      method: 'POST',
      body: {
        VoucherFileConnection: {
          FileId: fileId,
          VoucherSeries: series,
          VoucherNumber: voucherNumber,
        },
      },
      params: financialYear !== undefined ? { financialyear: financialYear } : undefined,
    });
    return data.VoucherFileConnection;
  }

  async function getVoucherFileConnection(fileId: string): Promise<Record<string, unknown>> {
    const data = await transport.request<VoucherFileConnectionResponse>(
      `voucherfileconnections/${pathSegment('file id', fileId)}`,
    );
    return data.VoucherFileConnection;
  }

  async function deleteVoucherFileConnection(fileId: string): Promise<void> {
    await transport.request(`voucherfileconnections/${pathSegment('file id', fileId)}`, {
      method: 'DELETE',
    });
  }

  // Resolve the financial year from the voucher's transaction date when not given.
  // Throws (rather than silently leaving the year undefined) when it can't be
  // determined, so the user knows to pass --year explicitly — e.g. for a voucher
  // in a past financial year, which getVoucher can't fetch without the year.
  async function resolveVoucherFinancialYear(
    series: string,
    voucherNumber: string,
  ): Promise<number> {
    const voucher = await getVoucher(series, voucherNumber);
    const date = (voucher as Record<string, unknown>).TransactionDate as string | undefined;
    if (!date) {
      throw new Error(
        `Could not determine the financial year: voucher ${series}/${voucherNumber} has no TransactionDate. Pass --year explicitly.`,
      );
    }
    const fy = await listFinancialYears({ date });
    const list = (fy.FinancialYears ?? []) as Record<string, unknown>[];
    if (!list.length) {
      throw new Error(`No financial year found for voucher date ${date}. Pass --year explicitly.`);
    }
    return Number(list[0]!.Id);
  }

  // Orchestrate: resolve year if omitted, then upload+connect each file in order.
  async function attachVoucherFiles(
    params: AttachVoucherFilesParams,
  ): Promise<VoucherFileAttachment[]> {
    const fileOptions = { notRegularFileMessage: 'Not a file' };
    const files = params.filePaths.map((filePath) => ({
      file: typeof filePath === 'string' ? filePath : snapshotOperationFile(filePath, fileOptions),
      fileName: validateOperationFile(filePath, fileOptions),
    }));

    const year =
      params.financialYear ??
      (await resolveVoucherFinancialYear(params.series, params.voucherNumber));

    const results: VoucherFileAttachment[] = [];
    for (const file of files) {
      try {
        const uploaded = await uploadInboxFileSnapshot(
          snapshotOperationFile(file.file, fileOptions),
        );
        // Per Fortnox docs (best-practices/vouchers): use the uploaded file's
        // `Id` as the VoucherFileConnection FileId — NOT ArchiveFileId.
        const fileId = String((uploaded as Record<string, unknown>).Id);
        const connection = await createVoucherFileConnection(
          params.series,
          params.voucherNumber,
          fileId,
          year,
        );
        results.push({ fileName: file.fileName, fileId, voucherYear: year, connection });
      } catch (err) {
        // Surface what already succeeded so the user can locate/clean up any files
        // uploaded to the inbox before this failure.
        const done = results.map((r) => r.fileName).join(', ') || 'none';
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed attaching "${file.fileName}" to voucher ${params.series}/${params.voucherNumber}: ${detail}. Files already attached this run: ${done}.`,
        );
      }
    }
    return results;
  }

  // List the files already attached to a voucher — the read counterpart to
  // attachVoucherFiles. `financialYear` is optional (Fortnox will match across
  // years without it) but recommended: voucher numbers reset every financial
  // year, so series+number alone can be ambiguous.
  async function listVoucherAttachments(
    series: string,
    voucherNumber: string,
    financialYear?: number,
  ): Promise<VoucherAttachment[]> {
    const data = await transport.request<VoucherFileConnectionListResponse>(
      'voucherfileconnections',
      {
        params: {
          voucherseries: series,
          vouchernumber: voucherNumber,
          voucheryear: financialYear,
        },
      },
    );
    return (data.VoucherFileConnections ?? []).map((c) => ({
      fileName: String(c.Name ?? ''),
      fileId: String(c.FileId),
      voucherSeries: String(c.VoucherSeries ?? series),
      voucherNumber: String(c.VoucherNumber ?? voucherNumber),
      voucherYear: c.VoucherYear !== undefined ? Number(c.VoucherYear) : undefined,
    }));
  }

  // Download the actual bytes of a file attached to a voucher (or sitting in
  // the inbox generally) — the read counterpart to uploadInboxFile. fileId
  // comes from listVoucherAttachments (its `fileId`) or from a prior
  // uploadInboxFile/attachVoucherFiles call.
  async function getVoucherFile(fileId: string): Promise<VoucherFileContent> {
    const { buffer, contentType } = await transport.requestFile(
      `inbox/${pathSegment('file id', fileId)}`,
    );
    return { fileId, contentType, buffer };
  }

  // Fetch the rows of many vouchers sequentially (the transport rate-limits, so
  // there is deliberately no concurrency). One failing voucher must not hide the
  // others: its error is collected next to the ones that succeeded.
  interface FetchTarget extends VoucherReference {
    year?: number;
    listError?: string;
  }

  async function fetchVoucherTargets(
    targets: FetchTarget[],
  ): Promise<Pick<GetVouchersResult, 'vouchers' | 'errors'>> {
    const vouchers: Record<string, unknown>[] = [];
    const errors: VoucherFetchError[] = [];
    for (const target of targets) {
      const { series, number } = target;
      if (target.listError) {
        errors.push({ series, number, error: target.listError });
        continue;
      }
      try {
        const voucher = await getVoucher(series, number, target.year);
        if (!voucher) throw new Error('Fortnox returned no voucher');
        vouchers.push(voucher);
      } catch (err) {
        errors.push({ series, number, error: errorMessage(err) });
      }
    }
    return { vouchers, errors };
  }

  // Bulk read of vouchers WITH rows (the list endpoint has none): either an explicit
  // series/number list, or every voucher of a period. Cross-field validation lives
  // here because the MCP layer only accepts plain Zod shapes.
  async function getVouchers(params: GetVouchersParams): Promise<GetVouchersResult> {
    const { vouchers: refs, fromDate, toDate, series, financialYear, limit } = params;
    const periodRequested = fromDate !== undefined || toDate !== undefined;

    if (refs !== undefined && (periodRequested || series !== undefined || limit !== undefined)) {
      throw new Error(
        'Specify either "vouchers" or a period ("fromDate"/"toDate", optionally "series" and "limit"), not both: the two modes are mutually exclusive.',
      );
    }
    if (refs === undefined && !periodRequested) {
      throw new Error(
        'Specify either "vouchers" (1 to 50 series/number pairs) or "fromDate" and "toDate" (a period).',
      );
    }
    assertFinancialYear(financialYear);

    if (refs !== undefined) {
      if (!Array.isArray(refs) || refs.length === 0) {
        throw new Error('"vouchers" must contain 1 to 50 series/number pairs.');
      }
      if (refs.length > MAX_VOUCHERS_PER_BULK_READ) {
        throw new Error(
          `"vouchers" must contain at most ${MAX_VOUCHERS_PER_BULK_READ} items (got ${refs.length}). Split the request, or use "fromDate"/"toDate" to read a whole period.`,
        );
      }
      refs.forEach((ref, index) => {
        try {
          voucherSeriesSegment(ref.series);
          pathSegment('voucher number', ref.number);
        } catch (err) {
          throw new Error(`vouchers[${index}]: ${errorMessage(err)}`);
        }
      });
      return fetchVoucherTargets(
        refs.map((ref) => ({ series: ref.series, number: ref.number, year: financialYear })),
      );
    }

    const period = assertPeriod(fromDate, toDate);
    if (series !== undefined) voucherSeriesSegment(series);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > MAX_PERIOD_VOUCHER_LIMIT)
    ) {
      throw new Error(
        `Invalid "limit": ${limit} must be an integer from 1 to ${MAX_PERIOD_VOUCHER_LIMIT} (default ${DEFAULT_PERIOD_VOUCHER_LIMIT}).`,
      );
    }
    const cap = limit ?? DEFAULT_PERIOD_VOUCHER_LIMIT;

    const listed = await listVouchers({ all: true, series, financialYear, ...period });
    const items = listed.Vouchers ?? [];
    const targets: FetchTarget[] = items.slice(0, cap).map((item) => {
      const itemSeries = String(item.VoucherSeries ?? '');
      const itemNumber = String(item.VoucherNumber ?? '');
      const listError =
        !itemSeries || !itemNumber
          ? 'List item has no VoucherSeries/VoucherNumber, so its rows cannot be fetched.'
          : undefined;
      return {
        series: itemSeries,
        number: itemNumber,
        // Voucher numbers restart every financial year, so pin the year when it is known.
        year: financialYear ?? listItemYear(item),
        listError,
      };
    });

    const result = await fetchVoucherTargets(targets);
    return items.length > cap
      ? { ...result, truncated: true, totalInPeriod: items.length }
      : result;
  }

  // Which vouchers of a period have / lack attached files. Two list calls and an
  // in-memory join; never one request per voucher.
  async function getVoucherAttachmentOverview(
    params: VoucherAttachmentOverviewParams,
  ): Promise<VoucherAttachmentOverview> {
    const { series, financialYear, onlyMissing = false } = params;
    const period = assertPeriod(params.fromDate, params.toDate);
    assertFinancialYear(financialYear);
    if (series !== undefined) voucherSeriesSegment(series);

    const listed = await listVouchers({ all: true, series, financialYear, ...period });
    // Narrow the connection list server-side where the endpoint allows it. It has no
    // date filter, so a period inside a larger financial year still reads all of that
    // year's connections and is narrowed by the join below.
    const { items: connections } = await transport.fetchAllPages<Record<string, unknown>>(
      'voucherfileconnections',
      'VoucherFileConnections',
      { voucherseries: series, voucheryear: financialYear },
    );

    const bySeriesAndNumber = new Map<string, Record<string, unknown>[]>();
    for (const connection of connections) {
      const key = `${String(connection.VoucherSeries)}\u0000${String(connection.VoucherNumber)}`;
      const group = bySeriesAndNumber.get(key);
      if (group) group.push(connection);
      else bySeriesAndNumber.set(key, [connection]);
    }

    const rows: VoucherAttachmentOverviewRow[] = (listed.Vouchers ?? []).map((voucher) => {
      const voucherSeries = String(voucher.VoucherSeries ?? '');
      const voucherNumber = String(voucher.VoucherNumber ?? '');
      const year = listItemYear(voucher);
      // Voucher numbers restart each financial year: compare the year too, but only
      // when both sides actually report one.
      const matches = (
        bySeriesAndNumber.get(`${voucherSeries}\u0000${voucherNumber}`) ?? []
      ).filter((connection) => {
        const connectionYear = Number(connection.VoucherYear);
        return year === undefined || !Number.isInteger(connectionYear) || connectionYear === year;
      });
      return {
        series: voucherSeries,
        number: voucherNumber,
        transactionDate: String(voucher.TransactionDate ?? ''),
        description: String(voucher.Description ?? ''),
        attachmentCount: matches.length,
        fileNames: matches.map((connection) => String(connection.Name ?? '')).filter(Boolean),
      };
    });

    const withAttachments = rows.filter((row) => row.attachmentCount > 0).length;
    const shown = onlyMissing ? rows.filter((row) => row.attachmentCount === 0) : rows;
    const capped = shown.length > MAX_ATTACHMENT_OVERVIEW_VOUCHERS;

    return {
      period: {
        ...period,
        ...(series !== undefined ? { series } : {}),
        ...(financialYear !== undefined ? { financialYear } : {}),
      },
      totalVouchers: rows.length,
      withAttachments,
      withoutAttachments: rows.length - withAttachments,
      vouchers: capped ? shown.slice(0, MAX_ATTACHMENT_OVERVIEW_VOUCHERS) : shown,
      ...(capped ? { truncated: true } : {}),
    };
  }

  return {
    listVouchers,
    getVoucher,
    getVouchers,
    getVoucherAttachmentOverview,
    createVoucher,
    uploadInboxFile,
    createVoucherFileConnection,
    getVoucherFileConnection,
    deleteVoucherFileConnection,
    attachVoucherFiles,
    listVoucherAttachments,
    getVoucherFile,
    extensionForMime,
  };
}

export const {
  listVouchers,
  getVoucher,
  getVouchers,
  getVoucherAttachmentOverview,
  createVoucher,
  uploadInboxFile,
  createVoucherFileConnection,
  getVoucherFileConnection,
  deleteVoucherFileConnection,
  attachVoucherFiles,
  listVoucherAttachments,
  getVoucherFile,
  extensionForMime,
} = createVoucherOperations(defaultFortnoxTransport);
