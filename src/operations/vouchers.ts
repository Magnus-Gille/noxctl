import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { voucherSeriesSegment } from '../identifiers.js';
import { listFinancialYears } from './financial-years.js';

interface VoucherResponse {
  Voucher: Record<string, unknown>;
}

interface VouchersResponse {
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

export async function listVouchers(params: ListVouchersParams = {}): Promise<VouchersResponse> {
  const subpath = params.series ? `sublist/${voucherSeriesSegment(params.series)}` : '';
  const endpoint = `vouchers/${subpath}`;
  const queryParams: Record<string, string | number | undefined> = {
    financialyear: params.financialYear,
    fromdate: params.fromDate,
    todate: params.toDate,
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      endpoint,
      'Vouchers',
      queryParams,
    );
    return {
      Vouchers: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<VouchersResponse>(endpoint, {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getVoucher(
  series: string,
  voucherNumber: string,
  financialYear?: number,
): Promise<Record<string, unknown>> {
  const params: Record<string, string | number | undefined> = {};
  if (financialYear) params.financialyear = financialYear;
  const data = await fortnoxRequest<VoucherResponse>(
    `vouchers/${voucherSeriesSegment(series)}/${encodeURIComponent(voucherNumber)}`,
    { params },
  );
  return data.Voucher;
}

export async function createVoucher(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<VoucherResponse>('vouchers', {
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

function mimeForFile(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// Upload a single file to the Fortnox inbox; returns the archived File object (has .Id).
export async function uploadInboxFile(filePath: string): Promise<Record<string, unknown>> {
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimeForFile(filePath) }), basename(filePath));
  const data = await fortnoxRequest<InboxFileResponse>('inbox', { method: 'POST', rawBody: form });
  return data.File;
}

// Link an already-uploaded file (by id) to a voucher. The financial year goes in
// the `financialyear` query param, NOT the body: Fortnox treats VoucherYear in
// the body as read-only (rejects it with error 2000321) and derives it from the
// voucher itself.
export async function createVoucherFileConnection(
  series: string,
  voucherNumber: string,
  fileId: string,
  financialYear?: number,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<VoucherFileConnectionResponse>('voucherfileconnections', {
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

export interface AttachVoucherFilesParams {
  series: string;
  voucherNumber: string;
  filePaths: string[];
  financialYear?: number;
}
export interface VoucherFileAttachment {
  fileName: string;
  fileId: string;
  voucherYear: number;
  connection: Record<string, unknown>;
}

// Resolve the financial year from the voucher's transaction date when not given.
// Throws (rather than silently leaving the year undefined) when it can't be
// determined, so the user knows to pass --year explicitly — e.g. for a voucher
// in a past financial year, which getVoucher can't fetch without the year.
async function resolveVoucherFinancialYear(series: string, voucherNumber: string): Promise<number> {
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
export async function attachVoucherFiles(
  params: AttachVoucherFilesParams,
): Promise<VoucherFileAttachment[]> {
  // Pre-flight: confirm every file exists before uploading any of them, so a
  // typo in a later path can't leave earlier files orphaned in the inbox.
  for (const filePath of params.filePaths) {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!statSync(filePath).isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
  }

  const year =
    params.financialYear ??
    (await resolveVoucherFinancialYear(params.series, params.voucherNumber));

  const results: VoucherFileAttachment[] = [];
  for (const filePath of params.filePaths) {
    try {
      const file = await uploadInboxFile(filePath);
      // Per Fortnox docs (best-practices/vouchers): use the uploaded file's
      // `Id` as the VoucherFileConnection FileId — NOT ArchiveFileId.
      const fileId = String((file as Record<string, unknown>).Id);
      const connection = await createVoucherFileConnection(
        params.series,
        params.voucherNumber,
        fileId,
        year,
      );
      results.push({ fileName: basename(filePath), fileId, voucherYear: year, connection });
    } catch (err) {
      // Surface what already succeeded so the user can locate/clean up any files
      // uploaded to the inbox before this failure.
      const done = results.map((r) => r.fileName).join(', ') || 'none';
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed attaching "${basename(filePath)}" to voucher ${params.series}/${params.voucherNumber}: ${detail}. Files already attached this run: ${done}.`,
      );
    }
  }
  return results;
}
