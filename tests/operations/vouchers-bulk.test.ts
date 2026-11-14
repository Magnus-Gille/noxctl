import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createVoucherOperations } from '../../src/operations/vouchers.js';

type Handler = (endpoint: string, options?: { params?: Record<string, unknown> }) => unknown;

// A hand-rolled transport: the real one rate-limits to 25 requests per 5 s, which
// would make the 100/200-voucher cap tests take far longer than they are worth.
function stubTransport(handlers: {
  request?: Handler;
  fetchAllPages?: (
    endpoint: string,
    dataKey: string,
    params?: Record<string, unknown>,
  ) => Record<string, unknown>[];
}) {
  const request = vi.fn(async (endpoint: string, options?: { params?: Record<string, unknown> }) =>
    handlers.request ? handlers.request(endpoint, options) : {},
  );
  const fetchAllPages = vi.fn(
    async (endpoint: string, dataKey: string, params?: Record<string, unknown>) => {
      const items = handlers.fetchAllPages ? handlers.fetchAllPages(endpoint, dataKey, params) : [];
      return { items, totalResources: items.length };
    },
  );
  const transport = {
    request,
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn(),
    requestPdfFromMutation: vi.fn(),
    requestFile: vi.fn(),
    fetchAllPages,
  } as unknown as FortnoxTransport;
  return { transport, request, fetchAllPages };
}

const voucherBody = (series: string, number: string, extra: Record<string, unknown> = {}) => ({
  Voucher: {
    VoucherSeries: series,
    VoucherNumber: number,
    TransactionDate: '2026-10-03',
    Description: `Voucher ${series}${number}`,
    VoucherRows: [{ Account: 1930, Debit: 100 }],
    ...extra,
  },
});

const listItems = (count: number, series = 'A', year?: number) =>
  Array.from({ length: count }, (_, i) => ({
    VoucherSeries: series,
    VoucherNumber: i + 1,
    TransactionDate: '2026-10-03',
    Description: `Voucher ${series}${i + 1}`,
    ...(year !== undefined ? { Year: year } : {}),
  }));

describe('getVouchers: explicit list', () => {
  it('fetches each voucher with rows, in request order, passing the financial year', async () => {
    const { transport, request } = stubTransport({
      request: (endpoint) => {
        const [, series, number] = endpoint.split('/');
        return voucherBody(series!, number!);
      },
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({
      vouchers: [
        { series: 'B', number: '7' },
        { series: 'A', number: '2' },
      ],
      financialYear: 4,
    });

    expect(result.errors).toEqual([]);
    expect(result.vouchers.map((v) => `${v.VoucherSeries}${v.VoucherNumber}`)).toEqual([
      'B7',
      'A2',
    ]);
    expect(result.vouchers[0]!.VoucherRows).toEqual([{ Account: 1930, Debit: 100 }]);
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('totalInPeriod');
    expect(request).toHaveBeenNthCalledWith(1, 'vouchers/B/7', { params: { financialyear: 4 } });
    expect(request).toHaveBeenNthCalledWith(2, 'vouchers/A/2', { params: { financialyear: 4 } });
  });

  it('isolates a failing voucher: collects its error and keeps going', async () => {
    const { transport } = stubTransport({
      request: (endpoint) => {
        if (endpoint === 'vouchers/A/2') {
          throw new Error('Fortnox API error (404): Verifikationen finns inte.');
        }
        const [, series, number] = endpoint.split('/');
        return voucherBody(series!, number!);
      },
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({
      vouchers: [
        { series: 'A', number: '1' },
        { series: 'A', number: '2' },
        { series: 'A', number: '3' },
      ],
    });

    expect(result.vouchers.map((v) => v.VoucherNumber)).toEqual(['1', '3']);
    expect(result.errors).toEqual([
      { series: 'A', number: '2', error: 'Fortnox API error (404): Verifikationen finns inte.' },
    ]);
  });

  it('returns normally with every error when every voucher fails', async () => {
    const { transport } = stubTransport({
      request: () => {
        throw new Error('Fortnox API error (403): Missing "bookkeeping" scope.');
      },
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({
      vouchers: [
        { series: 'A', number: '1' },
        { series: 'A', number: '2' },
      ],
    });

    expect(result.vouchers).toEqual([]);
    expect(result.errors.map((e) => `${e.series}/${e.number}`)).toEqual(['A/1', 'A/2']);
    expect(result.errors[0]!.error).toContain('Missing "bookkeeping" scope');
  });

  it('fetches sequentially, never concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { transport } = stubTransport({
      request: async (endpoint: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        const [, series, number] = endpoint.split('/');
        return voucherBody(series!, number!);
      },
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({
      vouchers: [1, 2, 3, 4].map((n) => ({ series: 'A', number: String(n) })),
    });

    expect(maxInFlight).toBe(1);
  });

  it('does not list vouchers in explicit mode', async () => {
    const { transport, fetchAllPages } = stubTransport({
      request: () => voucherBody('A', '1'),
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({ vouchers: [{ series: 'A', number: '1' }] });

    expect(fetchAllPages).not.toHaveBeenCalled();
  });
});

describe('getVouchers: period', () => {
  const detail: Handler = (endpoint) => {
    const [, series, number] = endpoint.split('/');
    return voucherBody(series!, number!);
  };

  it('lists the period with all pages, then fetches each voucher detail in list order', async () => {
    const { transport, request, fetchAllPages } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(3),
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(fetchAllPages).toHaveBeenCalledTimes(1);
    expect(fetchAllPages).toHaveBeenCalledWith('vouchers/', 'Vouchers', {
      financialyear: undefined,
      fromdate: '2026-10-01',
      todate: '2026-10-31',
    });
    expect(request.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      'vouchers/A/1',
      'vouchers/A/2',
      'vouchers/A/3',
    ]);
    expect(result.vouchers.map((v) => v.VoucherNumber)).toEqual(['1', '2', '3']);
    expect(result.errors).toEqual([]);
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('totalInPeriod');
  });

  it('restricts the listing to one series via the sublist endpoint', async () => {
    const { transport, fetchAllPages } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(1, 'B'),
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31', series: 'B' });

    expect(fetchAllPages.mock.calls[0]![0]).toBe('vouchers/sublist/B');
  });

  it('passes an explicit financial year to the list and to every detail request', async () => {
    const { transport, request, fetchAllPages } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(2, 'A', 9),
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({ fromDate: '2025-10-01', toDate: '2025-10-31', financialYear: 4 });

    expect(fetchAllPages.mock.calls[0]![2]).toMatchObject({ financialyear: 4 });
    // The caller's year wins over the list item's own Year.
    expect(request).toHaveBeenNthCalledWith(1, 'vouchers/A/1', { params: { financialyear: 4 } });
    expect(request).toHaveBeenNthCalledWith(2, 'vouchers/A/2', { params: { financialyear: 4 } });
  });

  it("falls back to each list item's Year when no financial year is given", async () => {
    const { transport, request } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(2, 'A', 5),
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(request).toHaveBeenNthCalledWith(1, 'vouchers/A/1', { params: { financialyear: 5 } });
    expect(request).toHaveBeenNthCalledWith(2, 'vouchers/A/2', { params: { financialyear: 5 } });
  });

  it('leaves the year out when neither the caller nor the list item has one', async () => {
    const { transport, request } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(1),
    });
    const { getVouchers } = createVoucherOperations(transport);

    await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(request).toHaveBeenCalledWith('vouchers/A/1', { params: {} });
  });

  it('fetches rows only for the first `limit` vouchers and flags truncation', async () => {
    const { transport, request } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(5),
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31', limit: 2 });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.vouchers.map((v) => v.VoucherNumber)).toEqual(['1', '2']);
    expect(result.truncated).toBe(true);
    expect(result.totalInPeriod).toBe(5);
  });

  it('does not flag truncation when the period fits exactly in the limit', async () => {
    const { transport } = stubTransport({ request: detail, fetchAllPages: () => listItems(2) });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31', limit: 2 });

    expect(result.vouchers).toHaveLength(2);
    expect(result).not.toHaveProperty('truncated');
  });

  it('defaults the cap to 100 vouchers', async () => {
    const { transport, request } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(130),
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-01-01', toDate: '2026-12-31' });

    expect(request).toHaveBeenCalledTimes(100);
    expect(result.vouchers).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.totalInPeriod).toBe(130);
  });

  it('allows a limit of up to 200', async () => {
    const { transport, request } = stubTransport({
      request: detail,
      fetchAllPages: () => listItems(210),
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      limit: 200,
    });

    expect(request).toHaveBeenCalledTimes(200);
    expect(result.truncated).toBe(true);
    expect(result.totalInPeriod).toBe(210);
  });

  it('returns an empty result for an empty period without any detail request', async () => {
    const { transport, request } = stubTransport({ fetchAllPages: () => [] });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(result).toEqual({ vouchers: [], errors: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('isolates a failing detail fetch using the list item series and number', async () => {
    const { transport } = stubTransport({
      request: (endpoint) => {
        if (endpoint === 'vouchers/A/2') throw new Error('boom');
        return detail(endpoint);
      },
      fetchAllPages: () => listItems(3),
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(result.vouchers.map((v) => v.VoucherNumber)).toEqual(['1', '3']);
    expect(result.errors).toEqual([{ series: 'A', number: '2', error: 'boom' }]);
  });

  it('reports a malformed list item instead of silently skipping it', async () => {
    const { transport } = stubTransport({
      request: detail,
      fetchAllPages: () => [{ VoucherSeries: 'A' }, ...listItems(1)],
    });
    const { getVouchers } = createVoucherOperations(transport);

    const result = await getVouchers({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(result.vouchers).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/VoucherNumber/);
  });
});

describe('getVouchers: input validation', () => {
  const refs = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ series: 'A', number: String(i + 1) }));

  async function expectRejected(
    params: Parameters<ReturnType<typeof setup>['getVouchers']>[0],
    pattern: RegExp,
  ) {
    const { getVouchers, request, fetchAllPages } = setup();
    await expect(getVouchers(params)).rejects.toThrow(pattern);
    expect(request).not.toHaveBeenCalled();
    expect(fetchAllPages).not.toHaveBeenCalled();
  }

  function setup() {
    const { transport, request, fetchAllPages } = stubTransport({});
    return { ...createVoucherOperations(transport), request, fetchAllPages };
  }

  it('requires one of the two modes', async () => {
    await expectRejected({}, /either "vouchers".*or "fromDate" and "toDate"/);
  });

  it('rejects mixing the explicit list with a period', async () => {
    await expectRejected(
      { vouchers: refs(1), fromDate: '2026-10-01', toDate: '2026-10-31' },
      /mutually exclusive/,
    );
  });

  it('rejects mixing the explicit list with series or limit', async () => {
    await expectRejected({ vouchers: refs(1), series: 'A' }, /mutually exclusive/);
    await expectRejected({ vouchers: refs(1), limit: 5 }, /mutually exclusive/);
  });

  it('rejects an empty explicit list', async () => {
    await expectRejected({ vouchers: [] }, /1 to 50/);
  });

  it('rejects more than 50 explicit vouchers', async () => {
    await expectRejected({ vouchers: refs(51) }, /at most 50/);
  });

  it('accepts exactly 50 explicit vouchers', async () => {
    const { transport, request } = stubTransport({ request: () => voucherBody('A', '1') });
    const { getVouchers } = createVoucherOperations(transport);
    const result = await getVouchers({ vouchers: refs(50) });
    expect(request).toHaveBeenCalledTimes(50);
    expect(result.vouchers).toHaveLength(50);
  });

  it('rejects an unsafe series or empty number before any request', async () => {
    await expectRejected({ vouchers: [{ series: '../A', number: '1' }] }, /Invalid voucher series/);
    await expectRejected({ vouchers: [{ series: 'A', number: '' }] }, /voucher number/);
  });

  it('requires both dates in period mode', async () => {
    await expectRejected({ fromDate: '2026-10-01' }, /both "fromDate" and "toDate"/);
    await expectRejected({ toDate: '2026-10-31' }, /both "fromDate" and "toDate"/);
    await expectRejected({ series: 'A' }, /either "vouchers"/);
  });

  it.each(['2026-13-01', '2026-02-30', '20261001', '2026-1-1', 'yesterday'])(
    'rejects the invalid date %s',
    async (bad) => {
      await expectRejected({ fromDate: bad, toDate: '2026-10-31' }, /YYYY-MM-DD/);
      await expectRejected({ fromDate: '2026-10-01', toDate: bad }, /YYYY-MM-DD/);
    },
  );

  it('rejects a period that ends before it starts', async () => {
    await expectRejected({ fromDate: '2026-10-31', toDate: '2026-10-01' }, /before/);
  });

  it.each([0, -1, 201, 1.5, Number.NaN])('rejects limit %s', async (limit) => {
    await expectRejected({ fromDate: '2026-10-01', toDate: '2026-10-31', limit }, /limit/);
  });

  it('rejects an invalid financial year', async () => {
    await expectRejected(
      { fromDate: '2026-10-01', toDate: '2026-10-31', financialYear: 0 },
      /financialYear/,
    );
  });
});

describe('getVoucherAttachmentOverview', () => {
  const connection = (
    series: string,
    number: string,
    name: string,
    year?: number,
    fileId = `${series}${number}-${name}`,
  ) => ({
    FileId: fileId,
    Name: name,
    VoucherSeries: series,
    VoucherNumber: number,
    ...(year !== undefined ? { VoucherYear: year } : {}),
  });

  function setupOverview(
    vouchers: Record<string, unknown>[],
    connections: Record<string, unknown>[],
  ) {
    const { transport, request, fetchAllPages } = stubTransport({
      fetchAllPages: (endpoint) => (endpoint === 'voucherfileconnections' ? connections : vouchers),
    });
    return { ...createVoucherOperations(transport), request, fetchAllPages };
  }

  it('joins vouchers and connections by series and number and counts them', async () => {
    const { getVoucherAttachmentOverview, request } = setupOverview(
      [
        { VoucherSeries: 'A', VoucherNumber: 1, TransactionDate: '2026-10-01', Description: 'Ett' },
        { VoucherSeries: 'A', VoucherNumber: 2, TransactionDate: '2026-10-02', Description: 'Två' },
        { VoucherSeries: 'B', VoucherNumber: 1, TransactionDate: '2026-10-03', Description: 'Tre' },
      ],
      [
        connection('A', '1', 'kvitto.pdf'),
        connection('A', '1', 'följesedel.pdf'),
        connection('B', '1', 'b1.pdf'),
        connection('C', '9', 'annan-serie.pdf'),
      ],
    );

    const result = await getVoucherAttachmentOverview({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
    });

    expect(result.period).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(result.totalVouchers).toBe(3);
    expect(result.withAttachments).toBe(2);
    expect(result.withoutAttachments).toBe(1);
    expect(result.vouchers).toEqual([
      {
        series: 'A',
        number: '1',
        transactionDate: '2026-10-01',
        description: 'Ett',
        attachmentCount: 2,
        fileNames: ['kvitto.pdf', 'följesedel.pdf'],
      },
      {
        series: 'A',
        number: '2',
        transactionDate: '2026-10-02',
        description: 'Två',
        attachmentCount: 0,
        fileNames: [],
      },
      {
        series: 'B',
        number: '1',
        transactionDate: '2026-10-03',
        description: 'Tre',
        attachmentCount: 1,
        fileNames: ['b1.pdf'],
      },
    ]);
    // Composite over two list calls: no per-voucher HTTP requests.
    expect(request).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('truncated');
  });

  it('lists the vouchers of the period and the connections once, with paging', async () => {
    const { getVoucherAttachmentOverview, fetchAllPages } = setupOverview([], []);

    await getVoucherAttachmentOverview({ fromDate: '2026-10-01', toDate: '2026-10-31' });

    expect(fetchAllPages).toHaveBeenCalledTimes(2);
    expect(fetchAllPages).toHaveBeenNthCalledWith(1, 'vouchers/', 'Vouchers', {
      financialyear: undefined,
      fromdate: '2026-10-01',
      todate: '2026-10-31',
    });
    expect(fetchAllPages).toHaveBeenNthCalledWith(
      2,
      'voucherfileconnections',
      'VoucherFileConnections',
      {
        voucherseries: undefined,
        voucheryear: undefined,
      },
    );
  });

  it('narrows both requests by series and financial year when given', async () => {
    const { getVoucherAttachmentOverview, fetchAllPages } = setupOverview([], []);

    const result = await getVoucherAttachmentOverview({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
      series: 'B',
      financialYear: 4,
    });

    expect(fetchAllPages).toHaveBeenNthCalledWith(1, 'vouchers/sublist/B', 'Vouchers', {
      financialyear: 4,
      fromdate: '2026-10-01',
      todate: '2026-10-31',
    });
    expect(fetchAllPages).toHaveBeenNthCalledWith(
      2,
      'voucherfileconnections',
      'VoucherFileConnections',
      {
        voucherseries: 'B',
        voucheryear: 4,
      },
    );
    expect(result.period).toEqual({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
      series: 'B',
      financialYear: 4,
    });
  });

  it('only matches the voucher year when both sides carry one', async () => {
    const { getVoucherAttachmentOverview } = setupOverview(
      [
        {
          VoucherSeries: 'A',
          VoucherNumber: 1,
          Year: 5,
          TransactionDate: '2026-10-01',
          Description: 'Nytt år',
        },
        {
          VoucherSeries: 'A',
          VoucherNumber: 2,
          TransactionDate: '2026-10-02',
          Description: 'Utan år',
        },
      ],
      [
        connection('A', '1', 'gammalt-ar.pdf', 4),
        connection('A', '1', 'rätt-ar.pdf', 5),
        connection('A', '2', 'utan-ar.pdf', 4),
      ],
    );

    const result = await getVoucherAttachmentOverview({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
    });

    expect(result.vouchers.map((v) => [v.number, v.fileNames])).toEqual([
      ['1', ['rätt-ar.pdf']],
      ['2', ['utan-ar.pdf']],
    ]);
  });

  it('lists only vouchers without attachments with onlyMissing, but counts the whole period', async () => {
    const { getVoucherAttachmentOverview } = setupOverview(
      [
        { VoucherSeries: 'A', VoucherNumber: 1, TransactionDate: '2026-10-01', Description: 'Ett' },
        { VoucherSeries: 'A', VoucherNumber: 2, TransactionDate: '2026-10-02', Description: 'Två' },
        { VoucherSeries: 'A', VoucherNumber: 3, TransactionDate: '2026-10-03', Description: 'Tre' },
      ],
      [connection('A', '2', 'kvitto.pdf')],
    );

    const result = await getVoucherAttachmentOverview({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
      onlyMissing: true,
    });

    expect(result.totalVouchers).toBe(3);
    expect(result.withAttachments).toBe(1);
    expect(result.withoutAttachments).toBe(2);
    expect(result.vouchers.map((v) => v.number)).toEqual(['1', '3']);
    expect(result.vouchers.every((v) => v.attachmentCount === 0)).toBe(true);
  });

  it('caps the returned voucher rows but keeps the counts for the whole period', async () => {
    const vouchers = listItems(600);
    const { getVoucherAttachmentOverview } = setupOverview(vouchers, [
      connection('A', '1', 'a.pdf'),
    ]);

    const result = await getVoucherAttachmentOverview({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });

    expect(result.totalVouchers).toBe(600);
    expect(result.withAttachments).toBe(1);
    expect(result.withoutAttachments).toBe(599);
    expect(result.vouchers).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it.each([
    [{ toDate: '2026-10-31' }, /fromDate/],
    [{ fromDate: '2026-10-01' }, /toDate/],
    [{ fromDate: '2026-02-30', toDate: '2026-10-31' }, /YYYY-MM-DD/],
    [{ fromDate: '2026-10-31', toDate: '2026-10-01' }, /before/],
    [{ fromDate: '2026-10-01', toDate: '2026-10-31', financialYear: -2 }, /financialYear/],
    [{ fromDate: '2026-10-01', toDate: '2026-10-31', series: '../A' }, /Invalid voucher series/],
  ])('rejects invalid input %j before any request', async (params, pattern) => {
    const { getVoucherAttachmentOverview, fetchAllPages } = setupOverview([], []);
    await expect(
      getVoucherAttachmentOverview(params as Parameters<typeof getVoucherAttachmentOverview>[0]),
    ).rejects.toThrow(pattern);
    expect(fetchAllPages).not.toHaveBeenCalled();
  });
});
