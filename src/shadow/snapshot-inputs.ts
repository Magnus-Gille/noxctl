import { snapshotOperationFile, type OperationFile } from '../operation-file.js';

const singleFileOperations = new Set(['uploadArchiveFile', 'uploadInboxEntry', 'uploadInboxFile']);
const attachmentOperations = new Set(['attachVoucherFiles', 'attachInvoiceFiles']);

/** Snapshot only the file-bearing mutation arguments that participate in shadow intents. */
export function snapshotOperationArguments(operation: string, args: unknown[]): unknown[] {
  if (singleFileOperations.has(operation)) {
    return [snapshotOperationFile(args[0] as OperationFile), ...args.slice(1)];
  }
  if (!attachmentOperations.has(operation)) return args;

  const params = args[0];
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`Invalid file arguments for ${operation}: expected an object with filePaths.`);
  }
  const input = params as Record<string, unknown>;
  if (!Array.isArray(input.filePaths)) {
    throw new Error(`Invalid file arguments for ${operation}: filePaths must be an array.`);
  }
  const notRegularFileMessage = 'Not a file';
  const filePaths = input.filePaths.map((file) =>
    snapshotOperationFile(file as OperationFile, { notRegularFileMessage }),
  );
  return [{ ...input, filePaths }, ...args.slice(1)];
}
