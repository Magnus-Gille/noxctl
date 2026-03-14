import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listArticles, getArticle, createArticle, updateArticle } from '../operations/articles.js';
import { articleListColumns, articleDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

export function registerArticleTools(server: McpServer): void {
  server.tool(
    'fortnox_list_articles',
    'Lista/sök artiklar i Fortnox',
    {
      search: z.string().optional().describe('Sökterm (beskrivning)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ search, page, limit, all, includeRaw }) => {
      const data = await listArticles({ search, page, limit, all });
      return listResponse(
        data.Articles ?? [],
        articleListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_article',
    'Hämta en enskild artikel från Fortnox',
    {
      articleNumber: z.string().describe('Artikelnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ articleNumber, includeRaw }) => {
      const data = await getArticle(articleNumber);
      return detailResponse(data, articleDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_article',
    'Skapa en ny artikel i Fortnox',
    {
      Description: z.string().describe('Artikelbeskrivning'),
      ArticleNumber: z
        .string()
        .optional()
        .describe('Artikelnummer (genereras automatiskt om det utelämnas)'),
      SalesPrice: z.number().optional().describe('Försäljningspris exkl. moms'),
      PurchasePrice: z.number().optional().describe('Inköpspris'),
      Unit: z.string().optional().describe('Enhet (t.ex. st, tim, kg)'),
      SalesAccount: z.number().optional().describe('Försäljningskonto'),
      VAT: z.number().optional().describe('Momssats i procent (t.ex. 25)'),
      Active: z.boolean().optional().describe('Om artikeln är aktiv'),
      confirm: z.boolean().optional().describe('Bekräfta att artikeln ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa artikeln'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create article "${params.Description}"`, { Article: params });
      }
      if (!confirm) requireConfirmation(`create article "${params.Description}"`);

      const data = await createArticle(params);
      return detailResponse(data, articleDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_article',
    'Uppdatera en befintlig artikel i Fortnox',
    {
      articleNumber: z.string().describe('Artikelnummer att uppdatera'),
      Description: z.string().optional().describe('Artikelbeskrivning'),
      SalesPrice: z.number().optional().describe('Försäljningspris exkl. moms'),
      PurchasePrice: z.number().optional().describe('Inköpspris'),
      Unit: z.string().optional().describe('Enhet (t.ex. st, tim, kg)'),
      SalesAccount: z.number().optional().describe('Försäljningskonto'),
      VAT: z.number().optional().describe('Momssats i procent (t.ex. 25)'),
      Active: z.boolean().optional().describe('Om artikeln är aktiv'),
      confirm: z.boolean().optional().describe('Bekräfta att artikeln ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera artikeln'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ articleNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update article ${articleNumber}`, { Article: fields });
      }
      if (!confirm) requireConfirmation(`update article ${articleNumber}`);

      const data = await updateArticle(articleNumber, fields);
      return detailResponse(data, articleDetailColumns, data, includeRaw);
    },
  );
}
