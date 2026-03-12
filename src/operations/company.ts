import { fortnoxRequest } from '../fortnox-client.js';

interface CompanyInfoResponse {
  CompanyInformation: Record<string, unknown>;
}

export async function getCompanyInfo(): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<CompanyInfoResponse>('companyinformation');
  return data.CompanyInformation;
}
