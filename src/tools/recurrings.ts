import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createInvoiceRequest,
  createRecurring,
  getInvoiceRequest,
  getRecurring,
  getRecurringDeviation,
  listInvoiceRequests,
  listRecurringDeviations,
  listRecurrings,
  patchRecurring,
  replaceRecurring,
} from '../operations/recurrings.js';
import {
  invoiceRequestDetailColumns,
  invoiceRequestListColumns,
  recurringDetailColumns,
  recurringListColumns,
} from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const recurringId = z.string().uuid().describe('Återkommande faktureringens UUID');
const objectInput = z
  .record(z.string(), z.unknown())
  .describe('JSON-objekt enligt Fortnox Recurring API');
const patchOperation = z
  .object({
    op: z.enum(['add', 'remove', 'replace']).describe('JSON Patch-åtgärd'),
    path: z.string().startsWith('/').describe('JSON Pointer-sökväg'),
    value: z.unknown().optional().describe('Nytt värde (ej för remove)'),
  })
  .passthrough();

function withMetadata(result: {
  recurring: Record<string, unknown>;
  etag?: string;
  lastModified?: string;
}) {
  return {
    ...result.recurring,
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.lastModified ? { last_modified: result.lastModified } : {}),
  };
}

export function registerRecurringTools(server: McpServer): void {
  server.tool(
    'fortnox_list_recurrings',
    'Lista återkommande faktureringar från Fortnox nya Recurring Billing API.',
    {
      customerNumbers: z.array(z.string()).optional().describe('Filtrera på kundnummer'),
      statuses: z.array(z.string()).optional().describe('Filtrera på status, t.ex. ACTIVE'),
      invoiceHandlings: z.array(z.string()).optional().describe('Filtrera på fakturahantering'),
      errorStatus: z.string().optional().describe('Filtrera på felstatus'),
      offset: z.number().int().min(0).optional().describe('Antal rader att hoppa över'),
      limit: z.number().int().min(1).max(100).optional().describe('Antal resultat (1–100)'),
      sortBy: z.string().optional().describe('Fält att sortera på'),
      order: z.enum(['ASC', 'DESC']).optional().describe('Sorteringsriktning'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ includeRaw, ...params }) => {
      const data = await listRecurrings(params);
      return listResponse(data, recurringListColumns, data, undefined, includeRaw);
    },
  );

  server.tool(
    'fortnox_get_recurring',
    'Hämta en återkommande fakturering. Svaret inkluderar ETag som krävs för uppdatering.',
    { recurringId, includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox') },
    async ({ recurringId, includeRaw }) => {
      const result = await getRecurring(recurringId);
      const data = withMetadata(result);
      return detailResponse(data, recurringDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_recurring',
    'Skapa en återkommande fakturering. Kräver dates, customer och minst en rad enligt Recurring API.',
    {
      input: objectInput,
      confirm: z.boolean().optional().describe('Bekräfta skapandet'),
      dryRun: z.boolean().optional().describe('Visa begäran utan att skapa'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ input, confirm, dryRun, includeRaw }) => {
      if (dryRun) return dryRunResponse('create recurring', input);
      if (!confirm) requireConfirmation('create recurring');
      const result = await createRecurring(input);
      const data = withMetadata(result);
      return detailResponse(data, recurringDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_replace_recurring',
    'Ersätt en återkommande fakturering. ETag från fortnox_get_recurring krävs för att undvika att skriva över andras ändringar.',
    {
      recurringId,
      etag: z.string().min(1).describe('ETag från senaste hämtningen'),
      input: objectInput,
      ifUnmodifiedSince: z
        .string()
        .optional()
        .describe('Valfri Last-Modified-kontroll från senaste hämtningen'),
      confirm: z.boolean().optional().describe('Bekräfta ersättningen'),
      dryRun: z.boolean().optional().describe('Visa begäran utan att uppdatera'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ recurringId, etag, input, ifUnmodifiedSince, confirm, dryRun, includeRaw }) => {
      if (dryRun) return dryRunResponse(`replace recurring ${recurringId}`, input);
      if (!confirm) requireConfirmation(`replace recurring ${recurringId}`);
      const result = await replaceRecurring(recurringId, etag, input, ifUnmodifiedSince);
      const data = withMetadata(result);
      return detailResponse(data, recurringDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_patch_recurring',
    'Ändra utvalda fält i en återkommande fakturering med JSON Patch. ETag krävs.',
    {
      recurringId,
      etag: z.string().min(1).describe('ETag från senaste hämtningen'),
      operations: z.array(patchOperation).min(1).describe('JSON Patch-operationer'),
      ifUnmodifiedSince: z.string().optional().describe('Valfri Last-Modified-kontroll'),
      confirm: z.boolean().optional().describe('Bekräfta uppdateringen'),
      dryRun: z.boolean().optional().describe('Visa begäran utan att uppdatera'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ recurringId, etag, operations, ifUnmodifiedSince, confirm, dryRun, includeRaw }) => {
      if (dryRun) return dryRunResponse(`patch recurring ${recurringId}`, operations);
      if (!confirm) requireConfirmation(`patch recurring ${recurringId}`);
      const result = await patchRecurring(recurringId, etag, operations, ifUnmodifiedSince);
      const data = withMetadata(result);
      return detailResponse(data, recurringDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_list_recurring_deviations',
    'Lista avvikelser för en återkommande fakturering.',
    { recurringId, includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox') },
    async ({ recurringId, includeRaw }) => {
      const data = await listRecurringDeviations(recurringId);
      return listResponse(data, recurringListColumns, data, undefined, includeRaw);
    },
  );

  server.tool(
    'fortnox_get_recurring_deviation',
    'Hämta en specifik avvikelse för en återkommande fakturering.',
    {
      recurringId,
      deviationId: z.string().uuid().describe('Avvikelsens UUID'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ recurringId, deviationId, includeRaw }) => {
      const data = await getRecurringDeviation(recurringId, deviationId);
      return detailResponse(data, recurringDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_list_recurring_invoice_requests',
    'Lista fakturabegäranden för en eller flera återkommande faktureringar.',
    {
      recurringIds: z
        .array(z.string().uuid())
        .min(1)
        .max(100)
        .describe('Återkommande faktureringars UUID:er'),
      statuses: z.array(z.string()).optional().describe('Filtrera på status'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ recurringIds, statuses, includeRaw }) => {
      const data = await listInvoiceRequests(recurringIds, statuses);
      return listResponse(data, invoiceRequestListColumns, data, undefined, includeRaw);
    },
  );

  server.tool(
    'fortnox_get_recurring_invoice_request',
    'Hämta status och resultat för en fakturabegäran.',
    {
      invoiceRequestId: z.string().uuid().describe('Fakturabegärans UUID'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ invoiceRequestId, includeRaw }) => {
      const data = await getInvoiceRequest(invoiceRequestId);
      return detailResponse(data, invoiceRequestDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_recurring_invoice_request',
    'Skapa fakturor för återkommande faktureringar. ASYNC behövs för fler än 100 ID:n.',
    {
      recurringIds: z
        .array(z.string().uuid())
        .min(1)
        .describe('Återkommande faktureringars UUID:er'),
      processingMode: z.enum(['SYNC', 'ASYNC']).optional().describe('SYNC (default) eller ASYNC'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturor ska skapas'),
      dryRun: z.boolean().optional().describe('Visa begäran utan att skapa fakturor'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ recurringIds, processingMode, confirm, dryRun, includeRaw }) => {
      if (dryRun)
        return dryRunResponse('create recurring invoice request', {
          recurring_ids: recurringIds,
          processing_mode: processingMode ?? 'SYNC',
        });
      if (!confirm) requireConfirmation('create recurring invoice request');
      const data = await createInvoiceRequest(recurringIds, processingMode);
      return detailResponse(data, invoiceRequestDetailColumns, data, includeRaw);
    },
  );
}
