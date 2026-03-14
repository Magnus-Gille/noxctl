import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
} from '../operations/customers.js';
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

export function registerCustomerTools(server: McpServer): void {
  server.tool(
    'fortnox_list_customers',
    'Lista/sök kunder i Fortnox',
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
    'Hämta en enskild kund från Fortnox',
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
      Name: z.string().describe('Kundnamn'),
      OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
      Email: z.string().optional().describe('E-postadress'),
      Phone: z.string().optional().describe('Telefonnummer'),
      Address1: z.string().optional().describe('Adressrad 1'),
      Address2: z.string().optional().describe('Adressrad 2'),
      ZipCode: z.string().optional().describe('Postnummer'),
      City: z.string().optional().describe('Ort'),
      VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
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
      Name: z.string().optional().describe('Kundnamn'),
      OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
      Email: z.string().optional().describe('E-postadress'),
      Phone: z.string().optional().describe('Telefonnummer'),
      Address1: z.string().optional().describe('Adressrad 1'),
      Address2: z.string().optional().describe('Adressrad 2'),
      ZipCode: z.string().optional().describe('Postnummer'),
      City: z.string().optional().describe('Ort'),
      VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
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
