import { describe, it, expect } from 'vitest';
import { parseSie, diffSie, decodeSieText, tokenizeSieLine } from '../src/sie.js';

/** Build a CP437-encoded SIE buffer from a string using å=0x86 ä=0x84 ö=0x94 Ä=0x8E Å=0x8F Ö=0x99. */
function cp437(text: string): Buffer {
  const map: Record<string, number> = {
    å: 0x86,
    ä: 0x84,
    ö: 0x94,
    Å: 0x8f,
    Ä: 0x8e,
    Ö: 0x99,
    é: 0x82,
    ü: 0x81,
  };
  const bytes: number[] = [];
  for (const ch of text) {
    const mapped = map[ch];
    if (mapped !== undefined) bytes.push(mapped);
    else if (ch.charCodeAt(0) < 128) bytes.push(ch.charCodeAt(0));
    else throw new Error(`test helper cannot encode ${ch}`);
  }
  return Buffer.from(bytes);
}

const FORTNOX_SIE = [
  '#FLAGGA 0',
  '#PROGRAM "Fortnox" "3.0"',
  '#FORMAT PC8',
  '#GEN 20260818',
  '#SIETYP 4',
  '#ORGNR 5595241323',
  '#FNAMN "Magnus Gille Consulting AB"',
  '#RAR 0 20260101 20261231',
  '#RAR -1 20250101 20251231',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2610 "Utgående moms"',
  '#KONTO 3011 "Försäljning tjänster"',
  '#IB 0 1930 100000.00',
  '#UB 0 1930 156250.00',
  '#UB 0 2610 -14062.50',
  '#RES 0 3011 -56250.00',
  '#VER "A" "1" 20260720 "TRATON Financial" 20260720',
  '{',
  '   #TRANS 1930 {} 56250.00 20260720 "Inbetalning"',
  '   #TRANS 3011 {} -45000.00 20260720 "Försäljning"',
  '   #TRANS 2610 {} -11250.00 20260720 "Moms"',
  '}',
].join('\r\n');

describe('decodeSieText', () => {
  it('decodes CP437 Swedish characters', () => {
    expect(decodeSieText(cp437('Företagskonto åäöÅÄÖ'))).toBe('Företagskonto åäöÅÄÖ');
  });

  it('falls back to latin1 when #FORMAT is absent and bytes are not CP437-plausible', () => {
    // 0xE5 is 'å' in latin1 but a box-drawing glyph in CP437.
    const latin1 = Buffer.from([0x23, 0x46, 0x4e, 0x41, 0x4d, 0x4e, 0x20, 0xe5]);
    expect(decodeSieText(latin1)).toContain('å');
  });
});

describe('tokenizeSieLine', () => {
  it('splits unquoted fields on whitespace', () => {
    expect(tokenizeSieLine('#UB 0 1930 156250.00')).toEqual(['#UB', '0', '1930', '156250.00']);
  });

  it('keeps quoted fields intact including spaces', () => {
    expect(tokenizeSieLine('#FNAMN "Magnus Gille Consulting AB"')).toEqual([
      '#FNAMN',
      'Magnus Gille Consulting AB',
    ]);
  });

  it('handles escaped quotes inside a quoted field', () => {
    expect(tokenizeSieLine('#KONTO 1930 "Konto \\"A\\""')).toEqual(['#KONTO', '1930', 'Konto "A"']);
  });

  it('emits an empty token for an empty object list', () => {
    expect(tokenizeSieLine('#TRANS 1930 {} 56250.00')).toEqual(['#TRANS', '1930', '', '56250.00']);
  });
});

describe('parseSie', () => {
  const sie = parseSie(cp437(FORTNOX_SIE));

  it('reads company identity', () => {
    expect(sie.company).toBe('Magnus Gille Consulting AB');
    expect(sie.orgnr).toBe('5595241323');
    expect(sie.program).toBe('Fortnox');
    expect(sie.sieType).toBe(4);
  });

  it('reads fiscal years', () => {
    expect(sie.fiscalYears).toEqual([
      { index: 0, start: '20260101', end: '20261231' },
      { index: -1, start: '20250101', end: '20251231' },
    ]);
  });

  it('reads the chart of accounts with decoded names', () => {
    expect(sie.accounts.get('1930')).toBe('Företagskonto');
    expect(sie.accounts.get('3011')).toBe('Försäljning tjänster');
  });

  it('reads opening balances, closing balances and results for year 0', () => {
    expect(sie.ib.get('1930')).toBeCloseTo(100000.0, 2);
    expect(sie.ub.get('1930')).toBeCloseTo(156250.0, 2);
    expect(sie.ub.get('2610')).toBeCloseTo(-14062.5, 2);
    expect(sie.res.get('3011')).toBeCloseTo(-56250.0, 2);
  });

  it('parses vouchers with their transactions', () => {
    expect(sie.vouchers).toHaveLength(1);
    const ver = sie.vouchers[0]!;
    expect(ver.series).toBe('A');
    expect(ver.number).toBe('1');
    expect(ver.date).toBe('20260720');
    expect(ver.text).toBe('TRATON Financial');
    expect(ver.transactions).toHaveLength(3);
    expect(ver.transactions[0]).toMatchObject({ account: '1930', amount: 56250.0 });
    expect(ver.transactions[2]).toMatchObject({ account: '2610', amount: -11250.0 });
  });

  it('reports each voucher as balanced when its transactions sum to zero', () => {
    expect(sie.vouchers[0]!.balanced).toBe(true);
  });

  it('flags an unbalanced voucher', () => {
    const bad = parseSie(
      Buffer.from(
        [
          '#VER "A" "2" 20260721 "Skev"',
          '{',
          '#TRANS 1930 {} 100.00',
          '#TRANS 3011 {} -90.00',
          '}',
        ].join('\n'),
      ),
    );
    expect(bad.vouchers[0]!.balanced).toBe(false);
  });

  it('ignores comment and unknown labels without throwing', () => {
    const sie2 = parseSie(Buffer.from(['#OKÄNT foo bar', '#UB 0 1930 5.00'].join('\n')));
    expect(sie2.ub.get('1930')).toBeCloseTo(5.0, 2);
  });
});

describe('diffSie', () => {
  const fortnox = parseSie(cp437(FORTNOX_SIE));

  it('reports no differences against itself', () => {
    const d = diffSie(fortnox, parseSie(cp437(FORTNOX_SIE)));
    expect(d.ub).toEqual([]);
    expect(d.res).toEqual([]);
    expect(d.clean).toBe(true);
  });

  it('detects a closing-balance difference and names the account', () => {
    const shadow = parseSie(
      cp437(FORTNOX_SIE.replace('#UB 0 1930 156250.00', '#UB 0 1930 150000.00')),
    );
    const d = diffSie(fortnox, shadow);
    expect(d.clean).toBe(false);
    expect(d.ub).toHaveLength(1);
    expect(d.ub[0]).toMatchObject({ account: '1930', name: 'Företagskonto' });
    expect(d.ub[0]!.left).toBeCloseTo(156250.0, 2);
    expect(d.ub[0]!.right).toBeCloseTo(150000.0, 2);
    expect(d.ub[0]!.delta).toBeCloseTo(6250.0, 2);
  });

  it('detects a result difference', () => {
    const shadow = parseSie(
      cp437(FORTNOX_SIE.replace('#RES 0 3011 -56250.00', '#RES 0 3011 -56000.00')),
    );
    const d = diffSie(fortnox, shadow);
    expect(d.res).toHaveLength(1);
    expect(d.res[0]).toMatchObject({ account: '3011' });
    expect(d.res[0]!.delta).toBeCloseTo(-250.0, 2);
  });

  it('treats an account missing on one side as a zero balance', () => {
    const shadow = parseSie(cp437(FORTNOX_SIE.replace('#UB 0 2610 -14062.50\r\n', '')));
    const d = diffSie(fortnox, shadow);
    const row = d.ub.find((r) => r.account === '2610');
    expect(row).toBeDefined();
    expect(row!.right).toBe(0);
    expect(row!.onlyIn).toBe('left');
  });

  it('ignores rounding noise below the tolerance', () => {
    const shadow = parseSie(
      cp437(FORTNOX_SIE.replace('#UB 0 1930 156250.00', '#UB 0 1930 156250.004')),
    );
    expect(diffSie(fortnox, shadow).ub).toEqual([]);
  });

  it('compares voucher counts', () => {
    const shadow = parseSie(cp437(FORTNOX_SIE + '\r\n#VER "A" "2" 20260721 "Extra"\r\n{\r\n}'));
    const d = diffSie(fortnox, shadow);
    expect(d.voucherCount).toEqual({ left: 1, right: 2 });
    expect(d.clean).toBe(false);
  });

  it('sorts differences by absolute size, largest first', () => {
    const shadow = parseSie(
      cp437(
        FORTNOX_SIE.replace('#UB 0 1930 156250.00', '#UB 0 1930 155000.00').replace(
          '#UB 0 2610 -14062.50',
          '#UB 0 2610 -9062.50',
        ),
      ),
    );
    const d = diffSie(fortnox, shadow);
    expect(d.ub.map((r) => r.account)).toEqual(['2610', '1930']);
  });

  it('warns when the two files describe different organisations', () => {
    const other = parseSie(cp437(FORTNOX_SIE.replace('5595241323', '5560000001')));
    expect(diffSie(fortnox, other).warnings).toContain(
      'Organisationsnummer skiljer sig: 5595241323 vs 5560000001',
    );
  });
});
