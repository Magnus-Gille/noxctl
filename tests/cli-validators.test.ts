import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { parsePositiveInteger } from '../src/cli-validators.js';

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
