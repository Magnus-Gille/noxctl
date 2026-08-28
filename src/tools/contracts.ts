import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import { contractListColumns, contractDetailColumns, invoiceDetailColumns } from '../views.js';
import {
  detailResponse,
  dryRunResponse,
  listResponse,
  requireConfirmation,
} from '../tool-output.js';

const invoiceRowSchema = z
  .object({
    ArticleNumber: z.string().optional().describe('Artikelnummer'),
    Description: z.string().optional().describe('Beskrivning av raden'),
    DeliveredQuantity: z.number().optional().describe('Antal'),
    Price: z.number().optional().describe('Pris per enhet'),
    AccountNumber: z.number().optional().describe('Bokföringskonto'),
    VAT: z.number().optional().describe('Momssats (%)'),
    Discount: z.number().optional().describe('Rabatt'),
  })
  .passthrough();

export function registerContractTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    listContracts,
    getContract,
    createContract,
    updateContract,
    finishContract,
    createInvoiceFromContract,
    increaseInvoiceCount,
  } = operations;
  server.tool(
    'fortnox_list_contracts',
    'Lista avtal (återkommande fakturering) i Fortnox. Returnerar: DocumentNumber, CustomerName, PeriodStart, PeriodEnd, InvoiceInterval, Continuous, Total.',
    {
      filter: z
        .enum(['active', 'inactive', 'finished'])
        .optional()
        .describe('Filtrera på avtalsstatus'),
      page: z.number().optional().describe('Sidnummer (default 1)'),
      limit: z.number().optional().describe('Antal per sida (default 100, max 500)'),
      all: z.boolean().optional().describe('Hämta alla sidor (ignorerar page/limit)'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ filter, page, limit, all, includeRaw }) => {
      const data = await listContracts({ filter, page, limit, all });
      return listResponse(
        data.Contracts ?? [],
        contractListColumns,
        data,
        data.MetaInformation,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_get_contract',
    'Hämta ett enskilt avtal från Fortnox, inklusive fakturarader.',
    {
      documentNumber: z.string().describe('Avtalets dokumentnummer'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, includeRaw }) => {
      const data = await getContract(documentNumber);
      return detailResponse(data, contractDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_contract',
    'Skapa ett nytt avtal i Fortnox för återkommande fakturering. Fakturor skapas automatiskt enligt InvoiceInterval.',
    {
      CustomerNumber: z.string().describe('Kundnummer'),
      InvoiceRows: z.array(invoiceRowSchema).describe('Fakturarader'),
      PeriodStart: z.string().optional().describe('Avtalsperiodens start (YYYY-MM-DD)'),
      PeriodEnd: z.string().optional().describe('Avtalsperiodens slut (YYYY-MM-DD)'),
      InvoiceInterval: z
        .number()
        .optional()
        .describe('Faktureringsintervall i månader (1, 3, 6, 12)'),
      ContractLength: z.number().optional().describe('Avtalslängd i månader'),
      Continuous: z.boolean().optional().describe('Löpande avtal (utan slutdatum)'),
      Comments: z.string().optional().describe('Kommentar'),
      confirm: z.boolean().optional().describe('Bekräfta att avtalet ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle skickas utan att skapa avtalet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ confirm, dryRun, includeRaw, ...params }) => {
      if (dryRun) {
        return dryRunResponse(`create contract for customer ${params.CustomerNumber}`, {
          Contract: params,
        });
      }
      if (!confirm) requireConfirmation(`create contract for customer ${params.CustomerNumber}`);

      const data = await createContract(params);
      return detailResponse(data, contractDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_update_contract',
    'Uppdatera ett befintligt avtal i Fortnox.',
    {
      documentNumber: z.string().describe('Avtalets dokumentnummer'),
      InvoiceRows: z
        .array(invoiceRowSchema)
        .optional()
        .describe('Fakturarader (ersätter alla befintliga rader)'),
      PeriodStart: z.string().optional().describe('Avtalsperiodens start (YYYY-MM-DD)'),
      PeriodEnd: z.string().optional().describe('Avtalsperiodens slut (YYYY-MM-DD)'),
      InvoiceInterval: z
        .number()
        .optional()
        .describe('Faktureringsintervall i månader (1, 3, 6, 12)'),
      ContractLength: z.number().optional().describe('Avtalslängd i månader'),
      Continuous: z.boolean().optional().describe('Löpande avtal (utan slutdatum)'),
      Comments: z.string().optional().describe('Kommentar'),
      confirm: z.boolean().optional().describe('Bekräfta att avtalet ska uppdateras'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Visa vad som skulle skickas utan att uppdatera avtalet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw, ...fields }) => {
      if (dryRun) {
        return dryRunResponse(`update contract ${documentNumber}`, { Contract: fields });
      }
      if (!confirm) requireConfirmation(`update contract ${documentNumber}`);

      const data = await updateContract(documentNumber, fields);
      return detailResponse(data, contractDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_finish_contract',
    'Avsluta ett avtal i Fortnox — inga fler fakturor skapas.',
    {
      documentNumber: z.string().describe('Avtalets dokumentnummer'),
      confirm: z.boolean().optional().describe('Bekräfta att avtalet ska avslutas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle göras utan att avsluta avtalet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`finish contract ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`finish contract ${documentNumber}`);

      const data = await finishContract(documentNumber);
      return detailResponse(data, contractDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_create_invoice_from_contract',
    'Skapa nästa faktura från ett avtal direkt. Returnerar den skapade fakturan.',
    {
      documentNumber: z.string().describe('Avtalets dokumentnummer'),
      confirm: z.boolean().optional().describe('Bekräfta att fakturan ska skapas'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle göras utan att skapa fakturan'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`create invoice from contract ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`create invoice from contract ${documentNumber}`);

      const data = await createInvoiceFromContract(documentNumber);
      return detailResponse(data, invoiceDetailColumns, data, includeRaw);
    },
  );

  server.tool(
    'fortnox_increase_contract_invoice_count',
    'Utöka ett tidsbegränsat avtal med en faktura (ökar InvoicesRemaining).',
    {
      documentNumber: z.string().describe('Avtalets dokumentnummer'),
      confirm: z.boolean().optional().describe('Bekräfta utökningen'),
      dryRun: z.boolean().optional().describe('Visa vad som skulle göras utan att utöka avtalet'),
      includeRaw: z.boolean().optional().describe('Inkludera rå JSON från Fortnox'),
    },
    async ({ documentNumber, confirm, dryRun, includeRaw }) => {
      if (dryRun) {
        return dryRunResponse(`increase invoice count for contract ${documentNumber}`);
      }
      if (!confirm) requireConfirmation(`increase invoice count for contract ${documentNumber}`);

      const data = await increaseInvoiceCount(documentNumber);
      return detailResponse(data, contractDetailColumns, data, includeRaw);
    },
  );
}
