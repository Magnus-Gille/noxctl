import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defaultFortnoxOperations, type FortnoxOperations } from '../operations/index.js';
import {
  NOX_FINANS_SEND_METHODS,
  NOX_FINANS_SERVICES,
  noxFinansPaymentPayload,
  noxFinansSendPayload,
} from '../operations/noxfinans-invoices.js';
import { noxFinansInvoiceColumns } from '../views.js';
import {
  confirmationResponse,
  detailResponse,
  dryRunResponse,
  requireConfirmation,
} from '../tool-output.js';

const InvoiceNumberSchema = z
  .string()
  .regex(/^\d+$/, 'Invoice number must be numeric')
  .describe('Fakturanummer i Fortnox (DocumentNumber)');

const SCOPE_NOTE =
  'Kräver att Fortnox Finans är aktiverat för företaget och behörigheten "noxfinansinvoice" (noxctl init --with-noxfinans).';

const confirm = (what: string) => z.boolean().optional().describe(`Bekräfta att ${what}`);
const dryRun = z.boolean().optional().describe('Visa åtgärden utan att anropa Fortnox');
const includeRaw = z.boolean().optional().describe('Inkludera rå JSON från Fortnox');

export function registerNoxFinansInvoiceTools(
  server: McpServer,
  operations: FortnoxOperations = defaultFortnoxOperations,
): void {
  const {
    getNoxFinansInvoice,
    sendNoxFinansInvoice,
    pauseNoxFinansInvoice,
    unpauseNoxFinansInvoice,
    stopNoxFinansInvoice,
    takeFeesNoxFinansInvoice,
    reportNoxFinansInvoicePayment,
  } = operations;

  server.tool(
    'fortnox_get_noxfinans_invoice',
    `Hämta status för en faktura i Fortnox Finans (Fakturaservice). Skrivskyddad. Returnerar: Status (t.ex. UNKNOWN, NOT_AUTHORIZED, OPEN, PAUSED, CLOSED), Service, ServiceName (SERVICE_FULL = med automatiska påminnelser, SERVICE_LIGHT = utan, REMINDER_SERVICE), OCR-nummer, saldo inkl. avgifter, nästa händelse och länk till PDF. Efter att en faktura skickats kan det ta från en minut till flera timmar innan status, OCR och PDF finns. ${SCOPE_NOTE}`,
    { invoiceNumber: InvoiceNumberSchema, includeRaw },
    async ({ invoiceNumber, includeRaw }) => {
      const status = await getNoxFinansInvoice(invoiceNumber);
      return detailResponse(status, noxFinansInvoiceColumns, status, includeRaw);
    },
  );

  server.tool(
    'fortnox_send_noxfinans_invoice',
    `Skicka en befintlig kundfaktura med Fortnox Finans (Fakturaservice): Fortnox Finans distribuerar fakturan till kunden, sköter OCR/inbetalningsmatchning och (beroende på tjänst) påminnelser. VARNING: oåterkalleligt och avgiftsbelagt — fakturan går ut till kunden och påminnelseprocessen startar, även i ett vanligt Fortnox-testföretag (bara en särskild Fortnox Finans-sandbox är säker). Kör dryRun först. Förutsättningar enligt Fortnox: fakturan finns, öppet saldo > 0, valuta SEK, fakturadatum högst två år gammalt, namn/adress/postnummer/ort ifyllt, minst en rad, inte en räntefaktura. service: LEDGERBASE (Service Full/Light — vilken av dem styrs av företagets inställningar i Fortnox) eller REMINDER (påminnelsetjänst). sendMethod: EMAIL, LETTER, EINVOICE eller NONE (Fortnox Finans distribuerar inte; ej tillåtet med REMINDER). ${SCOPE_NOTE}`,
    {
      invoiceNumber: InvoiceNumberSchema,
      service: z.enum(NOX_FINANS_SERVICES).describe('LEDGERBASE eller REMINDER'),
      sendMethod: z.enum(NOX_FINANS_SEND_METHODS).describe('EMAIL, LETTER, EINVOICE eller NONE'),
      confirm: confirm('fakturan ska skickas med Fortnox Finans'),
      dryRun,
      includeRaw,
    },
    async ({ invoiceNumber, service, sendMethod, confirm, dryRun, includeRaw }) => {
      // Build (and validate) the payload first so an invalid combination fails
      // the same way on a dry run as on a real send.
      const payload = noxFinansSendPayload(invoiceNumber, { service, sendMethod });
      const target = `send invoice ${invoiceNumber} with Fortnox Finans (${service}, ${sendMethod})`;
      if (dryRun) return dryRunResponse(target, payload);
      if (!confirm) requireConfirmation(target);
      const status = await sendNoxFinansInvoice(invoiceNumber, { service, sendMethod });
      return confirmationResponse(
        `Faktura ${invoiceNumber} skickad till Fortnox Finans. Status, OCR och PDF kan dröja från en minut till flera timmar — följ upp med fortnox_get_noxfinans_invoice.`,
        status,
        noxFinansInvoiceColumns,
        includeRaw,
      );
    },
  );

  server.tool(
    'fortnox_pause_noxfinans_invoice',
    `Pausa Fortnox Finans påminnelseprocess för en faktura till och med ett datum (högst 60 dagar; datumet måste ligga i framtiden och, om fakturan redan är pausad, efter det tidigare datumet). Endast fakturor med status OPEN. Ej för fakturor i den gamla Noxbox-plattformen. ${SCOPE_NOTE}`,
    {
      invoiceNumber: InvoiceNumberSchema,
      pausedUntilDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
        .describe('Pausad till och med detta datum (YYYY-MM-DD)'),
      confirm: confirm('fakturan ska pausas'),
      dryRun,
      includeRaw,
    },
    async ({ invoiceNumber, pausedUntilDate, confirm, dryRun, includeRaw }) => {
      const target = `pause Fortnox Finans invoice ${invoiceNumber} until ${pausedUntilDate}`;
      if (dryRun) {
        return dryRunResponse(target, { NoxFinansInvoice: { PausedUntilDate: pausedUntilDate } });
      }
      if (!confirm) requireConfirmation(target);
      const status = await pauseNoxFinansInvoice(invoiceNumber, pausedUntilDate);
      return confirmationResponse(
        `Faktura ${invoiceNumber} pausad i Fortnox Finans till och med ${pausedUntilDate}.`,
        status,
        noxFinansInvoiceColumns,
        includeRaw,
      );
    },
  );

  const bodiless = [
    {
      name: 'fortnox_unpause_noxfinans_invoice',
      description: `Häv en manuell paus för en faktura i Fortnox Finans direkt. Fakturor som pausats av systemet kan inte återupptas. Ej för Noxbox-fakturor. ${SCOPE_NOTE}`,
      what: 'pausen ska hävas',
      action: 'unpause',
      done: 'återupptagen',
      run: unpauseNoxFinansInvoice,
    },
    {
      name: 'fortnox_stop_noxfinans_invoice',
      description: `Ta bort en faktura från Fortnox Finans process. Fakturan kan fortfarande hanteras manuellt, men ingen ytterligare automatisk process (påminnelser, inkasso) körs. Går inte att ångra via API:t. Ej för Noxbox-fakturor. ${SCOPE_NOTE}`,
      what: 'fakturan ska tas bort från Fortnox Finans process',
      action: 'stop',
      done: 'stoppad',
      run: stopNoxFinansInvoice,
    },
    {
      name: 'fortnox_take_fees_noxfinans_invoice',
      description: `Låt företaget betala de avgifter (t.ex. påminnelseavgifter) som lagts på en faktura i Fortnox Finans, i stället för kunden. Ej för Noxbox-fakturor. ${SCOPE_NOTE}`,
      what: 'företaget ska stå för fakturans avgifter',
      action: 'take fees for',
      done: 'avgifterna tas av företaget',
      run: takeFeesNoxFinansInvoice,
    },
  ] as const;

  for (const tool of bodiless) {
    server.tool(
      tool.name,
      tool.description,
      { invoiceNumber: InvoiceNumberSchema, confirm: confirm(tool.what), dryRun, includeRaw },
      async ({ invoiceNumber, confirm, dryRun, includeRaw }) => {
        const target = `${tool.action} Fortnox Finans invoice ${invoiceNumber}`;
        if (dryRun) return dryRunResponse(target);
        if (!confirm) requireConfirmation(target);
        const status = await tool.run(invoiceNumber);
        return confirmationResponse(
          `Faktura ${invoiceNumber} i Fortnox Finans: ${tool.done}.`,
          status,
          noxFinansInvoiceColumns,
          includeRaw,
        );
      },
    );
  }

  server.tool(
    'fortnox_report_noxfinans_invoice_payment',
    `Rapportera en inbetalning som kunden gjort direkt till företaget för en faktura i Fortnox Finans: bokför den i Fortnox (BookkeepPaymentInFortnox) och/eller drar av beloppet i Fortnox Finans (ReportToFinance). Normalt är båda true. PaymentMethodCode (t.ex. BG) och PaymentMethodAccount (t.ex. 1930) krävs när betalningen bokförs. Ej för Noxbox-fakturor. ${SCOPE_NOTE}`,
    {
      invoiceNumber: InvoiceNumberSchema,
      PaymentAmount: z.number().positive().describe('Inbetalt belopp (SEK)'),
      PaymentMethodCode: z
        .string()
        .min(1)
        .optional()
        .describe('Betalningssättets kod, t.ex. BG eller PG (krävs om betalningen bokförs)'),
      PaymentMethodAccount: z
        .number()
        .int()
        .min(1000)
        .max(9999)
        .optional()
        .describe('Konto att bokföra betalningen på, t.ex. 1930 (krävs om betalningen bokförs)'),
      ClientTakesFees: z.boolean().describe('Företaget står för kundens avgifter'),
      BookkeepPaymentInFortnox: z.boolean().describe('Bokför betalningen i Fortnox (normalt true)'),
      ReportToFinance: z
        .boolean()
        .describe('Rapportera betalningen till Fortnox Finans (normalt true)'),
      confirm: confirm('betalningen ska rapporteras'),
      dryRun,
      includeRaw,
    },
    async ({ invoiceNumber, confirm, dryRun, includeRaw, ...payment }) => {
      const payload = noxFinansPaymentPayload(payment);
      const target = `report a payment of ${payment.PaymentAmount} on Fortnox Finans invoice ${invoiceNumber}`;
      if (dryRun) return dryRunResponse(target, payload);
      if (!confirm) requireConfirmation(target);
      const status = await reportNoxFinansInvoicePayment(invoiceNumber, payment);
      return confirmationResponse(
        `Betalning på ${payment.PaymentAmount} rapporterad för faktura ${invoiceNumber} i Fortnox Finans.`,
        status,
        noxFinansInvoiceColumns,
        includeRaw,
      );
    },
  );
}
