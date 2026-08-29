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
import { invoiceListColumns, invoiceDetailColumns, invoiceConfirmColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const InvoiceRowSchema = z.strictObject({
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

/**
 * Write a PDF to `target`, refusing to write through a symlink.
 *
 * These paths come from tool arguments, i.e. they are model-generated and can be
 * influenced by whatever the model just read. `O_EXCL` already refuses to follow
 * a symlink; `O_NOFOLLOW` gives the overwrite path the same guarantee, so
 * "replace this file" can never silently truncate a symlink's target instead.
 * O_NOFOLLOW is POSIX-only, so Windows falls back to an explicit lstat check.
 */
function writePdf(target: string, pdf: Buffer, overwrite?: boolean): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fsConstants;
  const flags = overwrite
    ? O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW ?? 0)
    : O_WRONLY | O_CREAT | O_EXCL;

  // Windows has no O_NOFOLLOW, so the flag above degrades to a no-op there.
  // Check explicitly instead. This is a TOCTOU-racy fallback rather than an
  // atomic guarantee, but it closes the ordinary case on the one platform the
  // kernel flag cannot cover.
  if (overwrite && !O_NOFOLLOW && lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link. Refusing to write through it — pass the real path instead.`,
    );
  }

  try {
    const fd = openSync(target, flags, 0o600);
    try {
      // writeSync may return a short count; keep going until the whole buffer
      // has landed. writeFileSync used to do this loop internally.
      let written = 0;
      while (written < pdf.length) {
        written += writeSync(fd, pdf, written, pdf.length - written);
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

export function registerInvoiceTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    sendInvoice,
    getInvoicePdf,
    markInvoicePrinted,
    bookkeepInvoice,
    creditInvoice,
  } = operations;
  server.tool(
    'fortnox_list_invoices',
    'Lista/filtrera fakturor i Fortnox. Returnerar: DocumentNumber, CustomerName, InvoiceDate, DueDate, Total, Balance.',
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
    'Hämta en enskild faktura från Fortnox. Returnerar: DocumentNumber, CustomerNumber, CustomerName, InvoiceDate, DueDate, Total, Balance, Currency, Booked, Sent, OurReference, InvoiceRows.',
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
          z.strictObject({
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
    'fortnox_invoice_pdf',
    'Hämta en faktura som PDF och spara den på disk. Returnerar sökvägen till filen (inte PDF-innehållet). PDF:en hämtas alltid via Fortnox /preview, vilket INTE ändrar fakturan. Med markSent anropas /print efteråt, efter att filen skrivits.',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      outputPath: z
        .string()
        .optional()
        .describe(
          'Sökväg att spara PDF:en till. Skriver inte över en befintlig fil om inte overwrite är satt. Utelämnas: en ny privat temp-katalog används.',
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe('Tillåt att en befintlig fil på outputPath skrivs över'),
      markSent: z
        .boolean()
        .optional()
        .describe('Markera även fakturan som skickad i Fortnox (använder /print)'),
      confirm: z
        .boolean()
        .optional()
        .describe('Bekräfta — krävs endast när markSent är satt, eftersom den ändrar fakturan'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att hämta PDF:en'),
    },
    async ({ documentNumber, outputPath, overwrite, markSent, confirm, dryRun }) => {
      const action = markSent
        ? `download invoice ${documentNumber} as PDF and mark it as sent`
        : `download invoice ${documentNumber} as PDF`;
      if (dryRun) return dryRunResponse(action);
      // Only the /print variant changes the invoice; a plain download is read-only.
      if (markSent && !confirm) requireConfirmation(action);

      // Arguments here are agent-generated, so a stray path must not silently
      // truncate an existing file. Without an explicit path we use a fresh
      // private directory rather than a predictable, clobber-prone temp name.
      const target = outputPath
        ? resolve(outputPath)
        : join(mkdtempSync(join(tmpdir(), 'noxctl-')), `invoice-${documentNumber}.pdf`);

      const pdf = await getInvoicePdf(documentNumber);
      writePdf(target, pdf, overwrite);

      // Only now that the PDF is safely on disk do we change anything in Fortnox.
      // If that fails, the download still succeeded — say so, or the caller has
      // no idea a usable file is sitting there.
      let printed;
      if (markSent) {
        try {
          printed = await markInvoicePrinted(documentNumber);
        } catch (err) {
          throw new Error(
            `Faktura ${documentNumber} sparades som PDF: ${target} (${pdf.length} bytes), men kunde inte markeras som skickad: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Prefer the document /print actually produced, so the saved copy matches
      // the version that was marked as sent. Best-effort: the /preview copy is
      // already on disk, and the invoice is already flagged, so a failure here
      // must not be raised as if the whole operation failed.
      let bytes = pdf.length;
      let refreshNote = '';
      if (printed?.pdf) {
        try {
          writePdf(target, printed.pdf, true);
          bytes = printed.pdf.length;
        } catch (err) {
          refreshNote = ` Den sparade filen är /preview-versionen; kunde inte skriva om den med den utskrivna versionen: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }

      // Only state that the invoice is sent if Fortnox confirmed it. Asking for
      // markSent is not evidence that it took effect.
      let sentNote = '';
      if (printed && !printed.confirmed) {
        sentNote = ` ${String(printed.invoice.Note)}`;
      } else if (printed && printed.invoice.Sent === true) {
        sentNote = ' Fakturan är nu markerad som skickad.';
      } else if (printed) {
        sentNote = ' Varning: Fortnox rapporterar fortfarande fakturan som ej skickad.';
      }

      return confirmationResponse(
        `Faktura ${documentNumber} sparad som PDF: ${target} (${bytes} bytes).` +
          sentNote +
          refreshNote,
        {
          DocumentNumber: documentNumber,
          Path: target,
          Bytes: bytes,
          // Report what Fortnox says, not what we asked for; undefined means
          // "not checked" or "could not be confirmed".
          Sent: printed?.confirmed ? printed.invoice.Sent : undefined,
        },
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
