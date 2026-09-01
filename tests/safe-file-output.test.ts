import { lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateOutputPath, writeBinaryFile } from '../src/safe-file-output.js';

describe('safe binary file output', () => {
  it('creates private temporary destinations and exact bytes', () => {
    const path = privateOutputPath('noxctl-test-', 'file.bin');
    expect(writeBinaryFile(path, Buffer.from([0, 1, 2]))).toBe(path);
    expect(readFileSync(path)).toEqual(Buffer.from([0, 1, 2]));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses overwrite unless explicitly allowed', () => {
    const path = privateOutputPath('noxctl-test-', 'existing.bin');
    writeFileSync(path, 'old');
    expect(() => writeBinaryFile(path, Buffer.from('new'))).toThrow('already exists');
    writeBinaryFile(path, Buffer.from('new'), true);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('never follows a destination symlink', () => {
    const real = privateOutputPath('noxctl-test-', 'real.bin');
    const link = join(real, '..', 'link.bin');
    writeFileSync(real, 'old');
    symlinkSync(real, link);
    expect(() => writeBinaryFile(link, Buffer.from('new'), true)).toThrow('symbolic link');
    expect(readFileSync(real, 'utf8')).toBe('old');
  });
});
