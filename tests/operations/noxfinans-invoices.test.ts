import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
}));

const STATUS = {
  NoxFinansInvoice: {
    '@url': 'https://api.fortnox.se/3/noxfinansinvoices/7201',
    InvoiceNumber: 7201,
    Service: 'LEDGERBASE',
    ServiceName: 'SERVICE_FULL',
    Status: 'OPEN',
    OCRNumber: '123456789',
    BalanceIncludeFees: 1250,
    CurrentCapitalBalance: 1250,
    NextEvent: 'INVOICEREMINDER',
    NextEventDate: '2026-12-01',
  },
};

function mockFetch(response: unknown = STATUS) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
    headers: { get: () => null },
  });
}

function fetchCall(index = 0): [string, { method?: string; body?: string }] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls[index] as [
    string,
    { method?: string; body?: string },
  ];
}

async function ops() {
  return import('../../src/operations/noxfinans-invoices.js');
}

describe('Fortnox Finans (noxfinansinvoices) operations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the Fortnox Finans status of an invoice', async () => {
    mockFetch();
    const { getNoxFinansInvoice } = await ops();

    const status = await getNoxFinansInvoice('7201');

    const [url, init] = fetchCall();
    expect(url).toBe('https://api.fortnox.se/3/noxfinansinvoices/7201');
    expect(init.method ?? 'GET').toBe('GET');
    expect(status.Status).toBe('OPEN');
    expect(status.ServiceName).toBe('SERVICE_FULL');
  });

  it('rejects a non-numeric invoice number before any request', async () => {
    global.fetch = vi.fn();
    const { getNoxFinansInvoice, stopNoxFinansInvoice } = await ops();

    await expect(getNoxFinansInvoice('../invoices')).rejects.toThrow(/document number/);
    await expect(stopNoxFinansInvoice('7201/stop')).rejects.toThrow(/document number/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends an invoice to Fortnox Finans with the documented POST body', async () => {
    mockFetch();
    const { sendNoxFinansInvoice } = await ops();

    await sendNoxFinansInvoice('7201', { service: 'LEDGERBASE', sendMethod: 'EMAIL' });

    const [url, init] = fetchCall();
    expect(url).toBe('https://api.fortnox.se/3/noxfinansinvoices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body ?? 'null')).toEqual({
      NoxFinansInvoice: { InvoiceNumber: '7201', SendMethod: 'EMAIL', Service: 'LEDGERBASE' },
    });
  });

  it('builds the send payload without calling Fortnox (dry-run helper)', async () => {
    global.fetch = vi.fn();
    const { noxFinansSendPayload } = await ops();

    expect(noxFinansSendPayload('7201', { service: 'REMINDER', sendMethod: 'LETTER' })).toEqual({
      NoxFinansInvoice: { InvoiceNumber: '7201', SendMethod: 'LETTER', Service: 'REMINDER' },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses SendMethod NONE with the reminder service, as Fortnox documents', async () => {
    global.fetch = vi.fn();
    const { sendNoxFinansInvoice } = await ops();

    await expect(
      sendNoxFinansInvoice('7201', { service: 'REMINDER', sendMethod: 'NONE' }),
    ).rejects.toThrow(/NONE/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses unknown service and send-method values', async () => {
    global.fetch = vi.fn();
    const { sendNoxFinansInvoice } = await ops();

    await expect(
      sendNoxFinansInvoice('7201', {
        service: 'SERVICE_LIGHT' as never,
        sendMethod: 'EMAIL',
      }),
    ).rejects.toThrow(/service/i);
    await expect(
      sendNoxFinansInvoice('7201', { service: 'LEDGERBASE', sendMethod: 'SMS' as never }),
    ).rejects.toThrow(/send method/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('pauses an invoice until a date', async () => {
    mockFetch();
    const { pauseNoxFinansInvoice } = await ops();

    await pauseNoxFinansInvoice('7201', '2026-12-15');

    const [url, init] = fetchCall();
    expect(url).toBe('https://api.fortnox.se/3/noxfinansinvoices/7201/pause');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body ?? 'null')).toEqual({
      NoxFinansInvoice: { PausedUntilDate: '2026-12-15' },
    });
  });

  it('rejects a malformed pause date before any request', async () => {
    global.fetch = vi.fn();
    const { pauseNoxFinansInvoice } = await ops();

    await expect(pauseNoxFinansInvoice('7201', '15/12/2026')).rejects.toThrow(/YYYY-MM-DD/);
    await expect(pauseNoxFinansInvoice('7201', '2026-02-30')).rejects.toThrow(/YYYY-MM-DD/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['unpauseNoxFinansInvoice', 'unpause'],
    ['stopNoxFinansInvoice', 'stop'],
    ['takeFeesNoxFinansInvoice', 'take-fees'],
  ] as const)('%s sends a bodiless PUT to /%s', async (name, action) => {
    mockFetch();
    const operations = await ops();

    const result = await operations[name]('7201');

    const [url, init] = fetchCall();
    expect(url).toBe(`https://api.fortnox.se/3/noxfinansinvoices/7201/${action}`);
    expect(init.method).toBe('PUT');
    expect(init.body).toBeUndefined();
    expect(result.InvoiceNumber).toBe(7201);
  });

  it('reports a payment with the documented body', async () => {
    mockFetch();
    const { reportNoxFinansInvoicePayment } = await ops();

    const payment = {
      PaymentAmount: 500,
      PaymentMethodCode: 'BG',
      PaymentMethodAccount: 1930,
      ClientTakesFees: false,
      BookkeepPaymentInFortnox: true,
      ReportToFinance: true,
    };
    await reportNoxFinansInvoicePayment('7201', payment);

    const [url, init] = fetchCall();
    expect(url).toBe('https://api.fortnox.se/3/noxfinansinvoices/7201/report-payment');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body ?? 'null')).toEqual({ NoxFinansInvoice: payment });
  });

  it('requires a payment method code and account when the payment is bookkept', async () => {
    global.fetch = vi.fn();
    const { reportNoxFinansInvoicePayment } = await ops();

    await expect(
      reportNoxFinansInvoicePayment('7201', {
        PaymentAmount: 500,
        ClientTakesFees: false,
        BookkeepPaymentInFortnox: true,
        ReportToFinance: true,
      }),
    ).rejects.toThrow(/PaymentMethodCode/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-positive payment amount', async () => {
    global.fetch = vi.fn();
    const { reportNoxFinansInvoicePayment } = await ops();

    await expect(
      reportNoxFinansInvoicePayment('7201', {
        PaymentAmount: 0,
        ClientTakesFees: false,
        BookkeepPaymentInFortnox: false,
        ReportToFinance: true,
      }),
    ).rejects.toThrow(/PaymentAmount/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
