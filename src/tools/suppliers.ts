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

// The full writable Supplier field set (Fortnox `SupplierSinglePayloadItem`).
// The MCP SDK silently strips any argument the schema does not declare, so a
// field missing here never reaches Fortnox and never raises an error — it just
// vanishes (#96). The operations layer forwards whatever it is given.
const supplierWritableFields = {
  Name: z.string().optional().describe('Leverantörsnamn'),
  OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
  Email: z.string().optional().describe('E-postadress'),
  Phone1: z.string().optional().describe('Telefonnummer'),
  Phone2: z.string().optional().describe('Alternativt telefonnummer'),
  Fax: z.string().optional().describe('Faxnummer'),
  WWW: z.string().optional().describe('Webbplats'),
  Address1: z.string().optional().describe('Adressrad 1'),
  Address2: z.string().optional().describe('Adressrad 2'),
  ZipCode: z.string().optional().describe('Postnummer'),
  City: z.string().optional().describe('Ort'),
  Country: z.string().optional().describe('Land'),
  CountryCode: z.string().optional().describe('Landskod (t.ex. "SE")'),
  VisitingAddress: z.string().optional().describe('Besöksadress'),
  VisitingZipCode: z.string().optional().describe('Besöksadress postnummer'),
  VisitingCity: z.string().optional().describe('Besöksadress ort'),
  VisitingCountry: z.string().optional().describe('Besöksadress land'),
  VisitingCountryCode: z.string().optional().describe('Besöksadress landskod'),
  OurReference: z.string().optional().describe('Vår referens'),
  YourReference: z.string().optional().describe('Er referens'),
  OurCustomerNumber: z.string().optional().describe('Vårt kundnummer hos leverantören'),
  Comments: z.string().optional().describe('Kommentarer'),
  Currency: z.string().optional().describe('Valuta (t.ex. "SEK")'),
  TermsOfPayment: z.string().optional().describe('Betalningsvillkor (kod)'),
  VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
  VATType: z
    .string()
    .optional()
    .describe('Momstyp (t.ex. "SEVAT", "SEREVERSEDVAT", "EUREVERSEDVAT")'),
  PreDefinedAccount: z.string().optional().describe('Fördefinierat konto'),
  CostCenter: z.string().optional().describe('Kostnadsställe'),
  Project: z.string().optional().describe('Projektnummer'),
  BankAccountNumber: z.string().optional().describe('Bankkontonummer'),
  Bank: z.string().optional().describe('Bank'),
  BG: z.string().optional().describe('Bankgiro'),
  PG: z.string().optional().describe('Plusgiro'),
  BIC: z.string().optional().describe('BIC/SWIFT'),
  IBAN: z.string().optional().describe('IBAN'),
  ClearingNumber: z.string().optional().describe('Clearingnummer'),
  BranchCode: z.string().optional().describe('Bankkod (utländska betalningar)'),
  DisablePaymentFile: z.boolean().optional().describe('Uteslut från betalningsfil'),
  WorkPlace: z.string().optional().describe('Arbetsplats'),
  Active: z.boolean().optional().describe('Aktiv leverantör'),
};

export function registerSupplierTools(server: McpServer): void {
  server.tool(
    'fortnox_list_suppliers',
    'Lista/sök leverantörer i Fortnox. Returnerar: SupplierNumber, Name, OrganisationNumber, City, Email.',
    {
      search: z.string().optional().describe('Sökterm (namn)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ search, page, limit, all, includeRaw }) => {
      const data = await listSuppliers({ search, page, limit, all });
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
    'Hämta en enskild leverantör från Fortnox. Returnerar: SupplierNumber, Name, OrganisationNumber, Email, Phone1, Address1, ZipCode, City, BG, PG, BankAccountNumber.',
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
      ...supplierWritableFields,
      Name: z.string().describe('Leverantörsnamn'),
      SupplierNumber: z.string().optional().describe('Leverantörsnummer (default: nästa lediga)'),
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
      ...supplierWritableFields,
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
