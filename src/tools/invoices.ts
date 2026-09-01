import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { privateOutputPath, writeBinaryFile } from '../safe-file-output.js';
import {
  invoiceListColumns,
  invoiceDetailColumns,
  invoiceConfirmColumns,
  invoiceAttachmentListColumns,
} from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

const InvoiceRowSchema = z.strictObject({
  AccountNumber: z.number().int().min(1000).max(9999).optional().describe('Kontonummer'),
  ArticleNumber: z.string().optional().describe('Artikelnummer'),
  Cost: z.number().min(-9_999_999_999).max(9_999_999_999).nullable().optional().describe('Kostnad'),
  CostCenter: z.string().nullable().optional().describe('Kostnadsställe'),
  DeliveredQuantity: z
    .union([z.string(), z.number()])
    .describe('Levererat antal (nummer eller decimalsträng)'),
  Description: z.string().max(255).describe('Beskrivning (max 255 tecken)'),
  Discount: z.number().optional().describe('Rabattvärde'),
  DiscountType: z.enum(['AMOUNT', 'PERCENT']).optional().describe('Rabatttyp'),
  HouseWork: z.boolean().optional().describe('Markera raden som husarbete (ROT/RUT)'),
  HouseWorkHoursToReport: z
    .number()
    .int()
    .min(0)
    .max(999)
    .nullable()
    .optional()
    .describe('Timmar att rapportera för husarbete (0–999)'),
  HouseWorkType: z
    .enum([
      'CONSTRUCTION',
      'ELECTRICITY',
      'GLASSMETALWORK',
      'GROUNDDRAINAGEWORK',
      'MASONRY',
      'PAINTINGWALLPAPERING',
      'HVAC',
      'MAJORAPPLIANCEREPAIR',
      'MOVINGSERVICES',
      'ITSERVICES',
      'CLEANING',
      'TEXTILECLOTHING',
      'SNOWPLOWING',
      'GARDENING',
      'BABYSITTING',
      'OTHERCARE',
      'OTHERCOSTS',
      'SOLARCELLS',
      'STORAGESELFPRODUCEDELECTRICITY',
      'CHARGINGSTATIONELECTRICVEHICLE',
      'HOMEMAINTENANCE',
      'FURNISHING',
      'TRANSPORTATIONSERVICES',
      'WASHINGANDCAREOFCLOTHING',
    ])
    .optional()
    .describe('Typ av husarbete'),
  Price: z.number().describe('Pris per enhet (exkl. moms)'),
  Project: z.string().optional().describe('Projektnummer'),
  RowId: z.number().int().optional().describe('Rad-id'),
  StockPointCode: z.string().optional().describe('Lagerställekod'),
  Unit: z.string().max(20).optional().describe('Enhet (max 20 tecken)'),
  VAT: z.number().int().optional().describe('Momssats i procent (default: 25)'),
  VATCode: z.string().optional().describe('Momskod'),
});

const DocumentNumberSchema = z.string().regex(/^\d+$/, 'Document number must be numeric');

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
    cancelInvoice,
    externalPrintInvoice,
    eprintInvoice,
    getInvoiceReminderPdf,
    attachInvoiceFiles,
    listInvoiceAttachments,
    createDocumentAttachment,
    listDocumentAttachments,
    getAttachmentCounts,
    validateAttachmentsOnSend,
    updateDocumentAttachment,
    detachDocumentAttachment,
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
        .array(InvoiceRowSchema.partial())
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
      const pdf = await getInvoicePdf(documentNumber);
      const target = writeBinaryFile(
        outputPath ?? privateOutputPath('noxctl-', `invoice-${documentNumber}.pdf`),
        pdf,
        overwrite,
      );

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
          writeBinaryFile(target, printed.pdf, true);
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

  const invoiceActions = [
    {
      name: 'fortnox_cancel_invoice',
      description: 'Makulera en faktura i Fortnox',
      verb: 'cancel',
      message: 'makulerad',
      execute: cancelInvoice,
    },
    {
      name: 'fortnox_eprint_invoice',
      description: 'Skicka en faktura via Fortnox e-print',
      verb: 'e-print',
      message: 'skickad via e-print',
      execute: eprintInvoice,
    },
    {
      name: 'fortnox_external_print_invoice',
      description: 'Markera en faktura som externt utskriven i Fortnox',
      verb: 'external print',
      message: 'markerad som externt utskriven',
      execute: externalPrintInvoice,
    },
  ] as const;
  for (const action of invoiceActions) {
    server.tool(
      action.name,
      action.description,
      {
        documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
        confirm: z.boolean().optional().describe('Bekräfta åtgärden'),
        dryRun: z.boolean().optional().describe('Visa åtgärden utan att utföra den'),
        includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
      },
      async ({ documentNumber, confirm, dryRun, includeRaw }) => {
        const target = `${action.verb} invoice ${documentNumber}`;
        if (dryRun) return dryRunResponse(target);
        if (!confirm) requireConfirmation(target);
        const invoice = await action.execute(documentNumber);
        return confirmationResponse(
          `Faktura ${documentNumber} ${action.message}.`,
          invoice,
          invoiceConfirmColumns,
          includeRaw,
        );
      },
    );
  }

  server.tool(
    'fortnox_invoice_reminder_pdf',
    'Skapa en påminnelseutskrift för en faktura och spara PDF:en på disk',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      outputPath: z.string().optional().describe('Målsökväg; utelämna för privat tempkatalog'),
      overwrite: z.boolean().optional().describe('Tillåt överskrivning av vanlig fil'),
      confirm: z.boolean().optional().describe('Bekräfta påminnelseutskriften'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att skriva ut'),
    },
    async ({ documentNumber, outputPath, overwrite, confirm, dryRun }) => {
      const action = `print reminder for invoice ${documentNumber}`;
      if (dryRun) return dryRunResponse(action);
      if (!confirm) requireConfirmation(action);
      const pdf = await getInvoiceReminderPdf(documentNumber);
      if (!pdf) {
        return confirmationResponse(
          `Påminnelseutskrift utförd för faktura ${documentNumber}; Fortnox returnerade ingen PDF.`,
          {},
        );
      }
      const target = writeBinaryFile(
        outputPath ?? privateOutputPath('noxctl-', `invoice-reminder-${documentNumber}.pdf`),
        pdf,
        overwrite,
      );
      return confirmationResponse(
        `Påminnelse för faktura ${documentNumber} sparad som PDF: ${target}.`,
        { DocumentNumber: documentNumber, Path: target, Bytes: pdf.length },
      );
    },
  );

  server.tool(
    'fortnox_attach_invoice_files',
    'Ladda upp kvitto/underlagsfiler och koppla dem till en kundfaktura i Fortnox. Kräver "archive"-behörigheten (noxctl init --with-archive).',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      files: z.array(z.string()).describe('Sökvägar till filer som ska laddas upp och kopplas'),
      includeOnSend: z
        .boolean()
        .optional()
        .describe('Bunta med filen när fakturan skickas (default: true)'),
      confirm: z.boolean().optional().describe('Bekräfta att filerna ska kopplas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att ladda upp filerna'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, files, includeOnSend, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`attach ${files.length} file(s) to invoice ${documentNumber}`, {
          documentNumber,
          files,
          includeOnSend: includeOnSend ?? true,
        });
      }
      if (!confirm) {
        requireConfirmation(`attach ${files.length} file(s) to invoice ${documentNumber}`);
      }
      const results = await attachInvoiceFiles({
        documentNumber,
        filePaths: files,
        includeOnSend,
      });
      const ids = results.map((r) => r.fileId).join(', ');
      const summary = `Kopplade ${results.length} fil(er) till faktura ${documentNumber}. Fil-ID: ${ids}`;
      return textResponse(
        includeRaw ? `${summary}\n\n${JSON.stringify(results, null, 2)}` : summary,
      );
    },
  );

  server.tool(
    'fortnox_list_invoice_attachments',
    'Lista filer som är kopplade till en kundfaktura i Fortnox.',
    {
      documentNumber: DocumentNumberSchema.describe('Fakturanummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, includeRaw }) => {
      const results = await listInvoiceAttachments(documentNumber);
      return listResponse(
        results as unknown as Record<string, unknown>[],
        invoiceAttachmentListColumns,
        results,
        undefined,
        includeRaw,
      );
    },
  );

  const AttachmentEntityType = z.enum(['F', 'OF', 'O', 'C']);
  const AttachmentFields = {
    entityId: z.number().int().optional(),
    entityType: AttachmentEntityType.optional(),
    fileId: z.string().optional(),
    id: z.string().uuid().optional(),
    includeOnSend: z.boolean().optional(),
  };

  server.tool(
    'fortnox_create_document_attachment',
    'Koppla en befintlig arkivfil till en faktura, offert, order eller ett avtal i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Dokumentnummer'),
      entityType: AttachmentEntityType.describe('F=faktura, OF=offert, O=order, C=avtal'),
      fileId: z.string().min(1).describe('Arkivfilens ID'),
      includeOnSend: z.boolean().optional().describe('Bifoga filen när dokumentet skickas'),
      confirm: z.boolean().optional().describe('Bekräfta kopplingen'),
      dryRun: z.boolean().optional().describe('Visa kopplingen utan att utföra den'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, entityType, fileId, includeOnSend, confirm, dryRun, includeRaw }) => {
      const target = `attach archive file ${fileId} to ${entityType} document ${documentNumber}`;
      const body = { documentNumber, entityType, fileId, includeOnSend: includeOnSend ?? true };
      if (dryRun) return dryRunResponse(target, body);
      if (!confirm) requireConfirmation(target);
      const attachment = await createDocumentAttachment(
        documentNumber,
        entityType,
        fileId,
        includeOnSend ?? true,
      );
      return confirmationResponse(
        'Bilagan kopplades till dokumentet.',
        attachment,
        undefined,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_list_document_attachments',
    'Lista bilagor för en offert, order eller ett avtal i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Dokumentnummer'),
      entityType: z.enum(['OF', 'O', 'C']).describe('OF=offert, O=order, C=avtal'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, entityType, includeRaw }) => {
      const attachments = await listDocumentAttachments(documentNumber, entityType);
      return listResponse(
        attachments,
        invoiceAttachmentListColumns,
        attachments,
        undefined,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_attachment_counts',
    'Hämta antal bilagor för dokument i Fortnox',
    {
      entityIds: z.array(z.number().int()).min(1).describe('Dokument-ID:n'),
      entityType: AttachmentEntityType.describe('Dokumenttyp'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ entityIds, entityType, includeRaw }) => {
      const counts = await getAttachmentCounts(entityIds, entityType);
      return detailResponse(counts, invoiceAttachmentListColumns, counts, includeRaw);
    },
  );

  server.tool(
    'fortnox_validate_attachments_on_send',
    'Validera att valda bilagor kan inkluderas när ett dokument skickas från Fortnox',
    {
      attachments: z.array(z.strictObject(AttachmentFields)).min(1),
      confirm: z.boolean().optional().describe('Bekräfta valideringsanropet'),
      dryRun: z.boolean().optional().describe('Visa exakt payload utan att anropa Fortnox'),
    },
    async ({ attachments, confirm, dryRun }) => {
      const target = 'validate attachments included on send';
      if (dryRun) return dryRunResponse(target, attachments);
      if (!confirm) requireConfirmation(target);
      await validateAttachmentsOnSend(attachments);
      return textResponse('Fortnox accepted the attachment send validation.');
    },
  );

  server.tool(
    'fortnox_update_document_attachment',
    'Uppdatera metadata för en dokumentbilaga i Fortnox',
    {
      attachmentId: z.string().uuid().describe('Bilagans ID'),
      ...AttachmentFields,
      confirm: z.boolean().optional().describe('Bekräfta uppdateringen'),
      dryRun: z.boolean().optional().describe('Visa exakt payload utan att uppdatera'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ attachmentId, confirm, dryRun, includeRaw, ...fields }) => {
      const target = `update attachment ${attachmentId}`;
      if (dryRun) return dryRunResponse(target, fields);
      if (!confirm) requireConfirmation(target);
      const attachment = await updateDocumentAttachment(attachmentId, fields);
      return detailResponse(attachment, invoiceAttachmentListColumns, attachment, includeRaw);
    },
  );

  server.tool(
    'fortnox_detach_document_attachment',
    'Koppla loss en dokumentbilaga i Fortnox utan att hämta fjärr-URL:er',
    {
      attachmentId: z.string().uuid().describe('Bilagans ID'),
      confirm: z.boolean().optional().describe('Bekräfta bortkopplingen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att koppla loss'),
    },
    async ({ attachmentId, confirm, dryRun }) => {
      const target = `detach attachment ${attachmentId}`;
      if (dryRun) return dryRunResponse(target);
      if (!confirm) requireConfirmation(target);
      await detachDocumentAttachment(attachmentId);
      return textResponse(`Attachment ${attachmentId} detached.`);
    },
  );
}
