import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  openSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  supplierInvoiceListColumns,
  supplierInvoiceDetailColumns,
  supplierInvoiceConfirmColumns,
  supplierInvoiceAttachmentColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

/**
 * Write a downloaded file to `target`, refusing to write through a symlink.
 * Mirrors writeBinaryFile() in tools/bookkeeping.ts — see that copy for the
 * rationale (paths here are model-generated tool arguments, so this closes
 * off a symlink-overwrite path).
 */
function writeBinaryFile(target: string, data: Buffer, overwrite?: boolean): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fsConstants;
  const flags = overwrite
    ? O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0)
    : O_WRONLY | O_CREAT | O_EXCL;

  if (overwrite && !O_NOFOLLOW && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link. Refusing to write through it — pass the real path instead.`,
    );
  }

  try {
    const fd = openSync(target, flags, 0o600);
    try {
      let written = 0;
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `${target} already exists. Pass a different outputPath, or overwrite: true to replace it.`,
      );
    }
    if (code === 'ELOOP') {
      throw new Error(
        `${target} is a symbolic link. Refusing to write through it — pass the real path instead.`,
      );
    }
    throw err;
  }
}

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
    listSupplierInvoiceAttachments,
    getSupplierInvoiceFile,
    extensionForMime,
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

  server.tool(
    'fortnox_list_supplier_invoice_attachments',
    'Lista filer (t.ex. den inskannade/mottagna fakturan) som är kopplade till en leverantörsfaktura i Fortnox. Fungerar även för obokförda och ej godkända fakturor (unbooked/authorizepending) — till skillnad från verifikationsbilagor, som bara finns tillgängliga efter bokföring. Returnerar: File (filnamn), File ID. Använd fileId med fortnox_get_supplier_invoice_file för att hämta själva filen.',
    {
      givenNumber: z.string().describe('Leverantörsfakturanummer (GivenNumber)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ givenNumber, includeRaw }) => {
      const attachments = await listSupplierInvoiceAttachments(givenNumber);
      return listResponse(
        attachments as unknown as Record<string, unknown>[],
        supplierInvoiceAttachmentColumns,
        attachments,
        undefined,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_supplier_invoice_file',
    'Ladda ner en fil som är kopplad till en leverantörsfaktura och spara den på disk. Returnerar sökvägen till filen (inte filinnehållet). Hämta fileId via fortnox_list_supplier_invoice_attachments.',
    {
      fileId: z.string().describe('Fil-ID, från fortnox_list_supplier_invoice_attachments'),
      outputPath: z
        .string()
        .optional()
        .describe(
          'Sökväg att spara filen till. Skriver inte över en befintlig fil om inte overwrite är satt. Utelämnas: en ny privat temp-katalog används.',
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe('Tillåt att en befintlig fil på outputPath skrivs över'),
    },
    async ({ fileId, outputPath, overwrite }) => {
      const file = await getSupplierInvoiceFile(fileId);
      const ext = extensionForMime(file.contentType);
      const target = outputPath
        ? resolve(outputPath)
        : join(mkdtempSync(join(tmpdir(), 'noxctl-')), `supplier-invoice-file-${fileId}${ext}`);
      writeBinaryFile(target, file.buffer, overwrite);
      return textResponse(
        `Sparade fil (${file.contentType}, ${file.buffer.length} bytes) till ${target}`,
      );
    },
  );
}
