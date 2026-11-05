import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFortnoxOperations, type FortnoxOperations } from '../../src/operations/index.js';

/**
 * `encodeURIComponent` leaves `.` alone and WHATWG URL parsing collapses dot
 * segments, so an id of `.` or `..` would turn `DELETE inbox/{id}` into
 * `DELETE inbox/` (and `inbox/..` into the API root). Every operation that puts a
 * user-supplied id in a URL path must refuse these before any request is made.
 */

interface IdOperation {
  /** Operation name on the flattened operations object. */
  op: keyof FortnoxOperations;
  /** Number of path ids the operation takes (each is poisoned in turn). */
  ids: number;
  /** Calls the operation; `id(n)` is the n-th path id, other args are valid dummies. */
  call: (ops: FortnoxOperations, id: (n: number) => string) => Promise<unknown>;
  /** Endpoint expected for ordinary ids, given their already-encoded forms. */
  endpoint: (...encoded: string[]) => string;
  /** True when an empty first/second id means "not given" rather than an error. */
  emptyIsOmitted?: boolean;
  /** Response for the ordinary-id call, when the operation validates what it gets back. */
  reply?: unknown;
}

const OPERATIONS: IdOperation[] = [
  // absence transactions
  {
    op: 'getAbsenceTransaction',
    ids: 1,
    call: (o, id) => o.getAbsenceTransaction(id(0)),
    endpoint: (a) => `absencetransactions/${a}`,
  },
  {
    op: 'getAbsenceTransactionByDateCode',
    ids: 3,
    call: (o, id) => o.getAbsenceTransactionByDateCode(id(0), id(1), id(2)),
    endpoint: (a, b, c) => `absencetransactions/${a}/${b}/${c}`,
  },
  {
    op: 'updateAbsenceTransaction',
    ids: 1,
    call: (o, id) => o.updateAbsenceTransaction(id(0), {}),
    endpoint: (a) => `absencetransactions/${a}`,
  },
  {
    op: 'deleteAbsenceTransaction',
    ids: 1,
    call: (o, id) => o.deleteAbsenceTransaction(id(0)),
    endpoint: (a) => `absencetransactions/${a}`,
  },
  // attendance transactions
  {
    op: 'getAttendanceTransaction',
    ids: 1,
    call: (o, id) => o.getAttendanceTransaction(id(0)),
    endpoint: (a) => `attendancetransactions/${a}`,
  },
  {
    op: 'getAttendanceTransactionByDateCode',
    ids: 3,
    call: (o, id) => o.getAttendanceTransactionByDateCode(id(0), id(1), id(2)),
    endpoint: (a, b, c) => `attendancetransactions/${a}/${b}/${c}`,
  },
  {
    op: 'updateAttendanceTransaction',
    ids: 1,
    call: (o, id) => o.updateAttendanceTransaction(id(0), {}),
    endpoint: (a) => `attendancetransactions/${a}`,
  },
  {
    op: 'deleteAttendanceTransaction',
    ids: 1,
    call: (o, id) => o.deleteAttendanceTransaction(id(0)),
    endpoint: (a) => `attendancetransactions/${a}`,
  },
  // articles
  {
    op: 'getArticle',
    ids: 1,
    call: (o, id) => o.getArticle(id(0)),
    endpoint: (a) => `articles/${a}`,
  },
  {
    op: 'updateArticle',
    ids: 1,
    call: (o, id) => o.updateArticle(id(0), {}),
    endpoint: (a) => `articles/${a}`,
  },
  {
    op: 'deleteArticle',
    ids: 1,
    call: (o, id) => o.deleteArticle(id(0)),
    endpoint: (a) => `articles/${a}`,
  },
  // cost centers
  {
    op: 'getCostCenter',
    ids: 1,
    call: (o, id) => o.getCostCenter(id(0)),
    endpoint: (a) => `costcenters/${a}`,
  },
  {
    op: 'updateCostCenter',
    ids: 1,
    call: (o, id) => o.updateCostCenter(id(0), {}),
    endpoint: (a) => `costcenters/${a}`,
  },
  {
    op: 'deleteCostCenter',
    ids: 1,
    call: (o, id) => o.deleteCostCenter(id(0)),
    endpoint: (a) => `costcenters/${a}`,
  },
  // employees
  {
    op: 'getEmployee',
    ids: 1,
    call: (o, id) => o.getEmployee(id(0)),
    endpoint: (a) => `employees/${a}`,
  },
  {
    op: 'updateEmployee',
    ids: 1,
    call: (o, id) => o.updateEmployee(id(0), {}),
    endpoint: (a) => `employees/${a}`,
  },
  // projects
  {
    op: 'getProject',
    ids: 1,
    call: (o, id) => o.getProject(id(0)),
    endpoint: (a) => `projects/${a}`,
  },
  {
    op: 'updateProject',
    ids: 1,
    call: (o, id) => o.updateProject(id(0), {}),
    endpoint: (a) => `projects/${a}`,
  },
  {
    op: 'deleteProject',
    ids: 1,
    call: (o, id) => o.deleteProject(id(0)),
    endpoint: (a) => `projects/${a}`,
  },
  // suppliers
  {
    op: 'getSupplier',
    ids: 1,
    call: (o, id) => o.getSupplier(id(0)),
    endpoint: (a) => `suppliers/${a}`,
  },
  {
    op: 'updateSupplier',
    ids: 1,
    call: (o, id) => o.updateSupplier(id(0), {}),
    endpoint: (a) => `suppliers/${a}`,
  },
  // salary transactions
  {
    op: 'getSalaryTransaction',
    ids: 1,
    call: (o, id) => o.getSalaryTransaction(id(0)),
    endpoint: (a) => `salarytransactions/${a}`,
  },
  {
    op: 'updateSalaryTransaction',
    ids: 1,
    call: (o, id) => o.updateSalaryTransaction(id(0), {}),
    endpoint: (a) => `salarytransactions/${a}`,
  },
  {
    op: 'deleteSalaryTransaction',
    ids: 1,
    call: (o, id) => o.deleteSalaryTransaction(id(0)),
    endpoint: (a) => `salarytransactions/${a}`,
  },
  // schedule times
  {
    op: 'getScheduleTime',
    ids: 2,
    call: (o, id) => o.getScheduleTime(id(0), id(1)),
    endpoint: (a, b) => `scheduletimes/${a}/${b}`,
  },
  {
    op: 'updateScheduleTime',
    ids: 2,
    call: (o, id) => o.updateScheduleTime(id(0), id(1), {}),
    endpoint: (a, b) => `scheduletimes/${a}/${b}`,
  },
  {
    op: 'resetScheduleTimeDay',
    ids: 2,
    call: (o, id) => o.resetScheduleTimeDay(id(0), id(1), {}),
    endpoint: (a, b) => `scheduletimes/${a}/${b}/resetday`,
  },
  // price lists and prices
  {
    op: 'getPriceList',
    ids: 1,
    call: (o, id) => o.getPriceList(id(0)),
    endpoint: (a) => `pricelists/${a}`,
  },
  {
    op: 'updatePriceList',
    ids: 1,
    call: (o, id) => o.updatePriceList(id(0), {}),
    endpoint: (a) => `pricelists/${a}`,
  },
  {
    op: 'listPrices',
    ids: 2,
    call: (o, id) => o.listPrices({ priceListCode: id(0), articleNumber: id(1) }),
    endpoint: (a, b) => `prices/sublist/${a}/${b}`,
    emptyIsOmitted: true,
  },
  {
    op: 'getPrice',
    ids: 2,
    call: (o, id) => o.getPrice(id(0), id(1)),
    endpoint: (a, b) => `prices/${a}/${b}`,
  },
  {
    op: 'updatePrice',
    ids: 2,
    call: (o, id) => o.updatePrice(id(0), id(1), {}),
    endpoint: (a, b) => `prices/${a}/${b}`,
  },
  {
    op: 'deletePrice',
    ids: 2,
    call: (o, id) => o.deletePrice(id(0), id(1), 1),
    endpoint: (a, b) => `prices/${a}/${b}/1`,
  },
  // reference data
  ...(
    [
      ['getCurrency', 'currencies'],
      ['getUnit', 'units'],
      ['getModeOfPayment', 'modesofpayments'],
      ['getTermOfDelivery', 'termsofdeliveries'],
      ['getTermOfPayment', 'termsofpayments'],
      ['getWayOfDelivery', 'wayofdeliveries'],
      ['getVoucherSeries', 'voucherseries'],
      ['getPredefinedVoucherSeries', 'predefinedvoucherseries'],
      ['getPredefinedAccount', 'predefinedaccounts'],
      ['getCustomerReference', 'customerreferences'],
    ] as const
  ).map(([op, endpoint]): IdOperation => ({
    op,
    ids: 1,
    call: (o, id) => o[op](id(0)),
    endpoint: (a) => `${endpoint}/${a}`,
  })),
  // supplier invoices and their files
  {
    op: 'getSupplierInvoice',
    ids: 1,
    call: (o, id) => o.getSupplierInvoice(id(0)),
    endpoint: (a) => `supplierinvoices/${a}`,
  },
  {
    op: 'updateSupplierInvoice',
    ids: 1,
    call: (o, id) => o.updateSupplierInvoice(id(0), {}),
    endpoint: (a) => `supplierinvoices/${a}`,
  },
  ...(
    [
      ['approvalBookkeepSupplierInvoice', 'approvalbookkeep'],
      ['approvalPaymentSupplierInvoice', 'approvalpayment'],
      ['cancelSupplierInvoice', 'cancel'],
      ['creditSupplierInvoice', 'credit'],
    ] as const
  ).map(([op, action]): IdOperation => ({
    op,
    ids: 1,
    call: (o, id) => o[op](id(0)),
    endpoint: (a) => `supplierinvoices/${a}/${action}`,
  })),
  {
    op: 'bookkeepSupplierInvoice',
    ids: 1,
    call: (o, id) => o.bookkeepSupplierInvoice(id(0)),
    endpoint: (a) => `supplierinvoices/${a}/bookkeep`,
  },
  {
    op: 'getSupplierInvoiceFileConnection',
    ids: 1,
    call: (o, id) => o.getSupplierInvoiceFileConnection(id(0)),
    endpoint: (a) => `supplierinvoicefileconnections/${a}`,
  },
  {
    op: 'deleteSupplierInvoiceFileConnection',
    ids: 1,
    call: (o, id) => o.deleteSupplierInvoiceFileConnection(id(0)),
    endpoint: (a) => `supplierinvoicefileconnections/${a}`,
  },
  {
    op: 'getSupplierInvoiceFile',
    ids: 1,
    call: (o, id) => o.getSupplierInvoiceFile(id(0)),
    endpoint: (a) => `inbox/${a}`,
  },
  // vouchers and their files
  {
    op: 'getVoucher',
    ids: 2,
    call: (o, id) => o.getVoucher(id(0), id(1)),
    endpoint: (a, b) => `vouchers/${a}/${b}`,
  },
  {
    op: 'getVoucherFileConnection',
    ids: 1,
    call: (o, id) => o.getVoucherFileConnection(id(0)),
    endpoint: (a) => `voucherfileconnections/${a}`,
  },
  {
    op: 'deleteVoucherFileConnection',
    ids: 1,
    call: (o, id) => o.deleteVoucherFileConnection(id(0)),
    endpoint: (a) => `voucherfileconnections/${a}`,
  },
  {
    op: 'getVoucherFile',
    ids: 1,
    call: (o, id) => o.getVoucherFile(id(0)),
    endpoint: (a) => `inbox/${a}`,
  },
  // document attachments
  {
    op: 'updateDocumentAttachment',
    ids: 1,
    call: (o, id) => o.updateDocumentAttachment(id(0), {}),
    endpoint: (a) => `/api/fileattachments/attachments-v1/${a}`,
  },
  {
    op: 'detachDocumentAttachment',
    ids: 1,
    call: (o, id) => o.detachDocumentAttachment(id(0)),
    endpoint: (a) => `/api/fileattachments/attachments-v1/${a}`,
  },
  // archive and inbox
  {
    op: 'getArchiveEntry',
    ids: 1,
    call: (o, id) => o.getArchiveEntry(id(0)),
    endpoint: (a) => `archive/${a}`,
  },
  {
    op: 'deleteArchiveEntry',
    ids: 1,
    call: (o, id) => o.deleteArchiveEntry(id(0)),
    endpoint: (a) => `archive/${a}`,
  },
  {
    op: 'listInbox',
    ids: 1,
    call: (o, id) => o.listInbox({ folderId: id(0) }),
    endpoint: (a) => `inbox/${a}`,
    // listInbox only accepts a folder that echoes the requested id.
    reply: { Folder: { Id: 'a/b c' } },
  },
  {
    op: 'getInboxFile',
    ids: 1,
    call: (o, id) => o.getInboxFile(id(0)),
    endpoint: (a) => `inbox/${a}`,
  },
  {
    op: 'deleteInboxEntry',
    ids: 1,
    call: (o, id) => o.deleteInboxEntry(id(0)),
    endpoint: (a) => `inbox/${a}`,
  },
];

// A voucher series is stricter than a plain id: it is validated by its own rule.
const STRICT_FIRST_ID = new Set<keyof FortnoxOperations>(['getVoucher']);

function mockTransport(reply: unknown = { Folder: {} }) {
  const transport = {
    request: vi.fn().mockResolvedValue(reply),
    requestWithMetadata: vi.fn().mockResolvedValue({ data: {} }),
    requestPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')),
    requestPdfFromMutation: vi.fn().mockResolvedValue(Buffer.from('pdf')),
    requestFile: vi
      .fn()
      .mockResolvedValue({ buffer: Buffer.from('file'), contentType: 'application/pdf' }),
    fetchAllPages: vi.fn().mockResolvedValue({ items: [], totalResources: 0 }),
  };
  const requestedEndpoints = () =>
    [transport.request, transport.requestFile, transport.requestPdf].flatMap((fn) =>
      fn.mock.calls.map((call) => call[0] as string),
    );
  return { transport, requestedEndpoints };
}

function assertNoRequests(transport: ReturnType<typeof mockTransport>['transport']) {
  for (const [name, fn] of Object.entries(transport)) {
    expect(fn, name).not.toHaveBeenCalled();
  }
}

describe('path segments built from user-supplied ids', () => {
  it('covers every id-taking operation exactly once', () => {
    const names = OPERATIONS.map((entry) => entry.op);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(OPERATIONS)('$op', (entry) => {
    const poisons = entry.emptyIsOmitted ? ['.', '..'] : ['.', '..', ''];

    for (const poison of poisons) {
      for (let position = 0; position < entry.ids; position += 1) {
        it(`rejects ${JSON.stringify(poison)} as id ${position + 1} before any request`, async () => {
          const { transport } = mockTransport();
          const ops = createFortnoxOperations(transport as unknown as FortnoxTransport);
          const ids = (n: number) => (n === position ? poison : 'ok');

          await expect(entry.call(ops, ids)).rejects.toThrow();
          assertNoRequests(transport);
        });
      }
    }

    it('still encodes ordinary ids exactly as before', async () => {
      const { transport, requestedEndpoints } = mockTransport(entry.reply);
      const ops = createFortnoxOperations(transport as unknown as FortnoxTransport);
      // `a/b c` carries both a slash and a space; the first id of getVoucher is a
      // series, which only allows letters/digits, so it gets a plain value.
      const ids = (n: number) => (n === 0 && STRICT_FIRST_ID.has(entry.op) ? 'A' : 'a/b c');
      const encoded = Array.from({ length: entry.ids }, (_, n) =>
        n === 0 && STRICT_FIRST_ID.has(entry.op) ? 'A' : 'a%2Fb%20c',
      );

      await entry.call(ops, ids);

      expect(requestedEndpoints()).toEqual([entry.endpoint(...encoded)]);
    });
  });
});
