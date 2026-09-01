import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export function privateOutputPath(prefix: string, fileName: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const candidate = basename(fileName);
  const safeName = !candidate || candidate === '.' || candidate === '..' ? 'download' : candidate;
  return join(directory, safeName);
}

export function writeBinaryFile(targetPath: string, data: Buffer, overwrite = false): string {
  const target = resolve(targetPath);
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fsConstants;
  const flags = overwrite
    ? O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0)
    : O_WRONLY | O_CREAT | O_EXCL;

  if (overwrite && !O_NOFOLLOW && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${target} is a symbolic link. Refusing to write through it.`);
  }

  try {
    const descriptor = openSync(target, flags, 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(descriptor, data, written, data.length - written);
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`${target} already exists. Choose another path or set overwrite: true.`);
    }
    if (code === 'ELOOP') {
      throw new Error(`${target} is a symbolic link. Refusing to write through it.`);
    }
    throw error;
  }
  return target;
}
