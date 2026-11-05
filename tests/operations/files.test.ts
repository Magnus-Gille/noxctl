import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFileOperations, inboxEntries } from '../../src/operations/files.js';
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

  it('lists the contents of an inbox folder by id', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ Folder: { Id: 'inbox_v', Files: [] } })
      .mockResolvedValueOnce({ Folder: { Id: 'a/b', Files: [] } })
      .mockResolvedValueOnce({ Folder: { Id: 'root', Files: [] } });
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);

    await operations.listInbox({ folderId: 'inbox_v' });
    await operations.listInbox({ folderId: 'a/b' });
    await operations.listInbox({});

    expect(request.mock.calls).toEqual([['inbox/inbox_v'], ['inbox/a%2Fb'], ['inbox']]);
  });

  it('rejects a blank inbox folder id instead of silently listing the root', async () => {
    const request = vi.fn();
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);

    await expect(operations.listInbox({ folderId: '  ' })).rejects.toThrow(/folderId/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['.', '..'])(
    'rejects the dot-segment folder id %s that URL parsing would collapse',
    async (folderId) => {
      const request = vi.fn();
      const operations = createFileOperations({ request } as unknown as FortnoxTransport);

      await expect(operations.listInbox({ folderId })).rejects.toThrow(/folderId/);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('explains that a file id is not a folder when Fortnox answers with file bytes', async () => {
    const cause = new SyntaxError(`Unexpected token '%', "%PDF-1.4" is not valid JSON`);
    const request = vi.fn().mockRejectedValue(cause);
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);

    const error = await operations.listInbox({ folderId: 'file-uuid' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/file-uuid/);
    expect((error as Error).message).toMatch(/inbox file file-uuid/);
    expect((error as Error).cause).toBe(cause);
  });

  it.each([
    ['a JSON body without Folder', { Something: 'else' }],
    ['an empty Folder object', { Folder: {} }],
    [
      'a file whose bytes happen to be a folder-shaped JSON document',
      { Folder: { Files: [{ Id: 'fake', Name: 'fake.pdf' }] } },
    ],
    ['a folder with a different Id than the one requested', { Folder: { Id: 'inbox_s' } }],
  ])('does not report %s as the requested folder', async (_label, response) => {
    const request = vi.fn().mockResolvedValue(response);
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);

    await expect(operations.listInbox({ folderId: 'inbox_v' })).rejects.toThrow(/inbox_v/);
  });

  it('lets other transport failures through unchanged', async () => {
    const failure = new Error('HTTP 404');
    const request = vi.fn().mockRejectedValue(failure);
    const operations = createFileOperations({ request } as unknown as FortnoxTransport);

    await expect(operations.listInbox({ folderId: 'nope' })).rejects.toBe(failure);
  });

  it('flattens an inbox response into tagged folder and file rows', () => {
    expect(
      inboxEntries({
        Folder: {
          Folders: [{ Id: 'inbox_v', Name: 'Verifikationer' }],
          Files: [{ Id: 'f1', Name: 'a.pdf', Size: 12 }],
        },
      }),
    ).toEqual([
      { Id: 'inbox_v', Name: 'Verifikationer', Type: 'Folder' },
      { Id: 'f1', Name: 'a.pdf', Size: 12, Type: 'File' },
    ]);
    expect(inboxEntries({})).toEqual([]);
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
