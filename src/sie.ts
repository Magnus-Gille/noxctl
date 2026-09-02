import type { FortnoxTransport } from './fortnox-client.js';

// Fortnox has no public REST endpoint for period-scoped account totals — the
// obvious path (list vouchers, fetch each one's rows, sum debit/credit) means
// one HTTP request per voucher, which times out on any real company (#152).
// GET /3/sie/4 is a separate, undocumented-by-omission endpoint: it returns
// the whole period's chart of accounts, opening/closing balances and every
// transaction line in one streamed file, in the standard Swedish SIE format.
// Parsing that file is the fast path for anything that needs bulk voucher/
// account data — voucher lists, P&L, balance sheet.
//
// SIE is a line-oriented text format (Swedish "SIE 4" standard); every
// meaningful line starts with a `#TAG`. We only parse the tags this codebase
// needs — #KONTO/#SRU (chart of accounts + official tax-authority grouping
// code), #IB/#UB (opening/closing balance per account), and #VER/#TRANS
// (voucher headers and their transaction lines). Anything else is ignored.

export interface SieAccount {
  number: string;
  description: string;
  /** Skatteverket's "Standardiserat räkenskapsutdrag" code — the official
   * grouping used for annual-report line items (Nettoomsättning, Övriga
   * externa kostnader, etc.). Absent for accounts with no SRU mapping. */
  sru?: string;
}

export interface SieTransaction {
  series: string;
  voucherNumber: string;
  /** Voucher transaction date (#VER's own date, not the per-row #TRANS date
   * override — Fortnox's export does not appear to set the latter). */
  voucherDate: string;
  /** Registration date, when present — the 5th #VER field. */
  registrationDate?: string;
  voucherDescription: string;
  account: string;
  /** Signed: positive = debit, negative = credit. */
  amount: number;
  costCenter?: string;
  project?: string;
  /** Per-row free text, when present (falls back to the voucher description
   * when the caller wants a single label). */
  text?: string;
}

export interface SieBalance {
  account: string;
  /** 0 = current financial year, -1 = the one before it, per #RAR. */
  yearIndex: number;
  balance: number;
}

export interface ParsedSie {
  companyName?: string;
  organisationNumber?: string;
  accounts: Map<string, SieAccount>;
  transactions: SieTransaction[];
  openingBalances: SieBalance[];
  closingBalances: SieBalance[];
}

// SIE lines are whitespace-separated tokens where a `"..."` run is one token
// (with the quotes stripped) and a `{...}` run is one token (kept with its
// braces, for the caller to parse separately — it's a nested object list,
// e.g. `{1 "2010" 6 "1001"}` for cost-centre + project dimensions).
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      let j = i + 1;
      let value = '';
      while (j < line.length && line[j] !== '"') {
        value += line[j];
        j++;
      }
      tokens.push(value);
      i = j + 1;
    } else if (line[i] === '{') {
      let j = i + 1;
      while (j < line.length && line[j] !== '}') j++;
      tokens.push(line.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && !/\s/.test(line[j]!)) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

// `{1 "2010" 6 "1001"}` -> { costCenter: '2010', project: '1001' }. Dimension
// 1 is always cost centre and 6 always project in Fortnox's SIE export (see
// the #DIM lines at the top of the file); other dimension numbers exist in
// the SIE standard but Fortnox does not emit them, so they're ignored.
function parseDimensions(raw: string): { costCenter?: string; project?: string } {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return {};
  const parts = tokenize(inner);
  const result: { costCenter?: string; project?: string } = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '1') result.costCenter = parts[i + 1];
    else if (parts[i] === '6') result.project = parts[i + 1];
  }
  return result;
}

export function parseSie(text: string): ParsedSie {
  const accounts = new Map<string, SieAccount>();
  const transactions: SieTransaction[] = [];
  const openingBalances: SieBalance[] = [];
  const closingBalances: SieBalance[] = [];
  let companyName: string | undefined;
  let organisationNumber: string | undefined;

  let currentVoucher:
    | { series: string; number: string; date: string; regDate?: string; description: string }
    | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('#')) continue;
    const tag = line.slice(1, line.indexOf(' ') === -1 ? undefined : line.indexOf(' '));

    if (tag === 'FNAMN') {
      companyName = tokenize(line)[1];
    } else if (tag === 'ORGNR') {
      organisationNumber = tokenize(line)[1];
    } else if (tag === 'KONTO') {
      const [, number, description] = tokenize(line);
      if (number) accounts.set(number, { number, description: description ?? '' });
    } else if (tag === 'SRU') {
      const [, number, sru] = tokenize(line);
      if (number) {
        const existing = accounts.get(number);
        if (existing) existing.sru = sru;
        else accounts.set(number, { number, description: '', sru });
      }
    } else if (tag === 'IB' || tag === 'UB') {
      const [, yearIndex, account, balance] = tokenize(line);
      if (account && balance !== undefined) {
        const entry: SieBalance = {
          account,
          yearIndex: Number(yearIndex),
          balance: Number(balance),
        };
        (tag === 'IB' ? openingBalances : closingBalances).push(entry);
      }
    } else if (tag === 'VER') {
      const [, series, number, date, description, regDate] = tokenize(line);
      if (series && number) {
        currentVoucher = {
          series,
          number,
          date: date ?? '',
          regDate,
          description: description ?? '',
        };
      }
    } else if (tag === 'TRANS') {
      const tokens = tokenize(line);
      const [, account, dims, amount, , text] = tokens;
      if (account && amount !== undefined && currentVoucher) {
        const { costCenter, project } = dims ? parseDimensions(dims) : {};
        transactions.push({
          series: currentVoucher.series,
          voucherNumber: currentVoucher.number,
          voucherDate: currentVoucher.date,
          registrationDate: currentVoucher.regDate,
          voucherDescription: currentVoucher.description,
          account,
          amount: Number(amount),
          costCenter,
          project,
          text: text || undefined,
        });
      }
    }
  }

  return {
    companyName,
    organisationNumber,
    accounts,
    transactions,
    openingBalances,
    closingBalances,
  };
}

// SIE declares its own encoding via `#FORMAT PC8` — IBM code page 437, not
// UTF-8 or Latin-1. Decoding as Latin-1 silently eats every å/ä/ö: CP437's
// byte for `ä` (0x84) falls in Latin-1's C1-control range, so it renders as
// nothing rather than the wrong character — e.g. "Intäktsränta" becomes
// "Intktsrnta". Bytes 0x00-0x7F are plain ASCII in both encodings; only the
// upper half needs remapping.
const CP437_UPPER = [
  'Ç',
  'ü',
  'é',
  'â',
  'ä',
  'à',
  'å',
  'ç',
  'ê',
  'ë',
  'è',
  'ï',
  'î',
  'ì',
  'Ä',
  'Å',
  'É',
  'æ',
  'Æ',
  'ô',
  'ö',
  'ò',
  'û',
  'ù',
  'ÿ',
  'Ö',
  'Ü',
  '¢',
  '£',
  '¥',
  '₧',
  'ƒ',
  'á',
  'í',
  'ó',
  'ú',
  'ñ',
  'Ñ',
  'ª',
  'º',
  '¿',
  '⌐',
  '¬',
  '½',
  '¼',
  '¡',
  '«',
  '»',
  '░',
  '▒',
  '▓',
  '│',
  '┤',
  '╡',
  '╢',
  '╖',
  '╕',
  '╣',
  '║',
  '╗',
  '╝',
  '╜',
  '╛',
  '┐',
  '└',
  '┴',
  '┬',
  '├',
  '─',
  '┼',
  '╞',
  '╟',
  '╚',
  '╔',
  '╩',
  '╦',
  '╠',
  '═',
  '╬',
  '╧',
  '╨',
  '╤',
  '╥',
  '╙',
  '╘',
  '╒',
  '╓',
  '╫',
  '╪',
  '┘',
  '┌',
  '█',
  '▄',
  '▌',
  '▐',
  '▀',
  'α',
  'ß',
  'Γ',
  'π',
  'Σ',
  'σ',
  'µ',
  'τ',
  'Φ',
  'Θ',
  'Ω',
  'δ',
  '∞',
  'φ',
  'ε',
  '∩',
  '≡',
  '±',
  '≥',
  '≤',
  '⌠',
  '⌡',
  '÷',
  '≈',
  '°',
  '∙',
  '·',
  '√',
  'ⁿ',
  '²',
  '■',
  ' ',
];

function decodeCp437(buffer: Buffer): string {
  let out = '';
  for (const byte of buffer) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP437_UPPER[byte - 0x80];
  }
  return out;
}

export interface FetchSieParams {
  fromDate?: string;
  toDate?: string;
  financialYear?: number;
}

/** Fetch and parse the SIE4 (full transaction detail) export for a period. */
export async function fetchSie(
  transport: FortnoxTransport,
  params: FetchSieParams = {},
): Promise<ParsedSie> {
  const { buffer } = await transport.requestFile('sie/4', {
    params: {
      fromdate: params.fromDate,
      todate: params.toDate,
      financialyear: params.financialYear,
    },
  });
  return parseSie(decodeCp437(buffer));
}
