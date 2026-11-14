import { InvalidArgumentError } from 'commander';

/** Commander passes the previous option value as its second parser argument. */
export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive safe integer.');
  }
  return parsed;
}

/** Parse a `<series>/<number>` voucher reference such as `A/12` (series are letters/digits, numbers digits). */
export function parseVoucherReference(value: string): { series: string; number: string } {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,9})\/(\d+)$/.exec(value);
  if (!match) {
    throw new InvalidArgumentError(
      `"${value}" is not a voucher reference. Expected <series>/<number>, for example A/12.`,
    );
  }
  return { series: match[1]!, number: match[2]! };
}
