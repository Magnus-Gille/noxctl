/**
 * SIE 4 reading and comparison.
 *
 * SIE is the Swedish interchange format for bookkeeping data (sie.se), and it
 * is the only thing every Swedish accounting system agrees on. That makes it
 * the natural oracle when the same fiscal year is kept in two systems in
 * parallel: export both to SIE, compare the closing balances, and any place
 * the two ledgers disagree shows up as a named account with a delta.
 *
 * This module deliberately reads only what a comparison needs — identity,
 * fiscal years, the chart of accounts, IB/UB/RES and the voucher list. It is
 * not a full SIE implementation and does not write SIE.
 */

/** CP437 code points 128-255, in order. SIE calls this encoding "PC8". */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Bytes that spell Swedish letters in CP437 but are control/undefined in latin1. */
const CP437_SWEDISH = new Set([0x81, 0x82, 0x84, 0x86, 0x8e, 0x8f, 0x94, 0x99]);
/** The same letters in latin1. */
const LATIN1_SWEDISH = new Set([0xc4, 0xc5, 0xd6, 0xe4, 0xe5, 0xf6]);

function decodeCp437(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    out += byte < 128 ? String.fromCharCode(byte) : CP437_HIGH[byte - 128];
  }
  return out;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a SIE file to text.
 *
 * The spec says PC8 (CP437), but exporters in the wild also emit latin1 and —
 * increasingly — UTF-8, and the `#FORMAT` line that is supposed to settle it is
 * often missing. So: trust `#FORMAT PC8` when present, otherwise accept valid
 * UTF-8, otherwise decide between CP437 and latin1 by which one makes the
 * high bytes spell Swedish letters.
 */
export function decodeSieText(buf: Buffer): string {
  // #FORMAT is ASCII, so it can be found without knowing the encoding yet.
  if (/#FORMAT\s+PC8/i.test(buf.toString('latin1'))) return decodeCp437(buf);

  const hasHighBytes = buf.some((b) => b >= 128);
  if (!hasHighBytes) return buf.toString('latin1');
  if (isValidUtf8(buf)) return buf.toString('utf8');

  let cp437Hits = 0;
  let latin1Hits = 0;
  for (const byte of buf) {
    if (CP437_SWEDISH.has(byte)) cp437Hits++;
    else if (LATIN1_SWEDISH.has(byte)) latin1Hits++;
  }
  return cp437Hits > latin1Hits ? decodeCp437(buf) : buf.toString('latin1');
}

/**
 * Split one SIE line into fields.
 *
 * Fields are whitespace-separated; `"..."` groups a field that may contain
 * spaces (with `\"` and `\\` escapes), and `{...}` is an object/dimension list
 * whose contents become a single token — empty for the very common `{}`.
 */
export function tokenizeSieLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      let field = '';
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          field += line[i + 1];
          i += 2;
        } else {
          field += line[i];
          i++;
        }
      }
      i++; // closing quote
      tokens.push(field);
      continue;
    }

    if (ch === '{') {
      i++;
      let field = '';
      while (i < line.length && line[i] !== '}') {
        field += line[i];
        i++;
      }
      i++; // closing brace
      tokens.push(field.trim());
      continue;
    }

    let field = '';
    while (i < line.length && !' \t\r'.includes(line[i]!)) {
      field += line[i];
      i++;
    }
    tokens.push(field);
  }

  return tokens;
}

export interface SieTransaction {
  account: string;
  amount: number;
  date?: string;
  text?: string;
}

export interface SieVoucher {
  series?: string;
  number?: string;
  date: string;
  text?: string;
  transactions: SieTransaction[];
  /** True when the transactions sum to zero — the core double-entry invariant. */
  balanced: boolean;
}

export interface SieFiscalYear {
  index: number;
  start: string;
  end: string;
}

export interface SieFile {
  program?: string;
  company?: string;
  orgnr?: string;
  sieType?: number;
  generated?: string;
  fiscalYears: SieFiscalYear[];
  accounts: Map<string, string>;
  /** Opening balances for fiscal year 0. */
  ib: Map<string, number>;
  /** Closing balances for fiscal year 0. */
  ub: Map<string, number>;
  /** Result accounts for fiscal year 0. */
  res: Map<string, number>;
  ibByYear: Map<number, Map<string, number>>;
  ubByYear: Map<number, Map<string, number>>;
  resByYear: Map<number, Map<string, number>>;
  vouchers: SieVoucher[];
}

const BALANCE_TOLERANCE = 0.005;

function parseAmount(raw: string | undefined): number {
  if (raw === undefined) return 0;
  // SIE uses a period as decimal separator, but some exporters emit a comma.
  const value = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
}

function put(
  byYear: Map<number, Map<string, number>>,
  year: number,
  account: string,
  amount: number,
): void {
  let inner = byYear.get(year);
  if (!inner) {
    inner = new Map();
    byYear.set(year, inner);
  }
  // Repeated entries for one account accumulate; SIE splits per dimension.
  inner.set(account, (inner.get(account) ?? 0) + amount);
}

export function parseSie(buf: Buffer): SieFile {
  const text = decodeSieText(buf);
  const ibByYear = new Map<number, Map<string, number>>();
  const ubByYear = new Map<number, Map<string, number>>();
  const resByYear = new Map<number, Map<string, number>>();

  const file: SieFile = {
    fiscalYears: [],
    accounts: new Map(),
    ib: new Map(),
    ub: new Map(),
    res: new Map(),
    ibByYear,
    ubByYear,
    resByYear,
    vouchers: [],
  };

  let current: SieVoucher | undefined;
  let inBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === '{') {
      inBlock = true;
      continue;
    }
    if (line === '}') {
      inBlock = false;
      if (current) {
        const sum = current.transactions.reduce((acc, t) => acc + t.amount, 0);
        current.balanced = Math.abs(sum) < BALANCE_TOLERANCE;
        file.vouchers.push(current);
        current = undefined;
      }
      continue;
    }

    const tokens = tokenizeSieLine(line);
    const label = tokens[0]?.toUpperCase();
    if (!label?.startsWith('#')) continue;

    switch (label) {
      case '#PROGRAM':
        file.program = tokens[1];
        break;
      case '#FNAMN':
        file.company = tokens[1];
        break;
      case '#ORGNR':
        file.orgnr = tokens[1];
        break;
      case '#GEN':
        file.generated = tokens[1];
        break;
      case '#SIETYP':
        file.sieType = Number.parseInt(tokens[1] ?? '', 10) || undefined;
        break;
      case '#RAR':
        if (tokens[2] && tokens[3]) {
          file.fiscalYears.push({
            index: Number.parseInt(tokens[1] ?? '0', 10),
            start: tokens[2],
            end: tokens[3],
          });
        }
        break;
      case '#KONTO':
        if (tokens[1]) file.accounts.set(tokens[1], tokens[2] ?? '');
        break;
      case '#IB':
        if (tokens[2])
          put(ibByYear, Number.parseInt(tokens[1] ?? '0', 10), tokens[2], parseAmount(tokens[3]));
        break;
      case '#UB':
        if (tokens[2])
          put(ubByYear, Number.parseInt(tokens[1] ?? '0', 10), tokens[2], parseAmount(tokens[3]));
        break;
      case '#RES':
        if (tokens[2])
          put(resByYear, Number.parseInt(tokens[1] ?? '0', 10), tokens[2], parseAmount(tokens[3]));
        break;
      case '#VER':
        current = {
          series: tokens[1] || undefined,
          number: tokens[2] || undefined,
          date: tokens[3] ?? '',
          text: tokens[4] || undefined,
          transactions: [],
          balanced: true,
        };
        break;
      case '#TRANS':
        if (inBlock && current && tokens[1]) {
          current.transactions.push({
            account: tokens[1],
            // tokens[2] is the object list, so the amount is tokens[3].
            amount: parseAmount(tokens[3]),
            date: tokens[4],
            text: tokens[5],
          });
        }
        break;
      default:
        // Unknown or uninteresting label — SIE files carry many, and a reader
        // that throws on them is useless against real exports.
        break;
    }
  }

  // A #VER whose block never closed still counts as a voucher.
  if (current) {
    const sum = current.transactions.reduce((acc, t) => acc + t.amount, 0);
    current.balanced = Math.abs(sum) < BALANCE_TOLERANCE;
    file.vouchers.push(current);
  }

  file.ib = ibByYear.get(0) ?? new Map();
  file.ub = ubByYear.get(0) ?? new Map();
  file.res = resByYear.get(0) ?? new Map();
  return file;
}

export interface AccountDelta {
  account: string;
  name: string;
  left: number;
  right: number;
  /** left - right. */
  delta: number;
  /** Set when the account carries a balance in only one of the two files. */
  onlyIn?: 'left' | 'right';
}

export interface SieDiff {
  ub: AccountDelta[];
  res: AccountDelta[];
  voucherCount: { left: number; right: number };
  unbalancedVouchers: { left: number; right: number };
  warnings: string[];
  /** True when the two ledgers agree on every compared figure. */
  clean: boolean;
}

export interface DiffOptions {
  /** Fiscal year index to compare; 0 (the current year) by default. */
  yearIndex?: number;
  /** Absolute amount below which a difference is treated as rounding noise. */
  tolerance?: number;
}

function compareMaps(
  left: Map<string, number>,
  right: Map<string, number>,
  names: Map<string, string>,
  tolerance: number,
): AccountDelta[] {
  const rows: AccountDelta[] = [];
  for (const account of new Set([...left.keys(), ...right.keys()])) {
    const l = left.get(account) ?? 0;
    const r = right.get(account) ?? 0;
    const delta = l - r;
    if (Math.abs(delta) < tolerance) continue;

    const row: AccountDelta = {
      account,
      name: names.get(account) ?? '',
      left: l,
      right: r,
      delta,
    };
    if (!right.has(account)) row.onlyIn = 'left';
    else if (!left.has(account)) row.onlyIn = 'right';
    rows.push(row);
  }
  return rows.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.account.localeCompare(b.account),
  );
}

/**
 * Compare two SIE files — conventionally the incumbent system on the left and
 * the shadow ledger on the right.
 */
export function diffSie(left: SieFile, right: SieFile, options: DiffOptions = {}): SieDiff {
  const year = options.yearIndex ?? 0;
  const tolerance = options.tolerance ?? BALANCE_TOLERANCE;
  const names = new Map([...right.accounts, ...left.accounts]);

  const ub = compareMaps(
    left.ubByYear.get(year) ?? new Map(),
    right.ubByYear.get(year) ?? new Map(),
    names,
    tolerance,
  );
  const res = compareMaps(
    left.resByYear.get(year) ?? new Map(),
    right.resByYear.get(year) ?? new Map(),
    names,
    tolerance,
  );

  const warnings: string[] = [];
  if (left.orgnr && right.orgnr && left.orgnr !== right.orgnr) {
    warnings.push(`Organisationsnummer skiljer sig: ${left.orgnr} vs ${right.orgnr}`);
  }
  const leftYear = left.fiscalYears.find((y) => y.index === year);
  const rightYear = right.fiscalYears.find((y) => y.index === year);
  if (
    leftYear &&
    rightYear &&
    (leftYear.start !== rightYear.start || leftYear.end !== rightYear.end)
  ) {
    warnings.push(
      `Räkenskapsåret skiljer sig: ${leftYear.start}-${leftYear.end} vs ${rightYear.start}-${rightYear.end}`,
    );
  }

  const unbalancedVouchers = {
    left: left.vouchers.filter((v) => !v.balanced).length,
    right: right.vouchers.filter((v) => !v.balanced).length,
  };
  const voucherCount = { left: left.vouchers.length, right: right.vouchers.length };

  return {
    ub,
    res,
    voucherCount,
    unbalancedVouchers,
    warnings,
    clean:
      ub.length === 0 &&
      res.length === 0 &&
      voucherCount.left === voucherCount.right &&
      unbalancedVouchers.left === 0 &&
      unbalancedVouchers.right === 0,
  };
}
