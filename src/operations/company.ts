import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

interface CompanyInfoResponse {
  CompanyInformation: Record<string, unknown>;
}

export function createCompanyOperations(transport: FortnoxTransport) {
  async function getCompanyInfo(): Promise<Record<string, unknown>> {
    const data = await transport.request<CompanyInfoResponse>('companyinformation');
    return data.CompanyInformation;
  }

  return { getCompanyInfo };
}

export const { getCompanyInfo } = createCompanyOperations(defaultFortnoxTransport);
