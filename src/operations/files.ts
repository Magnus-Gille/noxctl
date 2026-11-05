import { extname } from 'node:path';
import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { snapshotOperationFile, type OperationFile } from '../operation-file.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
};

function uploadForm(filePath: OperationFile): FormData {
  const snapshot = snapshotOperationFile(filePath);
  const content = new Uint8Array(snapshot.content.byteLength);
  content.set(snapshot.content);
  const form = new FormData();
  form.append(
    'file',
    new Blob([content], {
      type:
        MIME_BY_EXTENSION[extname(snapshot.fileName).toLowerCase()] ?? 'application/octet-stream',
    }),
    snapshot.fileName,
  );
  return form;
}

export function createFileOperations(transport: FortnoxTransport) {
  async function listArchive(params: { path?: string; fileId?: string } = {}) {
    return transport.request<Record<string, unknown>>('archive', {
      params: { path: params.path, fileid: params.fileId },
    });
  }

  async function getArchiveEntry(id: string, params: { path?: string; fileId?: string } = {}) {
    const { buffer, contentType } = await transport.requestFile(
      `archive/${encodeURIComponent(id)}`,
      {
        params: { path: params.path, fileid: params.fileId },
      },
    );
    return { id, buffer, contentType };
  }

  async function uploadArchiveFile(
    filePath: OperationFile,
    params: { folderId?: string; path?: string } = {},
  ) {
    return transport.request<Record<string, unknown>>('archive', {
      method: 'POST',
      params: { folderid: params.folderId, path: params.path },
      rawBody: uploadForm(filePath),
    });
  }

  async function deleteArchivePath(path: string): Promise<void> {
    await transport.request('archive', { method: 'DELETE', params: { path } });
  }

  async function deleteArchiveEntry(id: string, path?: string): Promise<void> {
    await transport.request(`archive/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      params: { path },
    });
  }

  async function listInbox() {
    return transport.request<Record<string, unknown>>('inbox');
  }

  async function uploadInboxEntry(
    filePath: OperationFile,
    params: { folderId?: string; path?: string } = {},
  ) {
    return transport.request<Record<string, unknown>>('inbox', {
      method: 'POST',
      params: { folderId: params.folderId, path: params.path },
      rawBody: uploadForm(filePath),
    });
  }

  async function getInboxFile(id: string) {
    const { buffer, contentType } = await transport.requestFile(`inbox/${encodeURIComponent(id)}`);
    return { id, buffer, contentType };
  }

  async function deleteInboxEntry(id: string): Promise<void> {
    await transport.request(`inbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  return {
    listArchive,
    getArchiveEntry,
    uploadArchiveFile,
    deleteArchivePath,
    deleteArchiveEntry,
    listInbox,
    uploadInboxEntry,
    getInboxFile,
    deleteInboxEntry,
  };
}

export const fileOperations = createFileOperations(defaultFortnoxTransport);
export const {
  listArchive,
  getArchiveEntry,
  uploadArchiveFile,
  deleteArchivePath,
  deleteArchiveEntry,
  listInbox,
  uploadInboxEntry,
  getInboxFile,
  deleteInboxEntry,
} = fileOperations;
