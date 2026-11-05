import { basename, extname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { pathSegment } from '../identifiers.js';

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

/**
 * Flattens an inbox response (root or single folder) into table rows: the
 * subfolders first, then the files, each tagged with a `Type` so the two can be
 * told apart in one list.
 */
export function inboxEntries(raw: Record<string, unknown>): Record<string, unknown>[] {
  const folder = (raw.Folder ?? {}) as Record<string, unknown>;
  const tag = (entries: unknown, Type: 'Folder' | 'File') =>
    ((entries ?? []) as Record<string, unknown>[]).map((entry) => ({ ...entry, Type }));
  return [...tag(folder.Folders, 'Folder'), ...tag(folder.Files, 'File')];
}

export function createFileOperations(transport: FortnoxTransport) {
  async function listArchive(params: { path?: string; fileId?: string } = {}) {
    return transport.request<Record<string, unknown>>('archive', {
      params: { path: params.path, fileid: params.fileId },
    });
  }

  async function getArchiveEntry(id: string, params: { path?: string; fileId?: string } = {}) {
    const { buffer, contentType } = await transport.requestFile(
      `archive/${pathSegment('archive entry id', id)}`,
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
    await transport.request(`archive/${pathSegment('archive entry id', id)}`, {
      method: 'DELETE',
      params: { path },
    });
  }

  /**
   * Lists the inbox root, or — with `folderId` — the contents of one folder
   * (`GET /3/inbox/{Id}`, e.g. `inbox_v` for Verifikationer). The folder ids
   * come from the root listing.
   *
   * The same endpoint returns raw file bytes for a file id, so a file id here
   * would otherwise surface as a JSON parse error, or as an "empty" folder.
   */
  async function listInbox(params: { folderId?: string } = {}) {
    if (params.folderId === undefined) {
      return transport.request<Record<string, unknown>>('inbox');
    }
    const folderId = params.folderId.trim();
    // Rejects an empty id, `.` and `..`, which would list the inbox root or the API root.
    const folderSegment = pathSegment('folderId', folderId);

    const notAFolder = (cause?: unknown) =>
      new Error(
        `Fortnox did not return an inbox folder for "${folderId}". ` +
          `If it is a file Id, download it with \`noxctl inbox file ${folderId}\`; ` +
          'folder Ids come from `noxctl inbox list`.',
        cause === undefined ? undefined : { cause },
      );

    let raw: Record<string, unknown>;
    try {
      raw = await transport.request<Record<string, unknown>>(`inbox/${folderSegment}`);
    } catch (error) {
      // A file Id answers with file bytes, which the JSON transport cannot parse.
      if (error instanceof SyntaxError) throw notAFolder(error);
      throw error;
    }
    // A real folder answers with `Folder.Id` equal to the requested id (ids are
    // case-sensitive: `INBOX_S` is a 404). Checking it also rejects a file whose
    // bytes merely parse as a folder-shaped JSON document.
    const folder = raw?.Folder as Record<string, unknown> | null | undefined;
    if (typeof folder !== 'object' || folder === null || folder.Id !== folderId) {
      throw notAFolder();
    }
    return raw;
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
    const { buffer, contentType } = await transport.requestFile(
      `inbox/${pathSegment('inbox entry id', id)}`,
    );
    return { id, buffer, contentType };
  }

  async function deleteInboxEntry(id: string): Promise<void> {
    await transport.request(`inbox/${pathSegment('inbox entry id', id)}`, { method: 'DELETE' });
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
