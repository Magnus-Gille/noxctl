import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/index.js';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

async function setup() {
  const server = createServer();
  const client = new Client({ name: 'file-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

const mutations = [
  ['fortnox_upload_archive_file', { filePath: '/not/read.pdf', dryRun: true }],
  ['fortnox_delete_archive_path', { path: 'old', dryRun: true }],
  ['fortnox_delete_archive_entry', { id: 'a1', dryRun: true }],
  ['fortnox_upload_inbox_file', { filePath: '/not/read.pdf', dryRun: true }],
  ['fortnox_delete_inbox_entry', { id: 'a1', dryRun: true }],
  ['fortnox_delete_voucher_file_connection', { fileId: 'f1', dryRun: true }],
  [
    'fortnox_create_supplier_invoice_file_connection',
    { givenNumber: '7', fileId: 'f1', dryRun: true },
  ],
  ['fortnox_delete_supplier_invoice_file_connection', { fileId: 'f1', dryRun: true }],
  [
    'fortnox_create_document_attachment',
    {
      documentNumber: '7',
      entityType: 'O',
      fileId: 'f1',
      includeOnSend: true,
      dryRun: true,
    },
  ],
  [
    'fortnox_validate_attachments_on_send',
    { attachments: [{ entityId: 7, entityType: 'F', fileId: 'f1' }], dryRun: true },
  ],
  [
    'fortnox_update_document_attachment',
    {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      includeOnSend: false,
      dryRun: true,
    },
  ],
  [
    'fortnox_detach_document_attachment',
    { attachmentId: '11111111-1111-4111-8111-111111111111', dryRun: true },
  ],
] as const;

describe('archive, inbox, and attachment tools', () => {
  it('discovers the selected complete file surface', async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map(({ name }) => name);
    for (const name of [
      'fortnox_list_archive',
      'fortnox_get_archive_entry',
      'fortnox_list_inbox',
      'fortnox_get_inbox_file',
      'fortnox_get_voucher_file_connection',
      'fortnox_get_supplier_invoice_file_connection',
      'fortnox_list_document_attachments',
      'fortnox_get_attachment_counts',
      ...mutations.map(([name]) => name),
    ])
      expect(names).toContain(name);
  });

  it('previews every file mutation without reading paths or calling Fortnox', async () => {
    global.fetch = vi.fn();
    const { client } = await setup();
    for (const [name, arguments_] of mutations) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError, name).toBeFalsy();
      expect((result.content as { text: string }[])[0]?.text, name).toContain('Dry run');
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
