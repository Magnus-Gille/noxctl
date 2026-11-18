import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from '../../src/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/auth.js', () => ({ getValidToken: vi.fn().mockResolvedValue('mock-token') }));

const STATUS = {
  NoxFinansInvoice: {
    InvoiceNumber: 7201,
    Service: 'LEDGERBASE',
    ServiceName: 'SERVICE_LIGHT',
    Status: 'UNKNOWN',
    OCRNumber: '',
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

async function client(readOnly = false) {
  const server = createServer({ readOnly });
  const connected = new Client({ name: 'test-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), connected.connect(a)]);
  return connected;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

const MUTATIONS = [
  ['fortnox_send_noxfinans_invoice', { service: 'LEDGERBASE', sendMethod: 'EMAIL' }],
  ['fortnox_pause_noxfinans_invoice', { pausedUntilDate: '2026-12-15' }],
  ['fortnox_unpause_noxfinans_invoice', {}],
  ['fortnox_stop_noxfinans_invoice', {}],
  ['fortnox_take_fees_noxfinans_invoice', {}],
  [
    'fortnox_report_noxfinans_invoice_payment',
    {
      PaymentAmount: 100,
      PaymentMethodCode: 'BG',
      PaymentMethodAccount: 1930,
      ClientTakesFees: false,
      BookkeepPaymentInFortnox: true,
      ReportToFinance: true,
    },
  ],
] as const;

describe('Fortnox Finans MCP tools', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the Fortnox Finans status as a read-only tool', async () => {
    mockFetch();
    const tools = await client();
    const listed = (await tools.listTools()).tools.find(
      ({ name }) => name === 'fortnox_get_noxfinans_invoice',
    );
    expect(listed?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(listed?.inputSchema.properties ?? {})).not.toContain('confirm');

    const result = await tools.callTool({
      name: 'fortnox_get_noxfinans_invoice',
      arguments: { invoiceNumber: '7201' },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('SERVICE_LIGHT');
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://api.fortnox.se/3/noxfinansinvoices/7201',
    );
  });

  it.each(MUTATIONS)('%s refuses to run without confirm', async (name, args) => {
    global.fetch = vi.fn();
    const result = await (
      await client()
    ).callTool({ name, arguments: { invoiceNumber: '7201', ...args } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Confirmation required/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)('%s dryRun sends nothing to Fortnox', async (name, args) => {
    global.fetch = vi.fn();
    const result = await (
      await client()
    ).callTool({ name, arguments: { invoiceNumber: '7201', ...args, dryRun: true } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/Dry run/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the exact send payload on dryRun', async () => {
    global.fetch = vi.fn();
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_send_noxfinans_invoice',
      arguments: { invoiceNumber: '7201', service: 'REMINDER', sendMethod: 'LETTER', dryRun: true },
    });

    expect(textOf(result)).toContain('"Service": "REMINDER"');
    expect(textOf(result)).toContain('"SendMethod": "LETTER"');
    expect(textOf(result)).toContain('"InvoiceNumber": "7201"');
  });

  it('rejects an invalid combination even on dryRun', async () => {
    global.fetch = vi.fn();
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_send_noxfinans_invoice',
      arguments: { invoiceNumber: '7201', service: 'REMINDER', sendMethod: 'NONE', dryRun: true },
    });

    expect(result.isError).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends with confirm and reports the returned status', async () => {
    mockFetch();
    const result = await (
      await client()
    ).callTool({
      name: 'fortnox_send_noxfinans_invoice',
      arguments: {
        invoiceNumber: '7201',
        service: 'LEDGERBASE',
        sendMethod: 'EMAIL',
        confirm: true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('UNKNOWN');
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.fortnox.se/3/noxfinansinvoices');
    expect(init.method).toBe('POST');
  });

  it('marks send, stop, take-fees and report-payment as destructive', async () => {
    const tools = (await (await client()).listTools()).tools;
    const hint = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const name of [
      'fortnox_send_noxfinans_invoice',
      'fortnox_stop_noxfinans_invoice',
      'fortnox_take_fees_noxfinans_invoice',
      'fortnox_report_noxfinans_invoice_payment',
    ]) {
      expect(hint(name)?.destructiveHint).toBe(true);
    }
    expect(hint('fortnox_pause_noxfinans_invoice')?.destructiveHint).toBe(false);
    expect(hint('fortnox_unpause_noxfinans_invoice')?.destructiveHint).toBe(false);
  });

  it('registers only the status read on a read-only server', async () => {
    const names = (await (await client(true)).listTools()).tools.map((t) => t.name);
    expect(names).toContain('fortnox_get_noxfinans_invoice');
    for (const [name] of MUTATIONS) expect(names).not.toContain(name);
  });
});
