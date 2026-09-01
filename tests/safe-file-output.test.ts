import { lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateOutputPath, writeBinaryFile } from '../src/safe-file-output.js';

describe('safe binary file output', () => {
  it('creates private temporary destinations and exact bytes', () => {
    const path = privateOutputPath('noxctl-test-', 'file.bin');
    expect(writeBinaryFile(path, Buffer.from([0, 1, 2]))).toBe(path);
    expect(readFileSync(path)).toEqual(Buffer.from([0, 1, 2]));
    // POSIX mode bits are not meaningful on Windows; the user's temporary
    // directory ACL is the relevant boundary there.
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps untrusted default file names inside the private temporary directory', () => {
    const path = privateOutputPath('noxctl-test-', 'archive-x/../../../../outside.bin');
    expect(basename(path)).toBe('outside.bin');
    expect(basename(dirname(path))).toMatch(/^noxctl-test-/);
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
