import { fortnoxRequest } from '../fortnox-client.js';

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
}

export async function listVouchers(params: ListVouchersParams = {}): Promise<VouchersResponse> {
  const subpath = params.series ? `sublist/${params.series}` : '';
  return fortnoxRequest<VouchersResponse>(`vouchers/${subpath}`, {
    params: {
      financialyear: params.financialYear,
      fromdate: params.fromDate,
      todate: params.toDate,
      page: params.page || 1,
      limit: params.limit || 100,
    },
  });
}

export async function createVoucher(params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
