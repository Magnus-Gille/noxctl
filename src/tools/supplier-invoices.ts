import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  supplierInvoiceListColumns,
  supplierInvoiceDetailColumns,
  supplierInvoiceConfirmColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const SupplierInvoiceRowSchema = z.strictObject({
  Account: z.number().int().min(1000).max(9999).describe('Kontonummer (1000–9999)'),
  AccountDescription: z.string().optional().describe('Kontobeskrivning'),
  ArticleNumber: z.string().optional().describe('Artikelnummer'),
  Code: z
    .enum([
      'TOT',
      'VAT',
      'FRT',
      'AFE',
      'ROV',
      'CND',
      'CNC',
      'PRD',
      'PRC',
      'SRD',
      'SRC',
      'PRE',
      'GWB',
      'ACC',
    ])
    .optional()
    .describe('Radkod enligt Fortnox'),
  CostCenter: z.string().nullable().optional().describe('Kostnadsställe'),
  Debit: z.number().optional().describe('Debetbelopp'),
  DebitCurrency: z.number().optional().describe('Debetbelopp i fakturans valuta'),
  Credit: z.number().optional().describe('Kreditbelopp'),
  CreditCurrency: z.number().optional().describe('Kreditbelopp i fakturans valuta'),
  Description: z
    .string()
    .optional()
    .describe('Äldre kompatibilitetsfält för beskrivning; använd ItemDescription'),
  ItemDescription: z.string().optional().describe('Artikel- eller radbeskrivning'),
  Price: z.number().optional().describe('Pris per enhet'),
  Project: z.string().optional().describe('Projektnummer'),
  Quantity: z.number().int().optional().describe('Antal'),
  StockLocationCode: z.string().optional().describe('Lagerplatskod'),
  StockPointCode: z.string().optional().describe('Lagerställekod'),
  Total: z.number().nullable().optional().describe('Radens totalbelopp'),
  TransactionInformation: z
    .string()
    .max(100)
    .optional()
    .describe('Transaktionsinformation (max 100 tecken)'),
  Unit: z.string().optional().describe('Enhet'),
});

export function registerSupplierInvoiceTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listSupplierInvoices,
    getSupplierInvoice,
    createSupplierInvoice,
    bookkeepSupplierInvoice,
  } = operations;
  server.tool(
    'fortnox_list_supplier_invoices',
    'Lista leverantörsfakturor i Fortnox. Returnerar: GivenNumber, SupplierName, InvoiceDate, DueDate, Total, Balance.',
    {
      filter: z
        .enum(['fullypaid', 'cancelled', 'unpaid', 'unpaidoverdue', 'unbooked', 'pendingpayment'])
        .optional()
        .describe('Filter: fullypaid, cancelled, unpaid, unpaidoverdue, unbooked, pendingpayment'),
      supplierNumber: z.string().optional().describe('Filtrera på leverantörsnummer'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ filter, supplierNumber, fromDate, toDate, page, limit, all, includeRaw }) => {
      const data = await listSupplierInvoices({
        filter,
        supplierNumber,
        fromDate,
        toDate,
        page,
        limit,
        all,
      });
      return listResponse(
        data.SupplierInvoices ?? [],
        supplierInvoiceListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_supplier_invoice',
    'Hämta en enskild leverantörsfaktura från Fortnox. Returnerar: GivenNumber, SupplierNumber, SupplierName, InvoiceNumber, InvoiceDate, DueDate, Total, Balance, Currency, Booked, OCR, Comments.',
    {
      givenNumber: z.string().describe('Leverantörsfakturanummer (GivenNumber)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ givenNumber, includeRaw }) => {
      const data = await getSupplierInvoice(givenNumber);
      return detailResponse(data, supplierInvoiceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_supplier_invoice',
    'Skapa en leverantörsfaktura i Fortnox',
    {
      SupplierNumber: z.string().describe('Leverantörsnummer'),
      InvoiceNumber: z.string().optional().describe('Leverantörens fakturanummer'),
      InvoiceDate: z.string().optional().describe('Fakturadatum (YYYY-MM-DD)'),
      DueDate: z.string().optional().describe('Förfallodatum (YYYY-MM-DD)'),
      Total: z.number().optional().describe('Totalbelopp inkl. moms'),
      OCR: z.string().optional().describe('OCR-nummer'),
      Currency: z.string().optional().describe('Valutakod (default SEK)'),
      Comments: z.string().optional().describe('Kommentarer'),
      SupplierInvoiceRows: z
        .array(SupplierInvoiceRowSchema)
        .optional()
        .describe('Fakturarader med kontering, belopp och valfri artikel-/lagerinformation'),
      confirm: z.boolean().optional().describe('Bekräfta att leverantörsfakturan ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa leverantörsfakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create supplier invoice for supplier ${params.SupplierNumber}`, {
          SupplierInvoice: params,
        });
      }
      if (!confirm)
        requireConfirmation(`create supplier invoice for supplier ${params.SupplierNumber}`);

      const data = await createSupplierInvoice(params);
      return detailResponse(data, supplierInvoiceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_bookkeep_supplier_invoice',
    'Bokför en leverantörsfaktura i Fortnox',
    {
      givenNumber: z.string().describe('Leverantörsfakturanummer att bokföra'),
      confirm: z.boolean().optional().describe('Bekräfta att leverantörsfakturan ska bokföras'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle hända utan att bokföra'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ givenNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`bookkeep supplier invoice ${givenNumber}`);
      }
      if (!confirm) requireConfirmation(`bookkeep supplier invoice ${givenNumber}`);

      const data = await bookkeepSupplierInvoice(givenNumber);
      return detailResponse(data, supplierInvoiceConfirmColumns, data, includeRaw);
    },
  );
}
