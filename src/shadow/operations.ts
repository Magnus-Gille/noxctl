import { canonicalEncode, decode } from './codec.js';
import type { OperationObserver } from '../shadow/types.js';
import { snapshotOperationArguments } from './snapshot-inputs.js';

/** Explicit operation classification. Keep exhaustive as the aggregate grows. */
export const OPERATION_CATALOGUE: Readonly<Record<string, 'read' | 'write' | 'mode-dependent'>> =
  Object.freeze({
    ...Object.fromEntries(
      (
        [
          'extensionForMime',
          'generateTaxReport',
          'getAbsenceTransaction',
          'getAbsenceTransactionByDateCode',
          'getAccount',
          'getArchiveEntry',
          'getArticle',
          'getAttachmentCounts',
          'getAttendanceTransaction',
          'getAttendanceTransactionByDateCode',
          'getBalanceSheet',
          'getCompanyInfo',
          'getContract',
          'getContractAccrual',
          'getCostCenter',
          'getCurrency',
          'getCustomer',
          'getCustomerReference',
          'getDashboard',
          'getEmployee',
          'getFinancialYear',
          'getGeneralLedger',
          'getInboxFile',
          'getIncomeStatement',
          'getInvoice',
          'getInvoiceAccrual',
          'getInvoicePayment',
          'getInvoicePdf',
          'getInvoiceRequest',
          'getLockedPeriod',
          'getModeOfPayment',
          'getOffer',
          'getOrder',
          'getOverdueSummary',
          'getPredefinedAccount',
          'getPredefinedVoucherSeries',
          'getPrice',
          'getPriceList',
          'getProject',
          'getRecurring',
          'getRecurringDeviation',
          'getSalaryTransaction',
          'getScheduleTime',
          'getSupplier',
          'getSupplierInvoice',
          'getSupplierInvoiceAccrual',
          'getSupplierInvoiceFile',
          'getSupplierInvoiceFileConnection',
          'getSupplierInvoicePayment',
          'getTaxReduction',
          'getTermOfDelivery',
          'getTermOfPayment',
          'getTopCustomers',
          'getUnit',
          'getUnpaidTotals',
          'getVatSummary',
          'getVoucher',
          'getVoucherFile',
          'getVoucherFileConnection',
          'getVoucherSeries',
          'getWayOfDelivery',
          'listAbsenceTransactions',
          'listAccountCharts',
          'listAccounts',
          'listArchive',
          'listArticles',
          'listAttendanceTransactions',
          'listContractAccruals',
          'listContracts',
          'listCostCenters',
          'listCurrencies',
          'listCustomerReferences',
          'listCustomers',
          'listDocumentAttachments',
          'listEmployees',
          'listFinancialYears',
          'listInbox',
          'listInvoiceAccruals',
          'listInvoiceAttachments',
          'listInvoicePayments',
          'listInvoiceRequests',
          'listInvoices',
          'listModesOfPayments',
          'listOffers',
          'listOrders',
          'listPredefinedAccounts',
          'listPredefinedVoucherSeries',
          'listPriceLists',
          'listPrices',
          'listProjects',
          'listRecurringDeviations',
          'listRecurrings',
          'listSalaryTransactions',
          'listSupplierInvoiceAccruals',
          'listSupplierInvoiceAttachments',
          'listSupplierInvoicePayments',
          'listSupplierInvoices',
          'listSuppliers',
          'listTaxReductions',
          'listTermsOfDeliveries',
          'listTermsOfPayments',
          'listUnits',
          'listVoucherAttachments',
          'listVoucherSeries',
          'listVouchers',
          'listWaysOfDelivery',
          'preflightInvoice',
        ] as const
      ).map((name) => [name, 'read'] as const),
    ),
    ...Object.fromEntries(
      (
        [
          'approvalBookkeepSupplierInvoice',
          'approvalPaymentSupplierInvoice',
          'attachInvoiceFiles',
          'attachVoucherFiles',
          'bookkeepInvoice',
          'bookkeepInvoicePayment',
          'bookkeepSupplierInvoice',
          'bookkeepSupplierInvoicePayment',
          'cancelInvoice',
          'cancelOffer',
          'cancelOrder',
          'cancelSupplierInvoice',
          'createAbsenceTransaction',
          'createAccount',
          'createArticle',
          'createAttendanceTransaction',
          'createContract',
          'createContractAccrual',
          'createCostCenter',
          'createCustomer',
          'createDocumentAttachment',
          'createEmployee',
          'createFinancialYear',
          'createInvoice',
          'createInvoiceAccrual',
          'createInvoiceFromContract',
          'createInvoiceFromOffer',
          'createInvoiceFromOrder',
          'createInvoicePayment',
          'createInvoiceRequest',
          'createOffer',
          'createOrder',
          'createOrderFromOffer',
          'createPrice',
          'createPriceList',
          'createProject',
          'createRecurring',
          'createSalaryTransaction',
          'createSupplier',
          'createSupplierInvoice',
          'createSupplierInvoiceAccrual',
          'createSupplierInvoiceFileConnection',
          'createSupplierInvoicePayment',
          'createTaxReduction',
          'createVoucher',
          'createVoucherFileConnection',
          'creditInvoice',
          'creditSupplierInvoice',
          'deleteAbsenceTransaction',
          'deleteAccount',
          'deleteArchiveEntry',
          'deleteArchivePath',
          'deleteArticle',
          'deleteAttendanceTransaction',
          'deleteContractAccrual',
          'deleteCostCenter',
          'deleteCustomer',
          'deleteInboxEntry',
          'deleteInvoiceAccrual',
          'deleteInvoicePayment',
          'deletePrice',
          'deleteProject',
          'deleteSalaryTransaction',
          'deleteSupplierInvoiceAccrual',
          'deleteSupplierInvoiceFileConnection',
          'deleteSupplierInvoicePayment',
          'deleteTaxReduction',
          'deleteVoucherFileConnection',
          'detachDocumentAttachment',
          'emailOffer',
          'emailOrder',
          'eprintInvoice',
          'externalPrintInvoice',
          'externalPrintOffer',
          'externalPrintOrder',
          'finishContract',
          'getInvoiceReminderPdf',
          'increaseInvoiceCount',
          'markInvoicePrinted',
          'patchRecurring',
          'replaceRecurring',
          'resetScheduleTimeDay',
          'sendInvoice',
          'updateAbsenceTransaction',
          'updateAccount',
          'updateArticle',
          'updateAttendanceTransaction',
          'updateContract',
          'updateContractAccrual',
          'updateCostCenter',
          'updateCustomer',
          'updateDocumentAttachment',
          'updateEmployee',
          'updateInvoice',
          'updateInvoiceAccrual',
          'updateInvoicePayment',
          'updateOffer',
          'updateOrder',
          'updatePrice',
          'updatePriceList',
          'updateProject',
          'updateSalaryTransaction',
          'updateScheduleTime',
          'updateSupplier',
          'updateSupplierInvoice',
          'updateSupplierInvoiceAccrual',
          'updateSupplierInvoicePayment',
          'updateTaxReduction',
          'uploadArchiveFile',
          'uploadInboxEntry',
          'uploadInboxFile',
          'validateAttachmentsOnSend',
        ] as const
      ).map((name) => [name, 'write'] as const),
    ),
    getOfferPdf: 'mode-dependent',
    getOrderPdf: 'mode-dependent',
  } satisfies Record<string, 'read' | 'write' | 'mode-dependent'>);

/** Wrap only externally visible operations; nested factory helpers stay internal. */
export function observeOperations<T extends Record<string, unknown>>(
  operations: T,
  observer?: OperationObserver,
): T {
  if (!observer) return operations;
  const wrapped: Record<string, unknown> = {};
  for (const [operation, value] of Object.entries(operations)) {
    if (typeof value !== 'function') {
      wrapped[operation] = value;
      continue;
    }
    const classification = OPERATION_CATALOGUE[operation as keyof typeof OPERATION_CATALOGUE];
    if (!classification) {
      wrapped[operation] = (..._args: unknown[]) => {
        throw new Error(`Operation observer has no classification for "${operation}".`);
      };
      continue;
    }
    wrapped[operation] = (...args: unknown[]) => {
      const mutating =
        classification === 'write' || (classification === 'mode-dependent' && args[1] === 'print');
      if (!mutating) return (value as (...args: unknown[]) => unknown).apply(operations, args);
      let observedArgs: unknown[];
      try {
        observedArgs = decode(
          canonicalEncode(snapshotOperationArguments(operation, args)),
        ) as unknown[];
      } catch (error) {
        return Promise.reject(error);
      }
      return observer.execute(operation, observedArgs, () => {
        try {
          return Promise.resolve(
            (value as (...args: unknown[]) => unknown).apply(operations, observedArgs),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      });
    };
  }
  return Object.freeze(wrapped) as T;
}

export type { OperationObserver } from '../shadow/types.js';
