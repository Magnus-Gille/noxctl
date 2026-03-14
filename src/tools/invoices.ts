import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  sendInvoice,
  bookkeepInvoice,
  creditInvoice,
} from '../operations/invoices.js';
import { invoiceListColumns, invoiceDetailColumns, invoiceConfirmColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const InvoiceRowSchema = z.object({
  ArticleNumber: z.string().optional().describe('Artikelnummer'),
  Description: z.string().describe('Beskrivning'),
  DeliveredQuantity: z.number().describe('Antal'),
  Price: z.number().describe('Pris per enhet (exkl. moms)'),
  AccountNumber: z.number().optional().describe('Kontonummer (default: 3001)'),
  VAT: z.number().optional().describe('Momssats i procent (default: 25)'),
  Unit: z.string().optional().describe('Enhet (t.ex. "st", "tim")'),
  Discount: z.number().optional().describe('Rabatt i procent'),
});

const DocumentNumberSchema = z.string().regex(/^\d+$/, 'Document number must be numeric');

export function registerInvoiceTools(server: McpServer): void {
  server.tool(
    'fortnox_list_invoices',
    'Lista/filtrera fakturor i Fortnox',
    {
      filter: z
        .enum(['cancelled', 'fullypaid', 'unpaid', 'unpaidoverdue', 'unbooked'])
        .optional()
        .describe('Filtrera fakturor'),
      customerNumber: z.string().optional().describe('Filtrera på kundnummer'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listInvoices(params);
      return listResponse(
        data.Invoices ?? [],
        invoiceListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_invoice',
    'Hämta en enskild faktura från Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, includeRaw }) => {
      const invoice = await getInvoice(documentNumber);
      return detailResponse(invoice, invoiceDetailColumns, invoice, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_invoice',
    'Skapa en faktura i Fortnox',
    {
      CustomerNumber: z.string().describe('Kundnummer'),
      InvoiceRows: z.array(InvoiceRowSchema).describe('Fakturarader'),
      DueDate: z.string().optional().describe('Förfallodatum (YYYY-MM-DD)'),
      InvoiceDate: z.string().optional().describe('Fakturadatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod (default: SEK)'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create invoice for customer ${params.CustomerNumber}`, {
          Invoice: params,
        });
      }
      if (!confirm) requireConfirmation(`create invoice for customer ${params.CustomerNumber}`);

      const invoice = await createInvoice(params);
      return detailResponse(invoice, invoiceDetailColumns, invoice, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_invoice',
    'Uppdatera en befintlig faktura i Fortnox (ej bokförda)',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer att uppdatera'),
      CustomerNumber: z.string().optional().describe('Kundnummer'),
      InvoiceRows: z
        .array(
          z.object({
            ArticleNumber: z.string().optional().describe('Artikelnummer'),
            Description: z.string().optional().describe('Beskrivning'),
            DeliveredQuantity: z.number().optional().describe('Antal'),
            Price: z.number().optional().describe('Pris per enhet (exkl. moms)'),
            AccountNumber: z.number().optional().describe('Kontonummer'),
            VAT: z.number().optional().describe('Momssats i procent'),
            Unit: z.string().optional().describe('Enhet (t.ex. "st", "tim")'),
            Discount: z.number().optional().describe('Rabatt i procent'),
          }),
        )
        .optional()
        .describe('Fakturarader (ersätter alla befintliga rader)'),
      DueDate: z.string().optional().describe('Förfallodatum (YYYY-MM-DD)'),
      InvoiceDate: z.string().optional().describe('Fakturadatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update invoice ${documentNumber}`, { Invoice: fields });
      }
      if (!confirm) requireConfirmation(`update invoice ${documentNumber}`);

      const invoice = await updateInvoice(documentNumber, fields);
      return detailResponse(invoice, invoiceDetailColumns, invoice, includeRaw);
    },
  );

  server.tool(
    'fortnox_send_invoice',
    'Skicka en faktura via e-post (eller markera för utskrift)',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      method: z
        .enum(['email', 'print', 'einvoice'])
        .optional()
        .describe('Sändmetod (default: email)'),
      emailSubject: z
        .string()
        .optional()
        .describe('E-postens ämnesrad (default: behåller befintlig)'),
      emailBody: z.string().optional().describe('E-postens brödtext'),
      emailBcc: z.string().optional().describe('BCC-adress för kopia'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska skickas'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att skicka fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({
      documentNumber,
      method,
      emailSubject,
      emailBody,
      emailBcc,
      confirm,
      dryRun,
      includeRaw,
    }) => {
      const sendMethod = method || 'email';
      if (dryRun) {
        return dryRunResponse(`send invoice ${documentNumber} via ${sendMethod}`);
      }
      if (!confirm) requireConfirmation(`send invoice ${documentNumber} via ${sendMethod}`);

      const emailOptions =
        emailSubject || emailBody || emailBcc
          ? { subject: emailSubject, body: emailBody, bcc: emailBcc }
          : undefined;
      const invoice = await sendInvoice(documentNumber, sendMethod, emailOptions);
      return confirmationResponse(
        `Faktura ${documentNumber} skickad via ${sendMethod}.`,
        invoice,
        invoiceConfirmColumns,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_bookkeep_invoice',
    'Bokför en faktura i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer att bokföra'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska bokföras'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att bokföra fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`bookkeep invoice ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`bookkeep invoice ${documentNumber}`);

      const invoice = await bookkeepInvoice(documentNumber);
      return confirmationResponse(
        `Faktura ${documentNumber} bokförd.`,
        invoice,
        invoiceConfirmColumns,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_credit_invoice',
    'Kreditera en faktura i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer att kreditera'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska krediteras'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att kreditera fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`credit invoice ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`credit invoice ${documentNumber}`);

      const invoice = await creditInvoice(documentNumber);
      return confirmationResponse(
        `Kreditfaktura skapad för faktura ${documentNumber}.`,
        invoice,
        invoiceConfirmColumns,
        includeRaw,
      );
    },
  );
}
