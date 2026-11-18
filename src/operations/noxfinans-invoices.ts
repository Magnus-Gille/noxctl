import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { documentSegment } from '../identifiers.js';

// Fortnox Finans (Fakturaservice): hand an existing customer invoice to Fortnox
// Finans for distribution, OCR/payment matching and (optionally) automatic
// reminders, and manage it once it is there. Endpoint family
// `/3/noxfinansinvoices`; needs the `noxfinansinvoice` OAuth scope
// (`noxctl init --with-noxfinans`) and Fortnox Finans activated on the company.
//
// Every call except the status read has real-world effects: sending distributes
// the invoice to the customer, starts the reminder process and is charged by
// Fortnox. Fortnox documents that even a regular sandbox company sends real
// invoices here; only a dedicated Fortnox Finans sandbox does not.

export const NOX_FINANS_SERVICES = ['LEDGERBASE', 'REMINDER'] as const;
export type NoxFinansService = (typeof NOX_FINANS_SERVICES)[number];

export const NOX_FINANS_SEND_METHODS = ['EMAIL', 'LETTER', 'EINVOICE', 'NONE'] as const;
export type NoxFinansSendMethod = (typeof NOX_FINANS_SEND_METHODS)[number];

export interface SendNoxFinansInvoiceParams {
  service: NoxFinansService;
  sendMethod: NoxFinansSendMethod;
}

export interface NoxFinansPaymentReport {
  PaymentAmount: number;
  PaymentMethodCode?: string;
  PaymentMethodAccount?: number;
  ClientTakesFees: boolean;
  BookkeepPaymentInFortnox: boolean;
  ReportToFinance: boolean;
}

interface NoxFinansInvoiceResponse {
  NoxFinansInvoice: Record<string, unknown>;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertIsoDate(name: string, value: string): void {
  const match = ISO_DATE.exec(value);
  const valid =
    match !== null &&
    (() => {
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    })();
  if (!valid) throw new Error(`Invalid ${name}: ${value} (expected a real date as YYYY-MM-DD)`);
}

/** The exact POST body for handing an invoice to Fortnox Finans. Validates, never calls Fortnox. */
export function noxFinansSendPayload(
  invoiceNumber: string,
  params: SendNoxFinansInvoiceParams,
): { NoxFinansInvoice: { InvoiceNumber: string; SendMethod: string; Service: string } } {
  documentSegment(invoiceNumber);
  if (!(NOX_FINANS_SERVICES as readonly string[]).includes(params.service)) {
    throw new Error(
      `Invalid Fortnox Finans service: ${String(params.service)} (expected ${NOX_FINANS_SERVICES.join(' or ')})`,
    );
  }
  if (!(NOX_FINANS_SEND_METHODS as readonly string[]).includes(params.sendMethod)) {
    throw new Error(
      `Invalid Fortnox Finans send method: ${String(params.sendMethod)} (expected ${NOX_FINANS_SEND_METHODS.join(', ')})`,
    );
  }
  if (params.service === 'REMINDER' && params.sendMethod === 'NONE') {
    throw new Error('Send method NONE cannot be used with the REMINDER service.');
  }
  return {
    NoxFinansInvoice: {
      InvoiceNumber: invoiceNumber,
      SendMethod: params.sendMethod,
      Service: params.service,
    },
  };
}

/** The exact PUT body for reporting a payment. Validates, never calls Fortnox. */
export function noxFinansPaymentPayload(payment: NoxFinansPaymentReport): {
  NoxFinansInvoice: NoxFinansPaymentReport;
} {
  if (!Number.isFinite(payment.PaymentAmount) || payment.PaymentAmount <= 0) {
    throw new Error('PaymentAmount must be a positive amount.');
  }
  if (payment.BookkeepPaymentInFortnox) {
    if (!payment.PaymentMethodCode?.trim()) {
      throw new Error('PaymentMethodCode is required when BookkeepPaymentInFortnox is true.');
    }
    if (
      payment.PaymentMethodAccount === undefined ||
      !Number.isInteger(payment.PaymentMethodAccount) ||
      payment.PaymentMethodAccount < 1000 ||
      payment.PaymentMethodAccount > 9999
    ) {
      throw new Error(
        'PaymentMethodAccount (a four-digit account, e.g. 1930) is required when BookkeepPaymentInFortnox is true.',
      );
    }
  }
  return { NoxFinansInvoice: { ...payment } };
}

export function createNoxFinansInvoiceOperations(transport: FortnoxTransport) {
  const base = (invoiceNumber: string) => `noxfinansinvoices/${documentSegment(invoiceNumber)}`;

  async function action(
    invoiceNumber: string,
    name: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const data = await transport.request<NoxFinansInvoiceResponse>(
      `${base(invoiceNumber)}/${name}`,
      body === undefined ? { method: 'PUT' } : { method: 'PUT', body },
    );
    return data?.NoxFinansInvoice ?? {};
  }

  async function getNoxFinansInvoice(invoiceNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<NoxFinansInvoiceResponse>(base(invoiceNumber));
    return data.NoxFinansInvoice;
  }

  async function sendNoxFinansInvoice(
    invoiceNumber: string,
    params: SendNoxFinansInvoiceParams,
  ): Promise<Record<string, unknown>> {
    const body = noxFinansSendPayload(invoiceNumber, params);
    const data = await transport.request<NoxFinansInvoiceResponse>('noxfinansinvoices', {
      method: 'POST',
      body,
    });
    return data.NoxFinansInvoice;
  }

  async function pauseNoxFinansInvoice(
    invoiceNumber: string,
    pausedUntilDate: string,
  ): Promise<Record<string, unknown>> {
    documentSegment(invoiceNumber);
    assertIsoDate('pause date', pausedUntilDate);
    return action(invoiceNumber, 'pause', {
      NoxFinansInvoice: { PausedUntilDate: pausedUntilDate },
    });
  }

  async function unpauseNoxFinansInvoice(invoiceNumber: string) {
    return action(invoiceNumber, 'unpause');
  }

  async function stopNoxFinansInvoice(invoiceNumber: string) {
    return action(invoiceNumber, 'stop');
  }

  async function takeFeesNoxFinansInvoice(invoiceNumber: string) {
    return action(invoiceNumber, 'take-fees');
  }

  async function reportNoxFinansInvoicePayment(
    invoiceNumber: string,
    payment: NoxFinansPaymentReport,
  ): Promise<Record<string, unknown>> {
    documentSegment(invoiceNumber);
    return action(invoiceNumber, 'report-payment', noxFinansPaymentPayload(payment));
  }

  return {
    getNoxFinansInvoice,
    sendNoxFinansInvoice,
    pauseNoxFinansInvoice,
    unpauseNoxFinansInvoice,
    stopNoxFinansInvoice,
    takeFeesNoxFinansInvoice,
    reportNoxFinansInvoicePayment,
  };
}

export const {
  getNoxFinansInvoice,
  sendNoxFinansInvoice,
  pauseNoxFinansInvoice,
  unpauseNoxFinansInvoice,
  stopNoxFinansInvoice,
  takeFeesNoxFinansInvoice,
  reportNoxFinansInvoicePayment,
} = createNoxFinansInvoiceOperations(defaultFortnoxTransport);
