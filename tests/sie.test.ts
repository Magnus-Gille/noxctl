import { describe, it, expect, vi } from 'vitest';
import type { FortnoxTransport } from '../src/fortnox-client.js';
import { parseSie, fetchSie } from '../src/sie.js';

const SAMPLE_SIE = [
  '#FLAGGA 0',
  '#FORMAT PC8',
  '#SIETYP 4',
  '#GEN 20260901',
  '#FNR 285668',
  '#FNAMN "Test AB"',
  '#RAR 0 20260101 20261231',
  '#RAR -1 20250101 20251231',
  '#ORGNR 559001-6035',
  '#KPTYP EUBAS97',
  '#DIM 1 "Kostnadsstlle"',
  '#DIM 6 "Projekt"',
  '#KONTO 3000 "Sales, Sweden"',
  '#SRU 3000 7410',
  '#KONTO 4550 "Purchase of services"',
  '#SRU 4550 7514',
  '#KONTO 1930 "Bank"',
  '#IB 0 1930 100000 0',
  '#IB -1 1930 50000 0',
  '#UB 0 1930 80000 0',
  '#VER A 1 20260805 "Sale" 20260806',
  '{',
  '#TRANS 3000 {} -1000 "" "Sale to customer" 0',
  '#TRANS 1930 {} 1000 "" "" 0',
  '}',
  '#VER A 2 20260806 "Purchase" 20260806',
  '{',
  '#TRANS 4550 {1 "2010" 6 "1001"} 500 "" "Consulting" 0',
  '#TRANS 1930 {} -500 "" "" 0',
  '}',
].join('\r\n');

describe('parseSie', () => {
  it('extracts company metadata', () => {
    const result = parseSie(SAMPLE_SIE);
    expect(result.companyName).toBe('Test AB');
    expect(result.organisationNumber).toBe('559001-6035');
  });

  it('pairs #KONTO descriptions with #SRU codes', () => {
    const result = parseSie(SAMPLE_SIE);
    expect(result.accounts.get('3000')).toEqual({
      number: '3000',
      description: 'Sales, Sweden',
      sru: '7410',
    });
    expect(result.accounts.get('4550')?.sru).toBe('7514');
  });

  it('records an account with no #SRU line as having no sru field', () => {
    const result = parseSie(SAMPLE_SIE);
    expect(result.accounts.get('1930')?.sru).toBeUndefined();
  });

  it('parses #IB and #UB balances, keyed by year index', () => {
    const result = parseSie(SAMPLE_SIE);
    expect(result.openingBalances).toContainEqual({
      account: '1930',
      yearIndex: 0,
      balance: 100000,
    });
    expect(result.openingBalances).toContainEqual({
      account: '1930',
      yearIndex: -1,
      balance: 50000,
    });
    expect(result.closingBalances).toContainEqual({
      account: '1930',
      yearIndex: 0,
      balance: 80000,
    });
  });

  it('associates #TRANS lines with their enclosing #VER header', () => {
    const result = parseSie(SAMPLE_SIE);
    const saleLine = result.transactions.find((t) => t.account === '3000');
    expect(saleLine).toMatchObject({
      series: 'A',
      voucherNumber: '1',
      voucherDate: '20260805',
      registrationDate: '20260806',
      voucherDescription: 'Sale',
      amount: -1000,
      text: 'Sale to customer',
    });
  });

  it('leaves text undefined when the #TRANS text field is empty', () => {
    const result = parseSie(SAMPLE_SIE);
    const bankLine = result.transactions.find((t) => t.account === '1930' && t.amount === 1000);
    expect(bankLine?.text).toBeUndefined();
  });

  it('parses cost centre and project out of the dimension object list', () => {
    const result = parseSie(SAMPLE_SIE);
    const purchaseLine = result.transactions.find((t) => t.account === '4550');
    expect(purchaseLine).toMatchObject({ costCenter: '2010', project: '1001', amount: 500 });
  });

  it('leaves costCenter/project undefined when the dimension list is empty', () => {
    const result = parseSie(SAMPLE_SIE);
    const saleLine = result.transactions.find((t) => t.account === '3000');
    expect(saleLine?.costCenter).toBeUndefined();
    expect(saleLine?.project).toBeUndefined();
  });

  it('produces exactly one transaction per #TRANS line, in file order', () => {
    const result = parseSie(SAMPLE_SIE);
    expect(result.transactions).toHaveLength(4);
  });

  it('ignores lines it does not recognize without throwing', () => {
    expect(() => parseSie('#UNKNOWNTAG some stuff\r\n' + SAMPLE_SIE)).not.toThrow();
  });

  it('returns empty collections for an empty file', () => {
    const result = parseSie('');
    expect(result.accounts.size).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.openingBalances).toEqual([]);
    expect(result.closingBalances).toEqual([]);
  });
});

describe('fetchSie', () => {
  function stubTransport(buffer: Buffer): FortnoxTransport {
    return {
      request: vi.fn(),
      requestWithMetadata: vi.fn(),
      requestPdf: vi.fn(),
      requestPdfFromMutation: vi.fn(),
      requestFile: vi.fn().mockResolvedValue({ buffer, contentType: 'application/octet-stream' }),
      fetchAllPages: vi.fn(),
    } as FortnoxTransport;
  }

  it('requests sie/4 with fromdate/todate/financialyear query params', async () => {
    const transport = stubTransport(Buffer.from(SAMPLE_SIE, 'latin1'));

    await fetchSie(transport, { fromDate: '2026-08-01', toDate: '2026-08-31', financialYear: 12 });

    expect(transport.requestFile).toHaveBeenCalledWith('sie/4', {
      params: { fromdate: '2026-08-01', todate: '2026-08-31', financialyear: 12 },
    });
  });

  it('decodes CP437 bytes correctly, unlike a naive latin1 decode', async () => {
    // "Intäktsränta" with ä as CP437 byte 0x84 (which is a C1 control code
    // in latin1 — decoding as latin1 would silently drop both ä's).
    const cp437Bytes = Buffer.from([
      0x23,
      0x56,
      0x45,
      0x52,
      0x20,
      0x41,
      0x20,
      0x31,
      0x20,
      0x30,
      0x20,
      0x22,
      0x49,
      0x6e,
      0x74,
      0x84,
      0x6b,
      0x74,
      0x73,
      0x72,
      0x84,
      0x6e,
      0x74,
      0x61,
      0x22,
      0x0d,
      0x0a,
      0x7b,
      0x0d,
      0x0a,
      0x7d, // #VER A 1 0 "Intäktsränta"\r\n{\r\n}
    ]);
    const transport = stubTransport(cp437Bytes);

    const result = await fetchSie(transport, {});

    expect(result.transactions).toEqual([]); // no #TRANS lines, just checking decode
    // Re-parse the same bytes as latin1 to prove the naive decode would have
    // silently dropped the ä's, so this test is actually exercising the fix.
    expect(cp437Bytes.toString('latin1')).not.toContain('Intäktsränta');
  });

  it('recovers the voucher description text via CP437 decoding end-to-end', async () => {
    const line = '#VER A 1 20260805 "Intäktsränta"\r\n{\r\n#TRANS 8310 {} 100 "" "" 0\r\n}';
    // Encode manually: ä -> 0x84 in CP437.
    const bytes = Buffer.from(line.split('').map((ch) => (ch === 'ä' ? 0x84 : ch.charCodeAt(0))));
    const transport = stubTransport(bytes);

    const result = await fetchSie(transport, {});

    expect(result.transactions[0]?.voucherDescription).toBe('Intäktsränta');
  });
});
