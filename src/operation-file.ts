import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** A path supplied by a caller or a copied, operation-local file payload. */
export type OperationFile = string | Readonly<{ fileName: string; content: Buffer }>;

export interface OperationFileSnapshot {
  readonly fileName: string;
  readonly content: Buffer;
}

export interface SnapshotOperationFileOptions {
  /** Existing attachment APIs use this wording for non-files. */
  notRegularFileMessage?: string;
}

/** Validate an operation file without reading path bytes; return its basename. */
export function validateOperationFile(
  input: OperationFile,
  options: SnapshotOperationFileOptions = {},
): string {
  if (typeof input === 'string') {
    if (!existsSync(input)) throw new Error(`File not found: ${input}`);
    if (!statSync(input).isFile()) {
      throw new Error(`${options.notRegularFileMessage ?? 'Not a regular file'}: ${input}`);
    }
    return basename(input);
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some((key) => key !== 'fileName' && key !== 'content') ||
    typeof input.fileName !== 'string' ||
    !input.fileName.trim() ||
    !Buffer.isBuffer(input.content)
  ) {
    throw new Error(
      'Unsupported operation file input: expected a path or { fileName, content: Buffer }.',
    );
  }
  const fileName = basename(input.fileName);
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new Error('Unsupported operation file input: fileName must identify a file.');
  }
  return fileName;
}

/** Load a validated path once, or copy a caller-supplied buffer into a private snapshot. */
export function snapshotOperationFile(
  input: OperationFile,
  options: SnapshotOperationFileOptions = {},
): OperationFileSnapshot {
  const fileName = validateOperationFile(input, options);
  const content = typeof input === 'string' ? readFileSync(input) : Buffer.from(input.content);
  return Object.freeze({ fileName, content });
}
