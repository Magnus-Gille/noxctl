import { describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createInvoiceOperations } from '../../src/operations/invoices.js';

function setup(invoice: Record<string, unknown>, customer: Record<string, unknown> = {}) {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ Invoice: invoice })
    .mockResolvedValueOnce({ Customer: customer });
  const operations = createInvoiceOperations({ request } as unknown as FortnoxTransport);
  return { request, operations };
}

describe('e-invoice preflight', () => {
  it('reads supported nested EDI fields without interpreting EDIStatus as connection readiness', async () => {
    const { operations } = setup({
      CustomerNumber: '25',
      Sent: false,
      Booked: false,
      Cancelled: false,
      EDIInformation: {
        EDIGlobalLocationNumber: '1234567890123',
        EDIGlobalLocationNumberDelivery: '9876543210123',
        EDIYourElectronicReference: 'Buyer-EDI',
        EDIStatus: 'SENT',
      },
    });
    const result = await operations.preflightInvoice('1001');
    expect(result.observed.invoiceGLN).toBe('1234567890123');
    expect(result.observed.invoiceGLNDelivery).toBe('9876543210123');
    expect(result.observed.electronicReference).toBe('Buyer-EDI');
    expect(result.observed.ediStatus).toBe('SENT');
    expect(result.issues.map((issue) => issue.code)).not.toContain('reference_missing');
    expect(result.recipientConnection.status).toBe('unsupported');
    expect(result.ready).toBe(false);
  });

  it('never infers recipient readiness from a delivery default or GLN', async () => {
    const { operations, request } = setup(
      {
        DocumentNumber: '1001',
        CustomerNumber: '25',
        Sent: false,
        Booked: false,
        Cancelled: false,
        YourReference: 'Buyer',
        GLN: '1234567890123',
      },
      { CustomerNumber: '25', DefaultDeliveryTypes: { Invoice: 'EINVOICE' }, GLN: '1234567890123' },
    );
    const result = await operations.preflightInvoice('1001');
    expect(result.ready).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.recipientConnection.status).toBe('unsupported');
    expect(result.peppolAddress.status).toBe('unsupported');
    expect(result.effectiveDeliveryMethod.status).toBe('unknown');
    expect(result.observed.customerDeliveryDefault).toBe('EINVOICE');
    expect(request.mock.calls).toEqual([['invoices/1001'], ['customers/25']]);
  });

  it.each(['Sent', 'Booked', 'Cancelled'])(
    'blocks a non-draft invoice with %s set',
    async (flag) => {
      const { operations } = setup({
        CustomerNumber: '25',
        Sent: false,
        Booked: false,
        Cancelled: false,
        [flag]: true,
      });
      const result = await operations.preflightInvoice('1001');
      expect(result.status).toBe('blocked');
      expect(result.ready).toBe(false);
      expect(result.issues.some((issue) => issue.code === `invoice_${flag.toLowerCase()}`)).toBe(
        true,
      );
    },
  );

  it('does not treat absent draft flags or absent references as verified', async () => {
    const { operations } = setup({ CustomerNumber: '25' });
    const result = await operations.preflightInvoice('1001');
    expect(result.draft.status).toBe('unknown');
    expect(result.issues.map((issue) => issue.code)).toContain('reference_missing');
    expect(result.observed.sent).toBe(null);
  });

  it('reports missing customer binding without issuing a second request', async () => {
    const { operations, request } = setup({ Sent: false, Booked: false, Cancelled: false });
    const result = await operations.preflightInvoice('1001');
    expect(result.status).toBe('blocked');
    expect(result.issues.map((issue) => issue.code)).toContain('customer_missing');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown upstream delivery values without claiming support', async () => {
    const { operations } = setup(
      { CustomerNumber: '25', Sent: false, Booked: false, Cancelled: false },
      { DefaultDeliveryTypes: { Invoice: 'FUTURE_VALUE' } },
    );
    const result = await operations.preflightInvoice('1001');
    expect(result.observed.customerDeliveryDefault).toBe('FUTURE_VALUE');
    expect(result.effectiveDeliveryMethod.status).toBe('unknown');
  });

  it('propagates upstream read failures without masking diagnostic context', async () => {
    const { operations, request } = setup({ CustomerNumber: '25' });
    request
      .mockReset()
      .mockResolvedValueOnce({ Invoice: { CustomerNumber: '25' } })
      .mockRejectedValueOnce(new Error('customer read denied'));
    await expect(operations.preflightInvoice('1001')).rejects.toThrow('customer read denied');
  });

  it('rejects unsafe document identifiers before making requests', async () => {
    const { operations, request } = setup({});
    await expect(operations.preflightInvoice('../send')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
