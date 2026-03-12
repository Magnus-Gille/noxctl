import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fortnoxRequest } from '../fortnox-client.js';

interface InvoiceResponse {
  Invoice: Record<string, unknown>;
}

interface InvoicesResponse {
  Invoices: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

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
    },
    async ({ filter, customerNumber, fromDate, toDate, page, limit }) => {
      const data = await fortnoxRequest<InvoicesResponse>('invoices', {
        params: {
          filter,
          customernumber: customerNumber,
          fromdate: fromDate,
          todate: toDate,
          page: page || 1,
          limit: limit || 100,
        },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'fortnox_get_invoice',
    'Hämta en enskild faktura från Fortnox',
    {
      documentNumber: z.string().describe('Fakturanummer'),
    },
    async ({ documentNumber }) => {
      const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentNumber}`);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data.Invoice, null, 2) }],
      };
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
    },
    async (params) => {
      const data = await fortnoxRequest<InvoiceResponse>('invoices', {
        method: 'POST',
        body: { Invoice: params },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data.Invoice, null, 2) }],
      };
    },
  );

  server.tool(
    'fortnox_send_invoice',
    'Skicka en faktura via e-post (eller markera för utskrift)',
    {
      documentNumber: z.string().describe('Fakturanummer'),
      method: z
        .enum(['email', 'print', 'einvoice'])
        .optional()
        .describe('Sändmetod (default: email)'),
    },
    async ({ documentNumber, method }) => {
      const sendMethod = method || 'email';
      const endpoint =
        sendMethod === 'email'
          ? `invoices/${documentNumber}/email`
          : sendMethod === 'einvoice'
            ? `invoices/${documentNumber}/einvoice`
            : `invoices/${documentNumber}/print`;

      const data = await fortnoxRequest<InvoiceResponse>(endpoint, {
        method: 'PUT',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Faktura ${documentNumber} skickad via ${sendMethod}.\n${JSON.stringify(data?.Invoice || {}, null, 2)}`,
          },
        ],
      };
    },
  );

  server.tool(
    'fortnox_bookkeep_invoice',
    'Bokför en faktura i Fortnox',
    {
      documentNumber: z.string().describe('Fakturanummer att bokföra'),
    },
    async ({ documentNumber }) => {
      const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentNumber}/bookkeep`, {
        method: 'PUT',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Faktura ${documentNumber} bokförd.\n${JSON.stringify(data?.Invoice || {}, null, 2)}`,
          },
        ],
      };
    },
  );

  server.tool(
    'fortnox_credit_invoice',
    'Kreditera en faktura i Fortnox',
    {
      documentNumber: z.string().describe('Fakturanummer att kreditera'),
    },
    async ({ documentNumber }) => {
      const data = await fortnoxRequest<InvoiceResponse>(`invoices/${documentNumber}/credit`, {
        method: 'PUT',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Kreditfaktura skapad för faktura ${documentNumber}.\n${JSON.stringify(data?.Invoice || {}, null, 2)}`,
          },
        ],
      };
    },
  );
}
