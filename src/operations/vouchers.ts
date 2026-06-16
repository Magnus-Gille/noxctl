import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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

// Upload a single file to the Fortnox inbox; returns the archived File object (has .Id).
export async function uploadInboxFile(filePath: string): Promise<Record<string, unknown>> {
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), basename(filePath));
  const data = await fortnoxRequest<InboxFileResponse>('inbox', { method: 'POST', rawBody: form });
  return data.File;
}

// Link an already-uploaded file (by id) to a voucher.
export async function createVoucherFileConnection(
  series: string,
  voucherNumber: string,
  fileId: string,
  financialYear?: number,
): Promise<Record<string, unknown>> {
  const connection: Record<string, unknown> = {
    FileId: fileId,
    VoucherSeries: series,
    VoucherNumber: voucherNumber,
  };
  if (financialYear !== undefined) connection.VoucherYear = financialYear;
  const data = await fortnoxRequest<VoucherFileConnectionResponse>('voucherfileconnections', {
    method: 'POST',
    body: { VoucherFileConnection: connection },
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
  connection: Record<string, unknown>;
}

// Resolve the financial year from the voucher's transaction date when not given.
async function resolveVoucherFinancialYear(
  series: string,
  voucherNumber: string,
): Promise<number | undefined> {
  const voucher = await getVoucher(series, voucherNumber);
  const date = (voucher as Record<string, unknown>).TransactionDate as string | undefined;
  if (!date) return undefined;
  const fy = await listFinancialYears({ date });
  const list = (fy.FinancialYears ?? []) as Record<string, unknown>[];
  return list.length ? Number(list[0]!.Id) : undefined;
}

// Orchestrate: resolve year if omitted, then upload+connect each file in order.
export async function attachVoucherFiles(
  params: AttachVoucherFilesParams,
): Promise<VoucherFileAttachment[]> {
  const year =
    params.financialYear ??
    (await resolveVoucherFinancialYear(params.series, params.voucherNumber));
  const results: VoucherFileAttachment[] = [];
  for (const filePath of params.filePaths) {
    const file = await uploadInboxFile(filePath);
    const fileId = String((file as Record<string, unknown>).Id);
    const connection = await createVoucherFileConnection(
      params.series,
      params.voucherNumber,
      fileId,
      year,
    );
    results.push({ fileName: basename(filePath), fileId, connection });
  }
  return results;
}
