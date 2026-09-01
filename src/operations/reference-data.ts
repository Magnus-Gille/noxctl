import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

export interface ListReferenceParams {
  page?: number;
  limit?: number;
  all?: boolean;
}

interface ReferenceDefinition {
  endpoint: string;
  listKey: string;
  singleKey?: string;
}

function createReferenceReader(transport: FortnoxTransport, definition: ReferenceDefinition) {
  async function list(params: ListReferenceParams = {}) {
    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        definition.endpoint,
        definition.listKey,
      );
      return {
        items,
        raw: {
          [definition.listKey]: items,
          MetaInformation: {
            '@TotalResources': totalResources,
            '@TotalPages': 1,
            '@CurrentPage': 1,
          },
        },
      };
    }
    const raw = await transport.request<Record<string, unknown>>(definition.endpoint, {
      params: { page: params.page || 1, limit: params.limit || 100 },
    });
    const value = raw[definition.listKey];
    return { items: Array.isArray(value) ? value : value ? [value] : [], raw };
  }

  async function get(identifier: string) {
    if (!definition.singleKey) throw new Error(`${definition.endpoint} has no get operation`);
    const raw = await transport.request<Record<string, unknown>>(
      `${definition.endpoint}/${encodeURIComponent(identifier)}`,
    );
    return { item: (raw[definition.singleKey] ?? {}) as Record<string, unknown>, raw };
  }

  return { list, get };
}

export function createReferenceDataOperations(transport: FortnoxTransport) {
  const currencies = createReferenceReader(transport, {
    endpoint: 'currencies',
    listKey: 'Currencies',
    singleKey: 'Currency',
  });
  const units = createReferenceReader(transport, {
    endpoint: 'units',
    listKey: 'Units',
    singleKey: 'Unit',
  });
  const modesOfPayments = createReferenceReader(transport, {
    endpoint: 'modesofpayments',
    listKey: 'ModesOfPayments',
    singleKey: 'ModeOfPayment',
  });
  const termsOfDeliveries = createReferenceReader(transport, {
    endpoint: 'termsofdeliveries',
    listKey: 'TermsOfDeliveries',
    singleKey: 'TermsOfDelivery',
  });
  const termsOfPayments = createReferenceReader(transport, {
    endpoint: 'termsofpayments',
    listKey: 'TermsOfPayments',
    singleKey: 'TermsOfPayment',
  });
  const waysOfDelivery = createReferenceReader(transport, {
    endpoint: 'wayofdeliveries',
    listKey: 'WayOfDeliveries',
    singleKey: 'WayOfDelivery',
  });
  const voucherSeries = createReferenceReader(transport, {
    endpoint: 'voucherseries',
    listKey: 'VoucherSeriesCollection',
    singleKey: 'VoucherSeries',
  });
  const predefinedVoucherSeries = createReferenceReader(transport, {
    endpoint: 'predefinedvoucherseries',
    listKey: 'PreDefinedVoucherSeriesCollection',
    singleKey: 'PreDefinedVoucherSeries',
  });
  const accountCharts = createReferenceReader(transport, {
    endpoint: 'accountcharts',
    listKey: 'AccountCharts',
  });
  const predefinedAccounts = createReferenceReader(transport, {
    endpoint: 'predefinedaccounts',
    listKey: 'PreDefinedAccounts',
    singleKey: 'PreDefinedAccount',
  });
  const customerReferences = createReferenceReader(transport, {
    endpoint: 'customerreferences',
    listKey: 'CustomerReference',
    singleKey: 'CustomerReference',
  });

  return {
    listCurrencies: currencies.list,
    getCurrency: currencies.get,
    listUnits: units.list,
    getUnit: units.get,
    listModesOfPayments: modesOfPayments.list,
    getModeOfPayment: modesOfPayments.get,
    listTermsOfDeliveries: termsOfDeliveries.list,
    getTermOfDelivery: termsOfDeliveries.get,
    listTermsOfPayments: termsOfPayments.list,
    getTermOfPayment: termsOfPayments.get,
    listWaysOfDelivery: waysOfDelivery.list,
    getWayOfDelivery: waysOfDelivery.get,
    listVoucherSeries: voucherSeries.list,
    getVoucherSeries: voucherSeries.get,
    listPredefinedVoucherSeries: predefinedVoucherSeries.list,
    getPredefinedVoucherSeries: predefinedVoucherSeries.get,
    listAccountCharts: accountCharts.list,
    listPredefinedAccounts: predefinedAccounts.list,
    getPredefinedAccount: predefinedAccounts.get,
    listCustomerReferences: customerReferences.list,
    getCustomerReference: customerReferences.get,
  };
}

export const referenceDataOperations = createReferenceDataOperations(defaultFortnoxTransport);
export const {
  listCurrencies,
  getCurrency,
  listUnits,
  getUnit,
  listModesOfPayments,
  getModeOfPayment,
  listTermsOfDeliveries,
  getTermOfDelivery,
  listTermsOfPayments,
  getTermOfPayment,
  listWaysOfDelivery,
  getWayOfDelivery,
  listVoucherSeries,
  getVoucherSeries,
  listPredefinedVoucherSeries,
  getPredefinedVoucherSeries,
  listAccountCharts,
  listPredefinedAccounts,
  getPredefinedAccount,
  listCustomerReferences,
  getCustomerReference,
} = referenceDataOperations;
