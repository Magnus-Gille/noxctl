import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';
import { voucherSeriesSegment } from '../identifiers.js';

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
