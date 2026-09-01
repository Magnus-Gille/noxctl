import { basename, extname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

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

function uploadForm(filePath: string): FormData {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!statSync(filePath).isFile()) throw new Error(`Not a regular file: ${filePath}`);
  const buffer = readFileSync(filePath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], {
      type: MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    }),
    basename(filePath),
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
    filePath: string,
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
    filePath: string,
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
