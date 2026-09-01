import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createAccrualOperations } from '../../src/operations/accruals.js';

describe('accrual operations', () => {
  it('covers list/get/create/update/delete for all three native families', async () => {
    const request = vi.fn();
    const operations = createAccrualOperations({ request } as unknown as FortnoxTransport);
    const definitions = [
      ['Invoice', 'invoiceaccruals', 'InvoiceAccruals', 'InvoiceAccrual'],
      [
        'SupplierInvoice',
        'supplierinvoiceaccruals',
        'SupplierInvoiceAccruals',
        'SupplierInvoiceAccrual',
      ],
      ['Contract', 'contractaccruals', 'ContractAccruals', 'ContractAccrual'],
    ] as const;
    const dynamic = operations as unknown as Record<
      string,
      (...arguments_: unknown[]) => Promise<unknown>
    >;

    for (const [prefix, endpoint, listKey, singleKey] of definitions) {
      request.mockResolvedValueOnce({ [listKey]: [{ DocumentNumber: 7 }] });
      const listed = (await dynamic[`list${prefix}Accruals`]?.()) as {
        items: Record<string, unknown>[];
      };
      expect(listed.items).toHaveLength(1);
      expect(request).toHaveBeenLastCalledWith(endpoint);

      request.mockResolvedValueOnce({ [singleKey]: { DocumentNumber: 7 } });
      await dynamic[`get${prefix}Accrual`]?.('7');
      expect(request).toHaveBeenLastCalledWith(`${endpoint}/7`);

      request.mockResolvedValueOnce({ [singleKey]: { DocumentNumber: 7 } });
      await dynamic[`create${prefix}Accrual`]?.({ Total: 100 });
      expect(request).toHaveBeenLastCalledWith(endpoint, {
        method: 'POST',
        body: { [singleKey]: { Total: 100 } },
      });

      request.mockResolvedValueOnce({ [singleKey]: { DocumentNumber: 7 } });
      await dynamic[`update${prefix}Accrual`]?.('7', { Total: 200 });
      expect(request).toHaveBeenLastCalledWith(`${endpoint}/7`, {
        method: 'PUT',
        body: { [singleKey]: { Total: 200 } },
      });

      request.mockResolvedValueOnce({});
      await dynamic[`delete${prefix}Accrual`]?.('7');
      expect(request).toHaveBeenLastCalledWith(`${endpoint}/7`, { method: 'DELETE' });
    }
  });

  it('rejects unsafe document-number path segments', async () => {
    const request = vi.fn();
    const operations = createAccrualOperations({ request } as unknown as FortnoxTransport);
    await expect(operations.getInvoiceAccrual('../companyinformation')).rejects.toThrow(
      'Invalid document number',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
