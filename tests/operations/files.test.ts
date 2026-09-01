import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFileOperations } from '../../src/operations/files.js';
import { privateOutputPath, writeBinaryFile } from '../../src/safe-file-output.js';

describe('archive and inbox operations', () => {
  it('covers native archive and inbox reads/deletes', async () => {
    const request = vi.fn().mockResolvedValue({ Folder: { Files: [] } });
    const requestFile = vi.fn().mockResolvedValue({
      buffer: Buffer.from('file'),
      contentType: 'application/pdf',
    });
    const operations = createFileOperations({
      request,
      requestFile,
    } as unknown as FortnoxTransport);

    await operations.listArchive({ path: 'docs', fileId: 'f1' });
    const archiveFile = await operations.getArchiveEntry('a/b', {
      path: 'docs',
      fileId: 'nested-file',
    });
    await operations.deleteArchivePath('docs/old');
    await operations.deleteArchiveEntry('a/b', 'docs');
    await operations.listInbox();
    const file = await operations.getInboxFile('a/b');
    await operations.deleteInboxEntry('a/b');

    expect(request.mock.calls).toEqual([
      ['archive', { params: { path: 'docs', fileid: 'f1' } }],
      ['archive', { method: 'DELETE', params: { path: 'docs/old' } }],
      ['archive/a%2Fb', { method: 'DELETE', params: { path: 'docs' } }],
      ['inbox'],
      ['inbox/a%2Fb', { method: 'DELETE' }],
    ]);
    expect(requestFile.mock.calls).toEqual([
      ['archive/a%2Fb', { params: { path: 'docs', fileid: 'nested-file' } }],
      ['inbox/a%2Fb'],
    ]);
    expect(archiveFile.buffer.toString()).toBe('file');
    expect(file.buffer.toString()).toBe('file');
  });

  it('uploads exact local bytes through multipart requests', async () => {
    const request = vi.fn().mockResolvedValue({ File: { Id: 'f1' } });
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);
    const path = privateOutputPath('noxctl-test-', 'receipt.pdf');
    writeBinaryFile(path, Buffer.from('%PDF-test'));

    await operations.uploadArchiveFile(path, { folderId: 'archive-folder' });
    await operations.uploadInboxEntry(path, { folderId: 'inbox-folder' });

    const archiveOptions = request.mock.calls[0][1];
    const inboxOptions = request.mock.calls[1][1];
    expect(archiveOptions.method).toBe('POST');
    expect(archiveOptions.rawBody).toBeInstanceOf(FormData);
    expect(archiveOptions.params.folderid).toBe('archive-folder');
    expect(inboxOptions.rawBody).toBeInstanceOf(FormData);
    expect(inboxOptions.params.folderId).toBe('inbox-folder');
  });
});
