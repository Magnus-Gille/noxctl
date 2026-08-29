import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { orderListColumns, orderDetailColumns, orderConfirmColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const OrderRowSchema = z.strictObject({
  AccountNumber: z.number().int().optional().describe('Kontonummer'),
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
  OrderedQuantity: z.string().optional().describe('Beställt antal enligt Fortnox'),
  Price: z.number().describe('Pris per enhet (exkl. moms)'),
  Project: z.string().optional().describe('Projektnummer'),
  StockPointCode: z.string().optional().describe('Lagerställekod'),
  StockPointId: z.string().optional().describe('Lagerställe-id'),
  Unit: z.string().max(20).optional().describe('Enhet (max 20 tecken)'),
  VAT: z.number().optional().describe('Momssats i procent (default: 25)'),
  VATCode: z.string().optional().describe('Momskod'),
});

const DocumentNumberSchema = z.string().regex(/^\d+$/, 'Document number must be numeric');

export function registerOrderTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { listOrders, getOrder, createOrder, updateOrder, createInvoiceFromOrder } = operations;
  server.tool(
    'fortnox_list_orders',
    'Lista/filtrera ordrar i Fortnox. Returnerar: DocumentNumber, CustomerName, OrderDate, DeliveryDate, Total.',
    {
      filter: z
        .enum(['cancelled', 'invoicecreated', 'invoicenotcreated'])
        .optional()
        .describe('Filtrera ordrar'),
      customerNumber: z.string().optional().describe('Filtrera på kundnummer'),
      fromDate: z.string().optional().describe('Från datum (YYYY-MM-DD)'),
      toDate: z.string().optional().describe('Till datum (YYYY-MM-DD)'),
      page: z.number().optional().describe('Sidnummer'),
      limit: z.number().optional().describe('Antal per sida'),
      all: z.boolean().optional().describe('Hämta alla sidor'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listOrders(params);
      return listResponse(
        data.Orders ?? [],
        orderListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_order',
    'Hämta en enskild order från Fortnox. Returnerar: DocumentNumber, CustomerNumber, CustomerName, OrderDate, DeliveryDate, Total, Currency, OurReference, OrderRows.',
    {
      documentNumber: DocumentNumberSchema.describe('Ordernummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, includeRaw }) => {
      const order = await getOrder(documentNumber);
      return detailResponse(order, orderDetailColumns, order, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_order',
    'Skapa en order i Fortnox',
    {
      CustomerNumber: z.string().describe('Kundnummer'),
      OrderRows: z.array(OrderRowSchema).describe('Orderrader'),
      DeliveryDate: z.string().optional().describe('Leveransdatum (YYYY-MM-DD)'),
      OrderDate: z.string().optional().describe('Orderdatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod (default: SEK)'),
      confirm: z.boolean().optional().describe('Bekräfta att ordern ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa ordern'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create order for customer ${params.CustomerNumber}`, {
          Order: params,
        });
      }
      if (!confirm) requireConfirmation(`create order for customer ${params.CustomerNumber}`);

      const order = await createOrder(params);
      return detailResponse(order, orderDetailColumns, order, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_order',
    'Uppdatera en befintlig order i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Ordernummer att uppdatera'),
      CustomerNumber: z.string().optional().describe('Kundnummer'),
      OrderRows: z
        .array(OrderRowSchema.partial())
        .optional()
        .describe('Orderrader (ersätter alla befintliga rader)'),
      DeliveryDate: z.string().optional().describe('Leveransdatum (YYYY-MM-DD)'),
      OrderDate: z.string().optional().describe('Orderdatum (YYYY-MM-DD)'),
      OurReference: z.string().optional().describe('Vår referens'),
      YourReference: z.string().optional().describe('Er referens'),
      Remarks: z.string().optional().describe('Anmärkning/kommentar'),
      Currency: z.string().optional().describe('Valutakod'),
      confirm: z.boolean().optional().describe('Bekräfta att ordern ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera ordern'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update order ${documentNumber}`, { Order: fields });
      }
      if (!confirm) requireConfirmation(`update order ${documentNumber}`);

      const order = await updateOrder(documentNumber, fields);
      return detailResponse(order, orderDetailColumns, order, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_invoice_from_order',
    'Skapa en faktura från en order i Fortnox',
    {
      documentNumber: DocumentNumberSchema.describe('Ordernummer'),
      confirm: z.boolean().optional().describe('Bekräfta att faktura ska skapas från ordern'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att skapa fakturan'),
    },
    async ({ documentNumber, confirm, dryRun }) => {
      if (dryRun) {
        return dryRunResponse(`create invoice from order ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`create invoice from order ${documentNumber}`);

      const invoice = await createInvoiceFromOrder(documentNumber);
      return confirmationResponse(
        `Faktura skapad från order ${documentNumber}. Fakturanummer: ${invoice.DocumentNumber}`,
        invoice,
        orderConfirmColumns,
      );
    },
  );
}
