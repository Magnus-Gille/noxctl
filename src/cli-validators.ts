import { InvalidArgumentError } from 'commander';

/** Commander passes the previous option value as its second parser argument. */
export function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive safe integer.');
  }
  return parsed;
}
