import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listInvoicePayments,
  getInvoicePayment,
  createInvoicePayment,
  deleteInvoicePayment,
} from '../operations/invoice-payments.js';
import { invoicePaymentListColumns, invoicePaymentDetailColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const PaymentNumberSchema = z.string().regex(/^\d+$/, 'Payment number must be numeric');

export function registerInvoicePaymentTools(server: McpServer): void {
  server.tool(
    'fortnox_list_invoice_payments',
    'Lista inbetalningar (kundfakturor) i Fortnox. Returnerar: Number, InvoiceNumber, PaymentDate, Amount.',
    {
      invoiceNumber: z.string().optional().describe('Filtrera på fakturanummer'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listInvoicePayments(params);
      return listResponse(
        data.InvoicePayments ?? [],
        invoicePaymentListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_invoice_payment',
    'Hämta en enskild inbetalning. Returnerar: Number, InvoiceNumber, PaymentDate, Amount, Currency, Source.',
    {
      paymentNumber: PaymentNumberSchema.describe('Betalningsnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ paymentNumber, includeRaw }) => {
      const payment = await getInvoicePayment(paymentNumber);
      return detailResponse(payment, invoicePaymentDetailColumns, payment, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_invoice_payment',
    'Registrera en inbetalning mot en kundfaktura i Fortnox',
    {
      InvoiceNumber: z.number().describe('Fakturanummer'),
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
        return dryRunResponse(`register payment for invoice ${params.InvoiceNumber}`, {
          InvoicePayment: params,
        });
      }
      if (!confirm) requireConfirmation(`register payment for invoice ${params.InvoiceNumber}`);

      const payment = await createInvoicePayment(params);
      return detailResponse(payment, invoicePaymentDetailColumns, payment, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_invoice_payment',
    'Ta bort en inbetalning i Fortnox',
    {
      paymentNumber: PaymentNumberSchema.describe('Betalningsnummer att ta bort'),
      confirm: z.boolean().optional().describe('Bekräfta att betalningen ska tas bort'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort betalningen'),
    },
    async ({ paymentNumber, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`delete invoice payment ${paymentNumber}`);
      }
      if (!confirm) requireConfirmation(`delete invoice payment ${paymentNumber}`);

      await deleteInvoicePayment(paymentNumber);
      return confirmationResponse(`Inbetalning ${paymentNumber} borttagen.`, {});
    },
  );
}
