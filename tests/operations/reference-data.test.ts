import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createReferenceDataOperations } from '../../src/operations/reference-data.js';

describe('reference data operations', () => {
  it('uses every reviewed native list and get endpoint and preserves envelopes', async () => {
    const request = vi.fn();
    const transport = { request } as unknown as FortnoxTransport;
    const operations = createReferenceDataOperations(transport);
    const definitions = [
      ['listCurrencies', 'getCurrency', 'currencies', 'Currencies', 'Currency'],
      ['listUnits', 'getUnit', 'units', 'Units', 'Unit'],
      [
        'listModesOfPayments',
        'getModeOfPayment',
        'modesofpayments',
        'ModesOfPayments',
        'ModeOfPayment',
      ],
      [
        'listTermsOfDeliveries',
        'getTermOfDelivery',
        'termsofdeliveries',
        'TermsOfDeliveries',
        'TermsOfDelivery',
      ],
      [
        'listTermsOfPayments',
        'getTermOfPayment',
        'termsofpayments',
        'TermsOfPayments',
        'TermsOfPayment',
      ],
      [
        'listWaysOfDelivery',
        'getWayOfDelivery',
        'wayofdeliveries',
        'WayOfDeliveries',
        'WayOfDelivery',
      ],
      [
        'listVoucherSeries',
        'getVoucherSeries',
        'voucherseries',
        'VoucherSeriesCollection',
        'VoucherSeries',
      ],
      [
        'listPredefinedVoucherSeries',
        'getPredefinedVoucherSeries',
        'predefinedvoucherseries',
        'PreDefinedVoucherSeriesCollection',
        'PreDefinedVoucherSeries',
      ],
      [
        'listPredefinedAccounts',
        'getPredefinedAccount',
        'predefinedaccounts',
        'PreDefinedAccounts',
        'PreDefinedAccount',
      ],
      [
        'listCustomerReferences',
        'getCustomerReference',
        'customerreferences',
        'CustomerReference',
        'CustomerReference',
      ],
    ] as const;
    const dynamic = operations as unknown as Record<string, (arg?: unknown) => Promise<unknown>>;

    for (const [listName, getName, endpoint, listKey, singleKey] of definitions) {
      request.mockResolvedValueOnce({ [listKey]: [{ Code: 'A' }] });
      const listed = (await dynamic[listName]?.({ page: 2, limit: 20 })) as {
        items: Record<string, unknown>[];
      };
      expect(listed.items).toEqual([{ Code: 'A' }]);
      expect(request).toHaveBeenLastCalledWith(endpoint, {
        params: { page: 2, limit: 20 },
      });

      request.mockResolvedValueOnce({ [singleKey]: { Code: 'A' } });
      const received = (await dynamic[getName]?.('A/B')) as { item: Record<string, unknown> };
      expect(received.item).toEqual({ Code: 'A' });
      expect(request).toHaveBeenLastCalledWith(`${endpoint}/A%2FB`);
    }

    request.mockResolvedValueOnce({ AccountCharts: [{ Name: 'BAS' }] });
    const charts = await operations.listAccountCharts();
    expect(charts.items).toEqual([{ Name: 'BAS' }]);
    expect(request).toHaveBeenLastCalledWith('accountcharts', {
      params: { page: 1, limit: 100 },
    });
  });
});
