import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
} from '../operations/suppliers.js';
import { supplierListColumns, supplierDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

export function registerSupplierTools(server: McpServer): void {
  server.tool(
    'fortnox_list_suppliers',
    'Lista/sök leverantörer i Fortnox',
    {
      search: z.string().optional().describe('Sökterm (namn)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ search, page, limit, includeRaw }) => {
      const data = await listSuppliers({ search, page, limit });
      return listResponse(
        data.Suppliers ?? [],
        supplierListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_supplier',
    'Hämta en enskild leverantör från Fortnox',
    {
      supplierNumber: z.string().describe('Leverantörsnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ supplierNumber, includeRaw }) => {
      const data = await getSupplier(supplierNumber);
      return detailResponse(data, supplierDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_supplier',
    'Skapa en ny leverantör i Fortnox',
    {
      Name: z.string().describe('Leverantörsnamn'),
      OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
      Email: z.string().optional().describe('E-postadress'),
      Phone1: z.string().optional().describe('Telefonnummer'),
      Address1: z.string().optional().describe('Adressrad 1'),
      ZipCode: z.string().optional().describe('Postnummer'),
      City: z.string().optional().describe('Ort'),
      BankAccountNumber: z.string().optional().describe('Bankkontonummer'),
      BG: z.string().optional().describe('Bankgiro'),
      PG: z.string().optional().describe('Plusgiro'),
      confirm: z.boolean().optional().describe('Bekräfta att leverantören ska skapas'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att skapa leverantören'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create supplier "${params.Name}"`, { Supplier: params });
      }
      if (!confirm) requireConfirmation(`create supplier "${params.Name}"`);

      const data = await createSupplier(params);
      return detailResponse(data, supplierDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_supplier',
    'Uppdatera en befintlig leverantör i Fortnox',
    {
      supplierNumber: z.string().describe('Leverantörsnummer att uppdatera'),
      Name: z.string().optional().describe('Leverantörsnamn'),
      OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
      Email: z.string().optional().describe('E-postadress'),
      Phone1: z.string().optional().describe('Telefonnummer'),
      Address1: z.string().optional().describe('Adressrad 1'),
      ZipCode: z.string().optional().describe('Postnummer'),
      City: z.string().optional().describe('Ort'),
      BankAccountNumber: z.string().optional().describe('Bankkontonummer'),
      BG: z.string().optional().describe('Bankgiro'),
      PG: z.string().optional().describe('Plusgiro'),
      confirm: z.boolean().optional().describe('Bekräfta att leverantören ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera leverantören'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ supplierNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update supplier ${supplierNumber}`, { Supplier: fields });
      }
      if (!confirm) requireConfirmation(`update supplier ${supplierNumber}`);

      const data = await updateSupplier(supplierNumber, fields);
      return detailResponse(data, supplierDetailColumns, data, includeRaw);
    },
  );
}
