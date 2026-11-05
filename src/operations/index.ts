import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { createAbsenceTransactionOperations } from './absencetransactions.js';
import { createAccrualOperations } from './accruals.js';
import { createAccountOperations } from './accounts.js';
import { createAnalyticsOperations } from './analytics.js';
import { createArticleOperations } from './articles.js';
import { createAttendanceTransactionOperations } from './attendancetransactions.js';
import { createCompanyOperations } from './company.js';
import { createContractOperations } from './contracts.js';
import { createCostCenterOperations } from './costcenters.js';
import { createCustomerOperations } from './customers.js';
import { createEmployeeOperations } from './employees.js';
import { createFinancialReportOperations } from './financial-reports.js';
import { createFinancialYearOperations } from './financial-years.js';
import { createFileOperations } from './files.js';
import { createGeneralLedgerOperations } from './general-ledger.js';
import { createInvoicePaymentOperations } from './invoice-payments.js';
import { createInvoiceOperations } from './invoices.js';
import { createOfferOperations } from './offers.js';
import { createOrderOperations } from './orders.js';
import { createPriceListOperations, createPriceOperations } from './pricelists.js';
import { createProjectOperations } from './projects.js';
import { createRecurringOperations } from './recurrings.js';
import { createReferenceDataOperations } from './reference-data.js';
import { createSalaryTransactionOperations } from './salarytransactions.js';
import { createScheduleTimeOperations } from './scheduletimes.js';
import { createSupplierInvoicePaymentOperations } from './supplier-invoice-payments.js';
import { createSupplierInvoiceOperations } from './supplier-invoices.js';
import { createSupplierOperations } from './suppliers.js';
import { createTaxOperations } from './tax.js';
import { createTaxReductionOperations } from './taxreductions.js';
import { createVoucherOperations } from './vouchers.js';
import { observeOperations, type OperationObserver } from '../shadow/operations.js';

/** Bind every Fortnox API operation to one explicit transport instance. */
export function createFortnoxOperations(transport: FortnoxTransport, observer?: OperationObserver) {
  const operations = Object.freeze({
    ...createAbsenceTransactionOperations(transport),
    ...createAccrualOperations(transport),
    ...createAccountOperations(transport),
    ...createAnalyticsOperations(transport),
    ...createArticleOperations(transport),
    ...createAttendanceTransactionOperations(transport),
    ...createCompanyOperations(transport),
    ...createContractOperations(transport),
    ...createCostCenterOperations(transport),
    ...createCustomerOperations(transport),
    ...createEmployeeOperations(transport),
    ...createFinancialReportOperations(transport),
    ...createFinancialYearOperations(transport),
    ...createFileOperations(transport),
    ...createGeneralLedgerOperations(transport),
    ...createInvoicePaymentOperations(transport),
    ...createInvoiceOperations(transport),
    ...createOfferOperations(transport),
    ...createOrderOperations(transport),
    ...createPriceListOperations(transport),
    ...createPriceOperations(transport),
    ...createProjectOperations(transport),
    ...createRecurringOperations(transport),
    ...createReferenceDataOperations(transport),
    ...createSalaryTransactionOperations(transport),
    ...createScheduleTimeOperations(transport),
    ...createSupplierInvoicePaymentOperations(transport),
    ...createSupplierInvoiceOperations(transport),
    ...createSupplierOperations(transport),
    ...createTaxOperations(transport),
    ...createTaxReductionOperations(transport),
    ...createVoucherOperations(transport),
  });
  return observeOperations(operations, observer);
}

export type FortnoxOperations = ReturnType<typeof createFortnoxOperations>;

/** Backward-compatible operations bound to the local profile transport. */
const baseDefaultFortnoxOperations = createFortnoxOperations(defaultFortnoxTransport);
let currentDefaultFortnoxOperations = baseDefaultFortnoxOperations;

/** Set a host-owned observer for subsequent calls through the default aggregate. */
export function setDefaultOperationObserver(observer?: OperationObserver): void {
  currentDefaultFortnoxOperations = observer
    ? observeOperations(baseDefaultFortnoxOperations, observer)
    : baseDefaultFortnoxOperations;
}

/** Stable forwarding functions resolve the selected set at each invocation. */
const defaultOperationForwarders = Object.fromEntries(
  Object.keys(baseDefaultFortnoxOperations).map((operation) => [
    operation,
    (...args: unknown[]) => {
      const invoke = currentDefaultFortnoxOperations[operation as keyof FortnoxOperations] as (
        ...args: unknown[]
      ) => unknown;
      return invoke(...args);
    },
  ]),
);

export const defaultFortnoxOperations = Object.freeze(
  defaultOperationForwarders,
) as FortnoxOperations;
