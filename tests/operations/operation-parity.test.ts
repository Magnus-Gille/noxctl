import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

function mockJson(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

function calls(): [string, RequestInit][] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
}

describe('existing-family operation parity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('updates and resolves composite absence transactions', async () => {
    mockJson({ AbsenceTransaction: { id: 'row-1' } });
    const { updateAbsenceTransaction, getAbsenceTransactionByDateCode } =
      await import('../../src/operations/absencetransactions.js');
    await updateAbsenceTransaction('row-1', { Hours: 4 });
    await getAbsenceTransactionByDateCode('employee/1', '2026-09-01', 'VAB');

    expect(calls()[0][1].method).toBe('PUT');
    expect(JSON.parse(String(calls()[0][1].body)).AbsenceTransaction).toEqual({ Hours: 4 });
    expect(calls()[1][0]).toContain('employee%2F1/2026-09-01/VAB');
  });

  it('updates and resolves composite attendance transactions', async () => {
    mockJson({ AttendanceTransaction: { id: 'row-1' } });
    const { updateAttendanceTransaction, getAttendanceTransactionByDateCode } =
      await import('../../src/operations/attendancetransactions.js');
    await updateAttendanceTransaction('row-1', { Hours: 8 });
    await getAttendanceTransactionByDateCode('employee/1', '2026-09-01', 'ARB');

    expect(calls()[0][1].method).toBe('PUT');
    expect(calls()[1][0]).toContain('employee%2F1/2026-09-01/ARB');
  });

  it('updates salary transactions', async () => {
    mockJson({ SalaryTransaction: { SalaryRow: '4' } });
    const { updateSalaryTransaction } = await import('../../src/operations/salarytransactions.js');
    await updateSalaryTransaction('4', { Amount: 100 });
    expect(calls()[0][1].method).toBe('PUT');
    expect(JSON.parse(String(calls()[0][1].body)).SalaryTransaction.Amount).toBe(100);
  });

  it('updates and bookkeeps customer invoice payments', async () => {
    mockJson({ InvoicePayment: { Number: 4 } });
    const { updateInvoicePayment, bookkeepInvoicePayment } =
      await import('../../src/operations/invoice-payments.js');
    await updateInvoicePayment('4', { Amount: 100 });
    await bookkeepInvoicePayment('4');
    expect(calls().map(([url]) => url)).toEqual([
      expect.stringContaining('invoicepayments/4'),
      expect.stringContaining('invoicepayments/4/bookkeep'),
    ]);
    expect(calls().every(([, init]) => init.method === 'PUT')).toBe(true);
  });

  it('updates and bookkeeps supplier invoice payments', async () => {
    mockJson({ SupplierInvoicePayment: { Number: 4 } });
    const { updateSupplierInvoicePayment, bookkeepSupplierInvoicePayment } =
      await import('../../src/operations/supplier-invoice-payments.js');
    await updateSupplierInvoicePayment('4', { Amount: 100 });
    await bookkeepSupplierInvoicePayment('4');
    expect(calls()[1][0]).toContain('supplierinvoicepayments/4/bookkeep');
    expect(calls().every(([, init]) => init.method === 'PUT')).toBe(true);
  });

  it('updates and deletes tax reductions', async () => {
    mockJson({ TaxReduction: { Id: 7 } });
    const { updateTaxReduction, deleteTaxReduction } =
      await import('../../src/operations/taxreductions.js');
    await updateTaxReduction(7, { Status: 'PAID' });
    await deleteTaxReduction(7);
    expect(calls().map(([, init]) => init.method)).toEqual(['PUT', 'DELETE']);
  });

  it('deletes projects', async () => {
    mockJson({});
    const { deleteProject } = await import('../../src/operations/projects.js');
    await deleteProject('P/1');
    expect(calls()[0][0]).toContain('projects/P%2F1');
    expect(calls()[0][1].method).toBe('DELETE');
  });

  it('creates a financial year with its native envelope', async () => {
    mockJson({ FinancialYear: { Id: 7 } });
    const { createFinancialYear } = await import('../../src/operations/financial-years.js');
    await createFinancialYear({ FromDate: '2026-01-01', ToDate: '2026-12-31' });
    expect(calls()[0][1].method).toBe('POST');
    expect(JSON.parse(String(calls()[0][1].body)).FinancialYear.ToDate).toBe('2026-12-31');
  });

  it('covers supplier-invoice update and native approval/status actions', async () => {
    mockJson({ SupplierInvoice: { GivenNumber: '8' } });
    const operations = await import('../../src/operations/supplier-invoices.js');
    await operations.updateSupplierInvoice('8', { Comments: 'reviewed' });
    await operations.approvalBookkeepSupplierInvoice('8');
    await operations.approvalPaymentSupplierInvoice('8');
    await operations.cancelSupplierInvoice('8');
    await operations.creditSupplierInvoice('8');
    expect(calls().map(([url]) => url)).toEqual([
      expect.stringContaining('supplierinvoices/8'),
      expect.stringContaining('/approvalbookkeep'),
      expect.stringContaining('/approvalpayment'),
      expect.stringContaining('/cancel'),
      expect.stringContaining('/credit'),
    ]);
  });

  it('covers remaining invoice delivery and status actions', async () => {
    mockJson({ Invoice: { DocumentNumber: '8' } });
    const { cancelInvoice, externalPrintInvoice, eprintInvoice } =
      await import('../../src/operations/invoices.js');
    await cancelInvoice('8');
    await externalPrintInvoice('8');
    await eprintInvoice('8');
    expect(calls().map(([url]) => url)).toEqual([
      expect.stringContaining('/cancel'),
      expect.stringContaining('/externalprint'),
      expect.stringContaining('/eprint'),
    ]);
  });

  it('covers remaining offer and order status/delivery actions', async () => {
    mockJson({ Offer: { DocumentNumber: '8' }, Order: { DocumentNumber: '9' } });
    const offers = await import('../../src/operations/offers.js');
    await offers.cancelOffer('8');
    await offers.externalPrintOffer('8');
    await offers.emailOffer('8');
    const orders = await import('../../src/operations/orders.js');
    await orders.cancelOrder('9');
    await orders.externalPrintOrder('9');
    await orders.emailOrder('9');
    expect(calls().map(([url]) => url)).toEqual([
      expect.stringContaining('offers/8/cancel'),
      expect.stringContaining('offers/8/externalprint'),
      expect.stringContaining('offers/8/email'),
      expect.stringContaining('orders/9/cancel'),
      expect.stringContaining('orders/9/externalprint'),
      expect.stringContaining('orders/9/email'),
    ]);
  });

  it('lists, creates, updates, gets and deletes quantity-aware prices', async () => {
    mockJson({ Prices: [], Price: { Price: 12 } });
    const prices = await import('../../src/operations/pricelists.js');
    await prices.listPrices({});
    await prices.createPrice({ PriceList: 'A', ArticleNumber: '1', Price: 12 });
    await prices.getPrice('A', '1', 5);
    await prices.getPrice('A', '1');
    await prices.updatePrice('A', '1', { Price: 14 }, 5);
    await prices.updatePrice('A', '1', { Price: 15 });
    await prices.deletePrice('A', '1', 5);
    expect(calls().map(([, init]) => init.method)).toEqual([
      'GET',
      'POST',
      'GET',
      'GET',
      'PUT',
      'PUT',
      'DELETE',
    ]);
    expect(calls()[0][0]).toMatch(/\/prices\?/);
    expect(calls()[3][0]).toMatch(/\/A\/1$/);
    expect(calls()[6][0]).toContain('/A/1/5');
  });
});
