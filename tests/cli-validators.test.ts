import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { parsePositiveInteger, parseVoucherReference } from '../src/cli-validators.js';

describe('positive integer CLI option', () => {
  it.each(['abc', '', '0', '-1', '4.5', '12abc', '1e2', '0x10', '9007199254740992'])(
    'rejects %s',
    (value) => {
      expect(() => parsePositiveInteger(value)).toThrow(/positive safe integer/i);
    },
  );
  it('uses decimal parsing when Commander passes the previous option value', () => {
    const command = new Command().option('--year <number>', 'Financial year', parsePositiveInteger);
    command.parse(['--year', '12', '--year', '12'], { from: 'user' });
    expect(command.opts().year).toBe(12);
  });
});

describe('voucher reference CLI option', () => {
  it.each([
    ['A/12', { series: 'A', number: '12' }],
    ['B/1', { series: 'B', number: '1' }],
    ['AB-2/007', { series: 'AB-2', number: '007' }],
  ])('parses %s', (value, expected) => {
    expect(parseVoucherReference(value)).toEqual(expected);
  });

  it.each(['', 'A', 'A/', '/12', 'A/12/3', 'A/x', 'A /12', '../12', 'A/1 2', 'a b/1'])(
    'rejects %j',
    (value) => {
      expect(() => parseVoucherReference(value)).toThrow(/<series>\/<number>/);
    },
  );

  it('collects repeated and variadic --ref values in order', () => {
    const collect = (value: string, previous: { series: string; number: string }[] = []) => [
      ...previous,
      parseVoucherReference(value),
    ];
    const command = new Command().option('--ref <series/number...>', 'refs', collect);
    command.parse(['--ref', 'A/1', 'A/2', '--ref', 'B/3'], { from: 'user' });
    expect(command.opts().ref).toEqual([
      { series: 'A', number: '1' },
      { series: 'A', number: '2' },
      { series: 'B', number: '3' },
    ]);
  });
});
