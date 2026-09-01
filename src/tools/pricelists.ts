import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  priceListListColumns,
  priceListDetailColumns,
  priceListColumns,
  priceDetailColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
  textResponse,
} from '../tool-output.js';

export function registerPriceListTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listPriceLists,
    getPriceList,
    createPriceList,
    updatePriceList,
    listPrices,
    getPrice,
    createPrice,
    updatePrice,
    deletePrice,
  } = operations;
  server.tool(
    'fortnox_list_pricelists',
    'Lista prislistor i Fortnox. Returnerar: Code, Description, Comments, PreSelected.',
    {
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ page, limit, all, includeRaw }) => {
      const data = await listPriceLists({ page, limit, all });
      return listResponse(
        data.PriceLists ?? [],
        priceListListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_pricelist',
    'Hämta en enskild prislista från Fortnox. Returnerar: Code, Description, Comments, PreSelected.',
    {
      code: z.string().describe('Prislistekod'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ code, includeRaw }) => {
      const data = await getPriceList(code);
      return detailResponse(data, priceListDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_pricelist',
    'Skapa en ny prislista i Fortnox',
    {
      Code: z.string().describe('Prislistekod'),
      Description: z.string().describe('Beskrivning'),
      Comments: z.string().optional().describe('Kommentarer'),
      PreSelected: z.boolean().optional().describe('Om prislistan är förvald'),
      confirm: z.boolean().optional().describe('Bekräfta att prislistan ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa prislistan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create price list "${params.Code}"`, { PriceList: params });
      }
      if (!confirm) requireConfirmation(`create price list "${params.Code}"`);

      const data = await createPriceList(params);
      return detailResponse(data, priceListDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_pricelist',
    'Uppdatera en befintlig prislista i Fortnox',
    {
      code: z.string().describe('Prislistekod att uppdatera'),
      Description: z.string().optional().describe('Beskrivning'),
      Comments: z.string().optional().describe('Kommentarer'),
      PreSelected: z.boolean().optional().describe('Om prislistan är förvald'),
      confirm: z.boolean().optional().describe('Bekräfta att prislistan ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera prislistan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ code, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update price list ${code}`, { PriceList: fields });
      }
      if (!confirm) requireConfirmation(`update price list ${code}`);

      const data = await updatePriceList(code, fields);
      return detailResponse(data, priceListDetailColumns, data, includeRaw);
    },
  );

  // --- Price tools ---

  server.tool(
    'fortnox_list_prices',
    'Lista priser i en prislista i Fortnox. Returnerar: ArticleNumber, Price, FromQuantity, Percent.',
    {
      priceListCode: z.string().optional().describe('Prislistekod; utelämna för alla priser'),
      articleNumber: z.string().optional().describe('Filtrera på artikelnummer'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ priceListCode, articleNumber, page, limit, includeRaw }) => {
      const data = await listPrices({ priceListCode, articleNumber, page, limit });
      return listResponse(
        data.Prices ?? [],
        priceListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_price',
    'Hämta ett enskilt pris från en prislista i Fortnox. Returnerar: ArticleNumber, PriceList, Price, FromQuantity, Percent.',
    {
      priceListCode: z.string().describe('Prislistekod'),
      articleNumber: z.string().describe('Artikelnummer'),
      fromQuantity: z.number().optional().describe('Från antal (default 0)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ priceListCode, articleNumber, fromQuantity, includeRaw }) => {
      const data = await getPrice(priceListCode, articleNumber, fromQuantity);
      return detailResponse(data, priceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_price',
    'Skapa ett pris i Fortnox',
    {
      PriceList: z.string().describe('Prislistekod'),
      ArticleNumber: z.string().describe('Artikelnummer'),
      FromQuantity: z.number().optional().describe('Från antal'),
      Price: z.number().optional().describe('Pris'),
      Percent: z.number().optional().describe('Rabatt i procent'),
      confirm: z.boolean().optional().describe('Bekräfta att priset ska skapas'),
      dryRun: z.boolean().optional().describe('Visa payload utan att skapa priset'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) return dryRunResponse('create price', { Price: fields });
      if (!confirm) requireConfirmation('create price');
      const data = await createPrice(fields);
      return detailResponse(data, priceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_price',
    'Uppdatera ett pris i en prislista i Fortnox',
    {
      priceListCode: z.string().describe('Prislistekod'),
      articleNumber: z.string().describe('Artikelnummer'),
      fromQuantity: z.number().optional().describe('Från antal (default 0)'),
      Price: z.number().optional().describe('Pris'),
      Percent: z.number().optional().describe('Rabatt i procent'),
      confirm: z.boolean().optional().describe('Bekräfta att priset ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera priset'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({
      priceListCode,
      articleNumber,
      fromQuantity,
      confirm,
      dryRun,
      includeRaw,
      ...fields
    }) => {
      if (dryRun) {
        return dryRunResponse(`update price ${priceListCode}/${articleNumber}`, { Price: fields });
      }
      if (!confirm) requireConfirmation(`update price ${priceListCode}/${articleNumber}`);

      const data = await updatePrice(priceListCode, articleNumber, fields, fromQuantity);
      return detailResponse(data, priceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_delete_price',
    'Ta bort ett kvantitetspris från Fortnox',
    {
      priceListCode: z.string().describe('Prislistekod'),
      articleNumber: z.string().describe('Artikelnummer'),
      fromQuantity: z.number().describe('Från antal'),
      confirm: z.boolean().optional().describe('Bekräfta borttagningen'),
      dryRun: z.boolean().optional().describe('Visa åtgärden utan att ta bort'),
    },
    async ({ priceListCode, articleNumber, fromQuantity, confirm, dryRun }) => {
      const target = `delete price ${priceListCode}/${articleNumber}/${fromQuantity}`;
      if (dryRun) return dryRunResponse(target);
      if (!confirm) requireConfirmation(target);
      await deletePrice(priceListCode, articleNumber, fromQuantity);
      return textResponse(`Price ${priceListCode}/${articleNumber}/${fromQuantity} deleted.`);
    },
  );
}
