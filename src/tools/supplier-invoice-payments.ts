import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listSupplierInvoicePayments,
  getSupplierInvoicePayment,
  createSupplierInvoicePayment,
  deleteSupplierInvoicePayment,
} from '../operations/supplier-invoice-payments.js';
import {
  supplierInvoicePaymentListColumns,
  supplierInvoicePaymentDetailColumns,
} from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const PaymentNumberSchema = z.string().regex(/^\d+$/, 'Payment number must be numeric');

export function registerSupplierInvoicePaymentTools(server: McpServer): void {
  server.tool(
    'fortnox_list_supplier_invoice_payments',
    'Lista utbetalningar (leverantörsfakturor) i Fortnox. Returnerar: Number, InvoiceNumber, PaymentDate, Amount.',
    {
      invoiceNumber: z.string().optional().describe('Filtrera på fakturanummer'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listSupplierInvoicePayments(params);
      return listResponse(
        data.SupplierInvoicePayments ?? [],
        supplierInvoicePaymentListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_supplier_invoice_payment',
    'Hämta en enskild leverantörsbetalning. Returnerar: Number, InvoiceNumber, PaymentDate, Amount, Currency, Source.',
    {
      paymentNumber: PaymentNumberSchema.describe('Betalningsnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ paymentNumber, includeRaw }) => {
      const payment = await getSupplierInvoicePayment(paymentNumber);
      return detailResponse(payment, supplierInvoicePaymentDetailColumns, payment, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_supplier_invoice_payment',
    'Registrera en utbetalning mot en leverantörsfaktura i Fortnox',
    {
      InvoiceNumber: z.string().describe('Leverantörsfakturanummer'),
      Amount: z.number().describe('Belopp'),
      PaymentDate: z.string().describe('Betalningsdatum (YYYY-MM-DD)'),
      Source: z.string().optional().describe('Betalningskälla'),
      confirm: z.boolean().optional().describe('Bekräfta att betalningen ska registreras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att registrera betalningen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`register payment for supplier invoice ${params.InvoiceNumber}`, {
          SupplierInvoicePayment: params,
        });
      }
      if (!confirm)
        requireConfirmation(`register payment for supplier invoice ${params.InvoiceNumber}`);

      const payment = await createSupplierInvoicePayment(params);
      return detailResponse(payment, supplierInvoicePaymentDetailColumns, payment, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_supplier_invoice_payment',
    'Ta bort en leverantörsbetalning i Fortnox',
    {
      paymentNumber: PaymentNumberSchema.describe('Betalningsnummer att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att betalningen ska tas bort'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort betalningen'),
    },
    async ({ paymentNumber, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete supplier invoice payment ${paymentNumber}`);
      }
      if (!confirm) requireConfirmation(`delete supplier invoice payment ${paymentNumber}`);

      await deleteSupplierInvoicePayment(paymentNumber);
      return confirmationResponse(`Leverantörsbetalning ${paymentNumber} borttagen.`, {});
    },
  );
}
