import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { customerListColumns, customerDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const CustomerNumberSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/, 'Customer number must be alphanumeric');

// The full writable Customer field set (Fortnox `CustomerSinglePayloadItem`).
// The MCP SDK silently strips any argument the schema does not declare, so a
// field missing here never reaches Fortnox and never raises an error — it just
// vanishes (#96, same class of bug as the Supplier field gap). The operations
// layer forwards whatever it is given.
//
// Country / DeliveryCountry / VisitingCountry are deliberately NOT declared
// here: Fortnox rejects them on write ("Fältet Country är endast läsbart") —
// they're server-derived from the matching *CountryCode field, which is the
// real writable source and is exposed below. operations/customers.ts strips
// the *Country fields defensively too, so a `get` response fed straight back
// into create/update still works, but the tool schema should not offer a
// field that would then be silently dropped a second time.
const customerWritableFields = {
  Name: z.string().optional().describe('Kundnamn'),
  Type: z.enum(['PRIVATE', 'COMPANY']).optional().describe('Kundtyp: privatperson eller företag'),
  OrganisationNumber: z.string().optional().describe('Organisations- eller personnummer'),
  Email: z.string().optional().describe('E-postadress'),
  Phone1: z.string().optional().describe('Telefonnummer'),
  Phone2: z.string().optional().describe('Alternativt telefonnummer'),
  Fax: z.string().optional().describe('Faxnummer'),
  WWW: z.string().optional().describe('Webbplats'),
  Address1: z.string().optional().describe('Adressrad 1'),
  Address2: z.string().optional().describe('Adressrad 2'),
  ZipCode: z.string().optional().describe('Postnummer'),
  City: z.string().optional().describe('Ort'),
  CountryCode: z.string().optional().describe('Landskod (t.ex. "SE") — det skrivbara landfältet'),
  DeliveryName: z.string().optional().describe('Leveransadress namn'),
  DeliveryAddress1: z.string().optional().describe('Leveransadress rad 1'),
  DeliveryAddress2: z.string().optional().describe('Leveransadress rad 2'),
  DeliveryZipCode: z.string().optional().describe('Leveransadress postnummer'),
  DeliveryCity: z.string().optional().describe('Leveransadress ort'),
  DeliveryCountryCode: z.string().optional().describe('Leveransadress landskod'),
  DeliveryFax: z.string().optional().describe('Leveransadress fax'),
  DeliveryPhone1: z.string().optional().describe('Leveransadress telefon'),
  DeliveryPhone2: z.string().optional().describe('Leveransadress alternativt telefon'),
  VisitingAddress: z.string().optional().describe('Besöksadress'),
  VisitingZipCode: z.string().optional().describe('Besöksadress postnummer'),
  VisitingCity: z.string().optional().describe('Besöksadress ort'),
  VisitingCountryCode: z.string().optional().describe('Besöksadress landskod'),
  GLN: z.string().optional().describe('GLN-nummer (13 tecken)'),
  GLNDelivery: z.string().optional().describe('GLN-nummer för leverans (13 tecken)'),
  ExternalReference: z.string().optional().describe('Externt referens-id'),
  OurReference: z.string().optional().describe('Vår referens'),
  YourReference: z.string().optional().describe('Er referens'),
  Comments: z.string().optional().describe('Kommentarer'),
  Currency: z.string().optional().describe('Valuta (t.ex. "SEK")'),
  CostCenter: z.string().optional().describe('Kostnadsställe'),
  Project: z.string().optional().describe('Projektnummer'),
  PriceList: z.string().optional().describe('Prislista'),
  TermsOfDelivery: z.string().optional().describe('Leveransvillkor (kod)'),
  TermsOfPayment: z.string().optional().describe('Betalningsvillkor (kod)'),
  WayOfDelivery: z.string().optional().describe('Leveranssätt (kod)'),
  VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
  VATType: z
    .enum(['SEVAT', 'SEREVERSEDVAT', 'EUREVERSEDVAT', 'EUVAT', 'EXPORT'])
    .optional()
    .describe('Momstyp'),
  SalesAccount: z.string().optional().describe('Försäljningskonto (4 siffror)'),
  InvoiceAdministrationFee: z.string().optional().describe('Faktureringsavgift'),
  InvoiceDiscount: z.number().optional().describe('Fakturarabatt i procent'),
  InvoiceFreight: z.string().optional().describe('Fraktavgift'),
  InvoiceRemark: z.string().optional().describe('Fakturaanmärkning'),
  ShowPriceVATIncluded: z.boolean().optional().describe('Visa priser inklusive moms'),
  EmailInvoice: z.string().optional().describe('E-post för fakturor'),
  EmailInvoiceCC: z.string().optional().describe('Kopia (CC) för fakturamejl'),
  EmailInvoiceBCC: z.string().optional().describe('Hemlig kopia (BCC) för fakturamejl'),
  EmailOffer: z.string().optional().describe('E-post för offerter'),
  EmailOfferCC: z.string().optional().describe('Kopia (CC) för offertmejl'),
  EmailOfferBCC: z.string().optional().describe('Hemlig kopia (BCC) för offertmejl'),
  EmailOrder: z.string().optional().describe('E-post för ordrar'),
  EmailOrderCC: z.string().optional().describe('Kopia (CC) för ordermejl'),
  EmailOrderBCC: z.string().optional().describe('Hemlig kopia (BCC) för ordermejl'),
  Active: z.boolean().optional().describe('Aktiv kund'),
};

export function registerCustomerTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const { listCustomers, getCustomer, createCustomer, updateCustomer } = operations;
  server.tool(
    'fortnox_list_customers',
    'Lista/sök kunder i Fortnox. Returnerar: CustomerNumber, Name, OrganisationNumber, City, Email.',
    {
      search: z.string().optional().describe('Sökterm (namn, kundnummer, orgnummer)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ search, page, limit, all, includeRaw }) => {
      const data = await listCustomers({ search, page, limit, all });
      return listResponse(
        data.Customers ?? [],
        customerListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_customer',
    'Hämta en enskild kund från Fortnox. Returnerar: CustomerNumber, Name, Type, OrganisationNumber, Email, Phone1, Address1, ZipCode, City, Country, VATNumber.',
    {
      customerNumber: CustomerNumberSchema.describe('Kundnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ customerNumber, includeRaw }) => {
      const data = await getCustomer(customerNumber);
      return detailResponse(data, customerDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_customer',
    'Skapa en ny kund i Fortnox',
    {
      ...customerWritableFields,
      Name: z.string().describe('Kundnamn'),
      confirm: z.boolean().optional().describe('Bekräfta att kunden ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa kunden'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create customer "${params.Name}"`, { Customer: params });
      }
      if (!confirm) requireConfirmation(`create customer "${params.Name}"`);

      const data = await createCustomer(params);
      return detailResponse(data, customerDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_customer',
    'Uppdatera en befintlig kund i Fortnox',
    {
      customerNumber: CustomerNumberSchema.describe('Kundnummer att uppdatera'),
      ...customerWritableFields,
      confirm: z.boolean().optional().describe('Bekräfta att kunden ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera kunden'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ customerNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update customer ${customerNumber}`, { Customer: fields });
      }
      if (!confirm) requireConfirmation(`update customer ${customerNumber}`);

      const data = await updateCustomer(customerNumber, fields);
      return detailResponse(data, customerDetailColumns, data, includeRaw);
    },
  );
}
