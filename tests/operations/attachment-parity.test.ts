import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createInvoiceOperations } from '../../src/operations/invoices.js';
import { createSupplierInvoiceOperations } from '../../src/operations/supplier-invoices.js';
import { createVoucherOperations } from '../../src/operations/vouchers.js';

describe('attachment connection operation parity', () => {
  it('gets and deletes voucher file connections', async () => {
    const request = vi.fn().mockResolvedValue({ VoucherFileConnection: { FileId: 'f1' } });
    const operations = createVoucherOperations({ request } as unknown as FortnoxTransport);
    await operations.getVoucherFileConnection('a/b');
    await operations.deleteVoucherFileConnection('a/b');
    expect(request.mock.calls).toEqual([
      ['voucherfileconnections/a%2Fb'],
      ['voucherfileconnections/a%2Fb', { method: 'DELETE' }],
    ]);
  });

  it('covers supplier invoice file-connection lifecycle', async () => {
    const request = vi.fn().mockResolvedValue({
      SupplierInvoiceFileConnection: { FileId: 'f1', SupplierInvoiceNumber: '7' },
    });
    const operations = createSupplierInvoiceOperations({ request } as unknown as FortnoxTransport);
    await operations.getSupplierInvoiceFileConnection('a/b');
    await operations.createSupplierInvoiceFileConnection('7', 'f1');
    await operations.deleteSupplierInvoiceFileConnection('a/b');
    expect(request.mock.calls).toEqual([
      ['supplierinvoicefileconnections/a%2Fb'],
      [
        'supplierinvoicefileconnections',
        {
          method: 'POST',
          body: {
            SupplierInvoiceFileConnection: { SupplierInvoiceNumber: '7', FileId: 'f1' },
          },
        },
      ],
      ['supplierinvoicefileconnections/a%2Fb', { method: 'DELETE' }],
    ]);
  });

  it('covers document attachment create/list/count/validate/update/detach', async () => {
    const request = vi.fn().mockResolvedValue([{ id: 'a1' }]);
    const operations = createInvoiceOperations({ request } as unknown as FortnoxTransport);
    await operations.createDocumentAttachment('7', 'O', 'f1', true);
    await operations.listDocumentAttachments('7', 'O');
    await operations.getAttachmentCounts([7, 8], 'O');
    await operations.validateAttachmentsOnSend([{ id: 'a1', includeOnSend: true }]);
    await operations.updateDocumentAttachment('a/b', { includeOnSend: false });
    await operations.detachDocumentAttachment('a/b');
    expect(request.mock.calls).toEqual([
      [
        '/api/fileattachments/attachments-v1',
        {
          method: 'POST',
          body: [{ entityId: 7, entityType: 'O', fileId: 'f1', includeOnSend: true }],
        },
      ],
      ['/api/fileattachments/attachments-v1', { params: { entityid: '7', entitytype: 'O' } }],
      [
        '/api/fileattachments/attachments-v1/numberofattachments',
        { params: { entityids: '7,8', entitytype: 'O' } },
      ],
      [
        '/api/fileattachments/attachments-v1/validateincludedonsend',
        { method: 'POST', body: [{ id: 'a1', includeOnSend: true }] },
      ],
      [
        '/api/fileattachments/attachments-v1/a%2Fb',
        { method: 'PUT', body: { includeOnSend: false } },
      ],
      ['/api/fileattachments/attachments-v1/a%2Fb', { method: 'DELETE' }],
    ]);
  });
});
