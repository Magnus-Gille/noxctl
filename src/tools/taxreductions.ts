import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listTaxReductions,
  getTaxReduction,
  createTaxReduction,
} from '../operations/taxreductions.js';
import { taxReductionListColumns, taxReductionDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

export function registerTaxReductionTools(server: McpServer): void {
  server.tool(
    'fortnox_list_taxreductions',
    'Lista skattereduktioner (ROT/RUT) i Fortnox. Returnerar: Id, CustomerName, TypeOfReduction, ReferenceNumber, AskedAmount, ApprovedAmount.',
    {
      filter: z
        .string()
        .optional()
        .describe('Filtrera efter dokumenttyp (t.ex. invoices, offers, orders)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ filter, page, limit, all, includeRaw }) => {
      const data = await listTaxReductions({ filter, page, limit, all });
      return listResponse(
        data.TaxReductions ?? [],
        taxReductionListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_taxreduction',
    'Hämta en enskild skattereduktion (ROT/RUT) från Fortnox. Returnerar: Id, CustomerName, TypeOfReduction, ReferenceNumber, AskedAmount, ApprovedAmount, PropertyDesignation.',
    {
      id: z.number().describe('Skattereduktions-ID'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ id, includeRaw }) => {
      const data = await getTaxReduction(id);
      return detailResponse(data, taxReductionDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_taxreduction',
    'Skapa en ny skattereduktion (ROT/RUT) i Fortnox kopplad till en faktura',
    {
      ReferenceNumber: z.string().describe('Referensnummer (t.ex. fakturanummer)'),
      ReferenceDocumentType: z
        .enum(['INVOICE', 'OFFER', 'ORDER'])
        .describe('Typ av referensdokument'),
      TypeOfReduction: z.enum(['rot', 'rut']).describe('Typ av reduktion (rot eller rut)'),
      CustomerName: z.string().describe('Kundens namn'),
      AskedAmount: z.number().describe('Begärt belopp i ören'),
      PropertyDesignation: z.string().optional().describe('Fastighetsbeteckning (krävs för ROT)'),
      confirm: z.boolean().optional().describe('Bekräfta att skattereduktionen ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa skattereduktionen'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(
          `create ${params.TypeOfReduction.toUpperCase()} tax reduction for ref ${params.ReferenceNumber}`,
          { TaxReduction: params },
        );
      }
      if (!confirm)
        requireConfirmation(
          `create ${params.TypeOfReduction.toUpperCase()} tax reduction for ref ${params.ReferenceNumber}`,
        );

      const data = await createTaxReduction(params);
      return detailResponse(data, taxReductionDetailColumns, data, includeRaw);
    },
  );
}
