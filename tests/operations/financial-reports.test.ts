import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFinancialReportOperations } from '../../src/operations/financial-reports.js';

// One SIE 4 export covers the whole report: #KONTO for names, #IB for opening
// balances and #VER/#TRANS for the movements. Voucher A3 lies after the
// balance-sheet cut-off used below, so it proves local date filtering too.
const SAMPLE_SIE = [
  '#FORMAT PC8',
  '#SIETYP 4',
  '#RAR 0 20260101 20261231',
  '#RAR -1 20250101 20251231',
  '#KONTO 1930 "Bank"',
  '#KONTO 2081 "Aktiekapital"',
  '#KONTO 2440 "Leverant\x94rsskulder"',
  '#KONTO 3001 "F\x94rs\x84ljning"',
  '#KONTO 5410 "F\x94rbrukningsinventarier"',
  '#KONTO 6570 "Bankkostnader"',
  '#IB -1 1930 999.00',
  '#IB 0 1930 100000.00',
  '#IB 0 2081 -25000.00',
  '#IB 0 2440 -75000.00',
  '#UB 0 1930 148500.00',
  '#VER A 1 20260115 "Sale" 20260115',
  '{',
  '#TRANS 3001 {} -50000.00',
  '#TRANS 1930 {} 50000.00',
  '}',
  '#VER A 2 20260320 "Purchases" 20260320',
  '{',
  '#BTRANS 5410 {} 10000.00',
  '#TRANS 5410 {} 3000.00',
  '#TRANS 6570 {} 500.00',
  '#TRANS 1930 {} -3500.00',
  '}',
  '#VER A 3 20260701 "Later sale" 20260701',
  '{',
  '#TRANS 3001 {} -2000.00',
  '#TRANS 1930 {} 2000.00',
  '}',
].join('\r\n');

const YEARS = {
  FinancialYears: [
    { Id: 3, FromDate: '2025-01-01', ToDate: '2025-12-31' },
    { Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' },
  ],
};

function stubTransport(): FortnoxTransport {
  return {
    request: vi.fn().mockImplementation(async (endpoint: string) => {
      if (endpoint === 'financialyears') return YEARS;
      throw new Error(`unexpected request to ${endpoint}`);
    }),
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn(),
    requestPdfFromMutation: vi.fn(),
    requestFile: vi.fn().mockResolvedValue({
      buffer: Buffer.from(SAMPLE_SIE, 'latin1'),
      contentType: 'application/octet-stream',
    }),
    fetchAllPages: vi.fn(),
  } as FortnoxTransport;
}

describe('financial reports operations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getIncomeStatement', () => {
    it('builds the report from a single SIE export without per-voucher requests', async () => {
      const transport = stubTransport();
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      const report = await getIncomeStatement({ fromDate: '2026-01-01', toDate: '2026-11-18' });

      expect(transport.requestFile).toHaveBeenCalledTimes(1);
      expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
        params: { fromdate: '2026-01-01', todate: '2026-11-18', financialyear: 4 },
      });
      // Only the financial-year lookup goes through the JSON API.
      expect(vi.mocked(transport.request).mock.calls.map((c) => c[0])).toEqual(['financialyears']);

      expect(report.type).toBe('income-statement');
      expect(report.period).toEqual({ from: '2026-01-01', to: '2026-11-18' });
      expect(report.sections.map((s) => s.label)).toEqual([
        expect.stringContaining('Nettoomsättning'),
        expect.stringContaining('Övriga externa kostnader'),
      ]);
      expect(report.sections[0]!.total).toBe(-52000); // Credit = negative in BAS
      expect(report.sections[0]!.lines[0]).toEqual({
        account: 3001,
        description: 'Försäljning',
        balance: -52000,
      });
      expect(report.sections[1]!.total).toBe(3500); // #BTRANS (removed row) ignored
      expect(report.netResult).toBe(-48500); // Negative = profit in BAS
    });

    it('only counts vouchers inside the requested period', async () => {
      const transport = stubTransport();
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      const report = await getIncomeStatement({ fromDate: '2026-02-01', toDate: '2026-06-30' });

      expect(report.sections).toHaveLength(1);
      expect(report.netResult).toBe(3500);
    });

    it('uses the explicit financial year and its own boundaries', async () => {
      const transport = stubTransport();
      vi.mocked(transport.requestFile).mockResolvedValue({
        buffer: Buffer.from('#FORMAT PC8\r\n#SIETYP 4\r\n', 'latin1'),
        contentType: 'application/octet-stream',
      });
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      const report = await getIncomeStatement({ financialYear: 3 });

      expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
        params: { fromdate: '2025-01-01', todate: '2025-12-31', financialyear: 3 },
      });
      expect(report.financialYear).toBe(3);
      expect(report.sections).toHaveLength(0);
      expect(report.netResult).toBe(0);
    });

    it("defaults to the financial year containing today's date", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 7, 1, 12));
      const transport = stubTransport();
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      await getIncomeStatement();

      expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
        params: { fromdate: '2026-01-01', todate: '2026-12-31', financialyear: 4 },
      });
    });

    it('fails clearly when no financial year covers the date', async () => {
      const transport = stubTransport();
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      await expect(getIncomeStatement({ fromDate: '2030-01-01' })).rejects.toThrow(
        /No financial year found covering 2030-01-01/,
      );
      expect(transport.requestFile).not.toHaveBeenCalled();
    });

    it('fails clearly when the explicit financial year does not exist', async () => {
      const transport = stubTransport();
      const { getIncomeStatement } = createFinancialReportOperations(transport);

      await expect(getIncomeStatement({ financialYear: 99 })).rejects.toThrow(
        /Financial year 99 not found/,
      );
      expect(transport.requestFile).not.toHaveBeenCalled();
    });
  });

  describe('getBalanceSheet', () => {
    it('adds opening balances to movements up to the as-of date', async () => {
      const transport = stubTransport();
      const { getBalanceSheet } = createFinancialReportOperations(transport);

      const report = await getBalanceSheet({ toDate: '2026-03-31' });

      expect(transport.requestFile).toHaveBeenCalledTimes(1);
      expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
        params: { fromdate: '2026-01-01', todate: '2026-03-31', financialyear: 4 },
      });
      expect(report.type).toBe('balance-sheet');
      expect(report.asOfDate).toBe('2026-03-31');
      expect(report.assets).toHaveLength(1); // Cash and bank
      // 100000 IB + 50000 - 3500; voucher A3 (July) and the prior-year IB excluded
      expect(report.assets[0]!.lines[0]).toEqual({
        account: 1930,
        description: 'Bank',
        balance: 146500,
      });
      expect(report.totalAssets).toBe(146500);
      expect(report.liabilitiesAndEquity.map((s) => s.total)).toEqual([-25000, -75000]);
      expect(report.liabilitiesAndEquity[1]!.lines[0]!.description).toBe('Leverantörsskulder');
    });

    it('groups receivables by BAS: 15xx kundfordringar, 16xx övriga fordringar (NOX-226)', async () => {
      const transport = stubTransport();
      vi.mocked(transport.requestFile).mockResolvedValue({
        buffer: Buffer.from(
          [
            '#FORMAT PC8',
            '#SIETYP 4',
            '#RAR 0 20260101 20261231',
            '#KONTO 1510 "Kundfordringar"',
            '#KONTO 1630 "Skattekonto"',
            '#KONTO 1790 "F\x94rutbetalda kostnader"',
            '#IB 0 1510 1000.00',
            '#IB 0 1630 200.00',
            '#IB 0 1790 30.00',
          ].join('\r\n'),
          'latin1',
        ),
        contentType: 'application/octet-stream',
      });
      const { getBalanceSheet } = createFinancialReportOperations(transport);

      const report = await getBalanceSheet({ financialYear: 4 });
      const sectionFor = (account: number) =>
        report.assets.find((s) => s.lines.some((l) => l.account === account))!.label;

      expect(sectionFor(1510)).toMatch(/^Kundfordringar/);
      expect(sectionFor(1630)).toMatch(/^Övriga kortfristiga fordringar/);
      expect(sectionFor(1790)).toMatch(/^Förutbetalda kostnader och upplupna intäkter/);
    });

    it('covers the whole financial year when no as-of date is given', async () => {
      const transport = stubTransport();
      const { getBalanceSheet } = createFinancialReportOperations(transport);

      const report = await getBalanceSheet({ financialYear: 4 });

      expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
        params: { fromdate: '2026-01-01', todate: '2026-12-31', financialyear: 4 },
      });
      expect(report.totalAssets).toBe(148500);
    });
  });
});
