import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { privateOutputPath, writeBinaryFile } from '../safe-file-output.js';
import { offerListColumns, offerDetailColumns, offerConfirmColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const OfferRowSchema = z.strictObject({
  AccountNumber: z.number().int().optional().describe('Kontonummer'),
  ArticleNumber: z.string().optional().describe('Artikelnummer'),
  ContributionPercent: z.string().optional().describe('Täckningsgrad i procent'),
  ContributionValue: z.string().optional().describe('Täckningsbidrag'),
  CostCenter: z.string().nullable().optional().describe('Kostnadsställe'),
  Description: z.string().max(255).describe('Beskrivning (max 255 tecken)'),
  DeliveredQuantity: z.number().describe('Antal (kompatibilitetsfält)'),
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
      'CLEANING',
      'TEXTILECLOTHING',
      'COOKING',
      'SNOWPLOWING',
      'GARDENING',
      'BABYSITTING',
      'OTHERCARE',
      'TUTORING',
      'OTHERCOSTS',
    ])
    .optional()
    .describe('Typ av husarbete'),
  Price: z.number().describe('Pris per enhet (exkl. moms)'),
  Project: z.string().optional().describe('Projektnummer'),
  Quantity: z.string().optional().describe('Antal enligt Fortnox offertradskontrakt'),
  RowId: z.number().int().optional().describe('Rad-id'),
  Total: z.number().nullable().optional().describe('Radsumma'),
  Unit: z.string().max(20).optional().describe('Enhet (max 20 tecken)'),
  VAT: z.number().int().optional().describe('Momssats i procent (default: 25)'),
  VATCode: z.string().optional().describe('Momskod'),
});

const DocumentNumberSchema = z.string().regex(/^\d+$/, 'Document number must be numeric');

export function registerOfferTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listOffers,
    getOffer,
    createOffer,
    updateOffer,
    createInvoiceFromOffer,
    createOrderFromOffer,
    cancelOffer,
    emailOffer,
    externalPrintOffer,
    getOfferPdf,
  } = operations;
  server.tool(
    'fortnox_list_offers',
    'Lista/filtrera offerter i Fortnox. Returnerar: DocumentNumber, CustomerName, OfferDate, ExpireDate, Total.',
    {
      filter: z
        .enum(['cancelled', 'expired', 'ordercreated', 'invoicecreated'])
        .optional()
        .describe('Filtrera offerter'),
      customerNumber: z.string().optional().describe('Filtrera på kundnummer'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listOffers(params);
      return listResponse(
        data.Offers ?? [],
        offerListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_offer',
    'Hämta en enskild offert från Fortnox. Returnerar: DocumentNumber, CustomerNumber, CustomerName, OfferDate, ExpireDate, Total, Currency, OurReference, OfferRows.',
    {
      documentNumber: DocumentNumberSchema.describe('Offertnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, includeRaw }) => {
      const offer = await getOffer(documentNumber);
      return detailResponse(offer, offerDetailColumns, offer, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_offer',
    'Skapa en offert i Fortnox',
    {
      CustomerNumber: z.string().describe('Kundnummer'),
      OfferRows: z.array(OfferRowSchema).describe('Offertrader'),
      ExpireDate: z.string().optional().describe('Utgångsdatum (YYYY-MM-DD)'),
      OfferDate: z.string().optional().describe('Offertdatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod (default: SEK)'),
      confirm: z.boolean().optional().describe('Bekräfta att offerten ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa offerten'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create offer for customer ${params.CustomerNumber}`, {
          Offer: params,
        });
      }
      if (!confirm) requireConfirmation(`create offer for customer ${params.CustomerNumber}`);

      const offer = await createOffer(params);
      return detailResponse(offer, offerDetailColumns, offer, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_offer',
    'Uppdatera en befintlig offert i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Offertnummer att uppdatera'),
      CustomerNumber: z.string().optional().describe('Kundnummer'),
      OfferRows: z
        .array(OfferRowSchema.partial())
        .optional()
        .describe('Offertrader (ersätter alla befintliga rader)'),
      ExpireDate: z.string().optional().describe('Utgångsdatum (YYYY-MM-DD)'),
      OfferDate: z.string().optional().describe('Offertdatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod'),
      confirm: z.boolean().optional().describe('Bekräfta att offerten ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera offerten'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update offer ${documentNumber}`, { Offer: fields });
      }
      if (!confirm) requireConfirmation(`update offer ${documentNumber}`);

      const offer = await updateOffer(documentNumber, fields);
      return detailResponse(offer, offerDetailColumns, offer, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_invoice_from_offer',
    'Skapa en faktura från en offert i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Offertnummer'),
      confirm: z.boolean().optional().describe('Bekräfta att faktura ska skapas från offerten'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att skapa fakturan'),
    },
    async ({ documentNumber, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`create invoice from offer ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`create invoice from offer ${documentNumber}`);

      const invoice = await createInvoiceFromOffer(documentNumber);
      return confirmationResponse(
        `Faktura skapad från offert ${documentNumber}. Fakturanummer: ${invoice.DocumentNumber}`,
        invoice,
        offerConfirmColumns,
      );
    },
  );

  server.tool(
    'fortnox_create_order_from_offer',
    'Skapa en order från en offert i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Offertnummer'),
      confirm: z.boolean().optional().describe('Bekräfta att order ska skapas från offerten'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att skapa ordern'),
    },
    async ({ documentNumber, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`create order from offer ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`create order from offer ${documentNumber}`);

      const order = await createOrderFromOffer(documentNumber);
      return confirmationResponse(
        `Order skapad från offert ${documentNumber}. Ordernummer: ${order.DocumentNumber}`,
        order,
        offerConfirmColumns,
      );
    },
  );

  const offerActions = [
    {
      name: 'fortnox_cancel_offer',
      description: 'Makulera en offert i Fortnox',
      verb: 'cancel',
      message: 'makulerad',
      execute: cancelOffer,
    },
    {
      name: 'fortnox_email_offer',
      description: 'Skicka en offert via e-post från Fortnox',
      verb: 'email',
      message: 'skickad via e-post',
      execute: emailOffer,
    },
    {
      name: 'fortnox_external_print_offer',
      description: 'Markera en offert som externt utskriven i Fortnox',
      verb: 'external print',
      message: 'markerad som externt utskriven',
      execute: externalPrintOffer,
    },
  ] as const;
  for (const action of offerActions) {
    server.tool(
      action.name,
      action.description,
      {
        documentNumber: DocumentNumberSchema.describe('Offertnummer'),
        confirm: z.boolean().optional().describe('Bekräfta åtgärden'),
        dryRun: z.boolean().optional().describe('Visa åtgärden utan att utföra den'),
        includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
      },
      async ({ documentNumber, confirm, dryRun, includeRaw }) => {
        const target = `${action.verb} offer ${documentNumber}`;
        if (dryRun) return dryRunResponse(target);
        if (!confirm) requireConfirmation(target);
        const offer = await action.execute(documentNumber);
        return confirmationResponse(
          `Offert ${documentNumber} ${action.message}.`,
          offer,
          offerConfirmColumns,
          includeRaw,
        );
      },
    );
  }

  server.tool(
    'fortnox_offer_pdf',
    'Hämta en offert som PDF och spara den säkert på disk',
    {
      documentNumber: DocumentNumberSchema.describe('Offertnummer'),
      mode: z
        .enum(['preview', 'print'])
        .optional()
        .describe('preview är läsning; print ändrar status'),
      outputPath: z.string().optional().describe('Målsökväg; utelämna för privat tempkatalog'),
      overwrite: z.boolean().optional().describe('Tillåt överskrivning av vanlig fil'),
      confirm: z.boolean().optional().describe('Bekräfta print-åtgärden'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att hämta PDF'),
    },
    async ({ documentNumber, mode = 'preview', outputPath, overwrite, confirm, dryRun }) => {
      const action = `${mode} offer ${documentNumber} as PDF`;
      if (dryRun) return dryRunResponse(action);
      if (mode === 'print' && !confirm) requireConfirmation(action);
      const pdf = await getOfferPdf(documentNumber, mode);
      if (!pdf)
        return confirmationResponse(
          `Offert ${documentNumber} utskriven; Fortnox returnerade ingen PDF.`,
          {},
        );
      const target = writeBinaryFile(
        outputPath ?? privateOutputPath('noxctl-', `offer-${documentNumber}.pdf`),
        pdf,
        overwrite,
      );
      return confirmationResponse(`Offert ${documentNumber} sparad som PDF: ${target}.`, {
        DocumentNumber: documentNumber,
        Path: target,
        Bytes: pdf.length,
        Mode: mode,
      });
    },
  );
}
