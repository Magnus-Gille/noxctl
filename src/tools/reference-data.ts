import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodType } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { detailResponse, listResponse } from '../tool-output.js';
import { referenceDataColumns } from '../views.js';

interface ReferenceToolDefinition {
  id: string;
  swedishName: string;
  listOperation: string;
  getOperation?: string;
  getId?: string;
  identifier?: { field: string; description: string };
}

export const REFERENCE_TOOL_DEFINITIONS: readonly ReferenceToolDefinition[] = [
  {
    id: 'currencies',
    getId: 'currency',
    swedishName: 'valutor',
    listOperation: 'listCurrencies',
    getOperation: 'getCurrency',
    identifier: { field: 'code', description: 'Valutakod' },
  },
  {
    id: 'units',
    getId: 'unit',
    swedishName: 'enheter',
    listOperation: 'listUnits',
    getOperation: 'getUnit',
    identifier: { field: 'code', description: 'Enhetskod' },
  },
  {
    id: 'modes_of_payments',
    getId: 'mode_of_payment',
    swedishName: 'betalsätt',
    listOperation: 'listModesOfPayments',
    getOperation: 'getModeOfPayment',
    identifier: { field: 'code', description: 'Kod för betalsätt' },
  },
  {
    id: 'terms_of_deliveries',
    getId: 'term_of_delivery',
    swedishName: 'leveransvillkor',
    listOperation: 'listTermsOfDeliveries',
    getOperation: 'getTermOfDelivery',
    identifier: { field: 'code', description: 'Kod för leveransvillkor' },
  },
  {
    id: 'terms_of_payments',
    getId: 'term_of_payment',
    swedishName: 'betalningsvillkor',
    listOperation: 'listTermsOfPayments',
    getOperation: 'getTermOfPayment',
    identifier: { field: 'code', description: 'Kod för betalningsvillkor' },
  },
  {
    id: 'ways_of_delivery',
    getId: 'way_of_delivery',
    swedishName: 'leveranssätt',
    listOperation: 'listWaysOfDelivery',
    getOperation: 'getWayOfDelivery',
    identifier: { field: 'code', description: 'Kod för leveranssätt' },
  },
  {
    id: 'voucher_series',
    getId: 'voucher_series',
    swedishName: 'verifikationsserier',
    listOperation: 'listVoucherSeries',
    getOperation: 'getVoucherSeries',
    identifier: { field: 'code', description: 'Kod för verifikationsserie' },
  },
  {
    id: 'predefined_voucher_series',
    getId: 'predefined_voucher_series',
    swedishName: 'fördefinierade verifikationsserier',
    listOperation: 'listPredefinedVoucherSeries',
    getOperation: 'getPredefinedVoucherSeries',
    identifier: { field: 'name', description: 'Namn på fördefinierad serie' },
  },
  { id: 'account_charts', swedishName: 'kontoplanstyper', listOperation: 'listAccountCharts' },
  {
    id: 'predefined_accounts',
    getId: 'predefined_account',
    swedishName: 'fördefinierade konton',
    listOperation: 'listPredefinedAccounts',
    getOperation: 'getPredefinedAccount',
    identifier: { field: 'name', description: 'Namn på fördefinierat konto' },
  },
  {
    id: 'customer_references',
    getId: 'customer_reference',
    swedishName: 'kundreferenser',
    listOperation: 'listCustomerReferences',
    getOperation: 'getCustomerReference',
    identifier: { field: 'rowId', description: 'Kundreferensens rad-ID' },
  },
];

type DynamicOperation = (argument?: unknown) => Promise<unknown>;

export function registerReferenceDataTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const dynamicOperations = operations as unknown as Record<string, DynamicOperation>;
  for (const definition of REFERENCE_TOOL_DEFINITIONS) {
    server.tool(
      `fortnox_list_${definition.id}`,
      `Lista ${definition.swedishName} i Fortnox`,
      {
        page: z.number().int().positive().optional().describe('Sidnummer'),
        limit: z.number().int().positive().max(500).optional().describe('Antal per sida'),
        all: z.boolean().optional().describe('Hämta alla sidor'),
        includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
      },
      async ({ page, limit, all, includeRaw }) => {
        const result = (await dynamicOperations[definition.listOperation]?.({
          page,
          limit,
          all,
        })) as { items: Record<string, unknown>[]; raw: Record<string, unknown> };
        if (!result) throw new Error(`Missing operation ${definition.listOperation}`);
        return listResponse(
          result.items,
          referenceDataColumns,
          result.raw,
          result.raw.MetaInformation as Record<string, unknown> | undefined,
          includeRaw,
        );
      },
    );

    if (!definition.getOperation || !definition.identifier) continue;
    const identifierSchema: Record<string, ZodType> = {
      [definition.identifier.field]: z.string().describe(definition.identifier.description),
    };
    server.tool(
      `fortnox_get_${definition.getId}`,
      `Hämta en post ur ${definition.swedishName} i Fortnox`,
      {
        ...identifierSchema,
        includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
      },
      async (arguments_) => {
        const dynamicArguments = arguments_ as Record<string, unknown>;
        const identifier = String(dynamicArguments[definition.identifier!.field]);
        const result = (await dynamicOperations[definition.getOperation!]?.(identifier)) as {
          item: Record<string, unknown>;
          raw: Record<string, unknown>;
        };
        if (!result) throw new Error(`Missing operation ${definition.getOperation}`);
        return detailResponse(
          result.item,
          referenceDataColumns,
          result.raw,
          Boolean(dynamicArguments.includeRaw),
        );
      },
    );
  }
}
