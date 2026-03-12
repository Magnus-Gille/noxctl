import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
} from '../operations/customers.js';

export function registerCustomerTools(server: McpServer): void {
  server.tool(
    'fortnox_list_customers',
    'Lista/sök kunder i Fortnox',
    {
      search: z.string().optional().describe('Sökterm (namn, kundnummer, orgnummer)'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
    },
    async ({ search, page, limit }) => {
      const data = await listCustomers({ search, page, limit });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    'fortnox_get_customer',
    'Hämta en enskild kund från Fortnox',
    {
      customerNumber: z.string().describe('Kundnummer'),
    },
    async ({ customerNumber }) => {
      const data = await getCustomer(customerNumber);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
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
      Country: z.string().optional().describe('Landskod (t.ex. SE)'),
      VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
      DeliveryType: z
        .enum(['EMAIL', 'PRINT', 'ELECTRONICINVOICE'])
        .optional()
        .describe('Leveranssätt för faktura'),
    },
    async (params) => {
      const data = await createCustomer(params);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.tool(
    'fortnox_update_customer',
    'Uppdatera en befintlig kund i Fortnox',
    {
      customerNumber: z.string().describe('Kundnummer att uppdatera'),
      Name: z.string().optional().describe('Kundnamn'),
      OrganisationNumber: z.string().optional().describe('Organisationsnummer'),
      Email: z.string().optional().describe('E-postadress'),
      Phone: z.string().optional().describe('Telefonnummer'),
      Address1: z.string().optional().describe('Adressrad 1'),
      Address2: z.string().optional().describe('Adressrad 2'),
      ZipCode: z.string().optional().describe('Postnummer'),
      City: z.string().optional().describe('Ort'),
      Country: z.string().optional().describe('Landskod'),
      VATNumber: z.string().optional().describe('Momsregistreringsnummer'),
      DeliveryType: z
        .enum(['EMAIL', 'PRINT', 'ELECTRONICINVOICE'])
        .optional()
        .describe('Leveranssätt för faktura'),
    },
    async ({ customerNumber, ...fields }) => {
      const data = await updateCustomer(customerNumber, fields);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
