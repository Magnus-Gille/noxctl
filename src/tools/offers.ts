import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listOffers,
  getOffer,
  createOffer,
  updateOffer,
  createInvoiceFromOffer,
  createOrderFromOffer,
} from '../operations/offers.js';
import { offerListColumns, offerDetailColumns, offerConfirmColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const OfferRowSchema = z.object({
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

export function registerOfferTools(server: McpServer): void {
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
        .array(
          z.object({
            ArticleNumber: z.string().optional().describe('Artikelnummer'),
            Description: z.string().optional().describe('Beskrivning'),
            DeliveredQuantity: z.number().optional().describe('Antal'),
            Price: z.number().optional().describe('Pris per enhet (exkl. moms)'),
            AccountNumber: z.number().optional().describe('Kontonummer'),
            VAT: z.number().optional().describe('Momssats i procent'),
            Unit: z.string().optional().describe('Enhet'),
            Discount: z.number().optional().describe('Rabatt i procent'),
          }),
        )
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
}
