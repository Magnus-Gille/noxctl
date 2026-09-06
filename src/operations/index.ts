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

/** Bind every Fortnox API operation to one explicit transport instance. */
export function createFortnoxOperations(transport: FortnoxTransport) {
  return Object.freeze({
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
}

export type FortnoxOperations = ReturnType<typeof createFortnoxOperations>;

/** Backward-compatible operations bound to the local profile transport. */
export const defaultFortnoxOperations = createFortnoxOperations(defaultFortnoxTransport);
