import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createCompanyOperations } from '../../src/operations/company.js';
import { createCustomerOperations } from '../../src/operations/customers.js';
import { createInvoiceOperations } from '../../src/operations/invoices.js';
import { createFortnoxOperations } from '../../src/operations/index.js';

function stubTransport(companyName: string): FortnoxTransport {
  return {
    request: vi.fn().mockResolvedValue({ CompanyInformation: { CompanyName: companyName } }),
    requestWithMetadata: vi.fn(),
    requestPdf: vi.fn(),
    requestPdfFromMutation: vi.fn(),
    requestFile: vi.fn(),
    fetchAllPages: vi.fn(),
  } as FortnoxTransport;
}

describe('client-bound operations', () => {
  it('keeps concurrent operation sets bound to their own transport', async () => {
    const transportA = stubTransport('Tenant A AB');
    const transportB = stubTransport('Tenant B AB');
    const operationsA = createCompanyOperations(transportA);
    const operationsB = createCompanyOperations(transportB);

    const [companyA, companyB] = await Promise.all([
      operationsA.getCompanyInfo(),
      operationsB.getCompanyInfo(),
    ]);

    expect(companyA.CompanyName).toBe('Tenant A AB');
    expect(companyB.CompanyName).toBe('Tenant B AB');
    expect(transportA.request).toHaveBeenCalledWith('companyinformation');
    expect(transportB.request).toHaveBeenCalledWith('companyinformation');
  });

  it('uses the bound transport for pagination, mutations, and PDFs', async () => {
    const transport = stubTransport('Tenant AB');
    vi.mocked(transport.fetchAllPages).mockResolvedValue({
      items: [{ CustomerNumber: '1' }],
      totalResources: 1,
    });
    vi.mocked(transport.request).mockResolvedValue({ Customer: { CustomerNumber: '2' } });
    vi.mocked(transport.requestPdf).mockResolvedValue(Buffer.from('%PDF-bound'));
    const customers = createCustomerOperations(transport);
    const invoices = createInvoiceOperations(transport);

    await expect(customers.listCustomers({ all: true })).resolves.toMatchObject({
      Customers: [{ CustomerNumber: '1' }],
    });
    await expect(customers.createCustomer({ Name: 'New AB' })).resolves.toEqual({
      CustomerNumber: '2',
    });
    await expect(invoices.getInvoicePdf('42')).resolves.toEqual(Buffer.from('%PDF-bound'));

    expect(transport.fetchAllPages).toHaveBeenCalledWith('customers', 'Customers', {});
    expect(transport.request).toHaveBeenCalledWith('customers', {
      method: 'POST',
      body: { Customer: { Name: 'New AB' } },
    });
    expect(transport.requestPdf).toHaveBeenCalledWith('invoices/42/preview');
  });

  it.each(['email', 'einvoice'] as const)(
    'classifies invoice %s delivery as a non-retryable mutation',
    async (method) => {
      const transport = stubTransport('Tenant AB');
      vi.mocked(transport.request).mockResolvedValue({ Invoice: { DocumentNumber: '42' } });
      const invoices = createInvoiceOperations(transport);

      await invoices.sendInvoice('42', method);

      expect(transport.request).toHaveBeenCalledWith(`invoices/42/${method}`, {
        mutation: true,
      });
    },
  );

  it('aggregates every operation family into one frozen bound set', () => {
    const operations = createFortnoxOperations(stubTransport('Tenant AB'));

    expect(Object.isFrozen(operations)).toBe(true);
    expect(operations).toEqual(
      expect.objectContaining({
        getCompanyInfo: expect.any(Function),
        listCustomers: expect.any(Function),
        getInvoicePdf: expect.any(Function),
        generateTaxReport: expect.any(Function),
        attachVoucherFiles: expect.any(Function),
        createRecurring: expect.any(Function),
        getDashboard: expect.any(Function),
      }),
    );
  });
});
