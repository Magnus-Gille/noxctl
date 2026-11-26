import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { formatDetail } from '../src/formatter.js';
import { invoiceDetailColumns, invoiceConfirmColumns } from '../src/views.js';
import { buildInvoiceSendPlan, formatInvoiceSendPlan } from '../src/invoice-send-plan.js';

vi.mock('../src/auth.js', () => ({
  getValidToken: vi.fn().mockResolvedValue('mock-token'),
  getResolvedProfile: vi.fn().mockReturnValue('default'),
}));

function mockFetch(response: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  });
}

async function connect() {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0].text;

afterEach(() => {
  vi.restoreAllMocks();
});

// GitHub #253: TermsOfPayment on invoice create/update.
describe('invoice TermsOfPayment (MCP)', () => {
  it('advertises TermsOfPayment on create and update', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ['fortnox_create_invoice', 'fortnox_update_invoice']) {
      const tool = tools.find((t) => t.name === name);
      const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.TermsOfPayment, name).toBeDefined();
    }
  });

  it('sends TermsOfPayment together with DueDate on create', async () => {
    mockFetch({ Invoice: { DocumentNumber: '1', CustomerNumber: '42' } });
    const client = await connect();
    const result = await client.callTool({
      name: 'fortnox_create_invoice',
      arguments: {
        CustomerNumber: '42',
        InvoiceRows: [{ Description: 'X', DeliveredQuantity: 1, Price: 100 }],
        TermsOfPayment: '5',
        DueDate: '2026-11-25',
        confirm: true,
      },
    });
    expect(result.isError).not.toBe(true);
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.Invoice.TermsOfPayment).toBe('5');
    expect(body.Invoice.DueDate).toBe('2026-11-25');
  });

  it('sends TermsOfPayment on update', async () => {
    mockFetch({ Invoice: { DocumentNumber: '28' } });
    const client = await connect();
    const result = await client.callTool({
      name: 'fortnox_update_invoice',
      arguments: { documentNumber: '28', TermsOfPayment: '30', confirm: true },
    });
    expect(result.isError).not.toBe(true);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ Invoice: { TermsOfPayment: '30' } });
  });

  it('shows the terms of payment in the invoice detail view', () => {
    const text = formatDetail({ DocumentNumber: '1', TermsOfPayment: '5' }, invoiceDetailColumns);
    expect(text).toMatch(/Terms of Payment\s+5/);
  });
});

// GitHub #261: Sent stays false for invoices handled by Fortnox Finans.
describe('Fortnox Finans invoices and the Sent flag', () => {
  const finans = { DocumentNumber: '77', NoxFinans: true, Sent: false, OutboundDate: '2026-11-20' };

  it('does not render Sent: No for a Fortnox Finans invoice', () => {
    for (const columns of [invoiceDetailColumns, invoiceConfirmColumns]) {
      const text = formatDetail(finans, columns);
      const sentLine = text.split('\n').find((l) => l.trim().startsWith('Sent'));
      expect(sentLine).toBeDefined();
      expect(sentLine).not.toMatch(/\bNo\b/);
      expect(sentLine).toMatch(/Fortnox Finans/);
      // Finans may hold an invoice without distributing it (sendMethod NONE), or
      // still be processing it: the label must not claim delivery.
      const value = sentLine!.replace(/^\s*Sent\s+/, '');
      expect(value).not.toMatch(/\bvia\b|\bsent (via|by|through)\b/i);
      expect(value).toMatch(/^Unknown/);
    }
  });

  it('keeps Yes/No for ordinary invoices', () => {
    expect(formatDetail({ Sent: false, NoxFinans: false }, invoiceDetailColumns)).toMatch(
      /Sent\s+No/,
    );
    expect(formatDetail({ Sent: true }, invoiceDetailColumns)).toMatch(/Sent\s+Yes/);
  });

  it('fortnox_get_invoice text does not claim the Finans invoice is unsent', async () => {
    mockFetch({ Invoice: finans });
    const client = await connect();
    const text = textOf(
      await client.callTool({ name: 'fortnox_get_invoice', arguments: { documentNumber: '77' } }),
    );
    expect(text).not.toMatch(/Sent\s+No/);
    expect(text).toMatch(/fortnox_get_noxfinans_invoice/);
  });

  it('documents the caveat in the get and list tool descriptions', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ['fortnox_get_invoice', 'fortnox_list_invoices']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      expect(description, name).toMatch(/Fortnox Finans/);
      // NoxFinans: true does not mean the invoice was distributed (sendMethod NONE, pending).
      expect(description, name).not.toMatch(/skickats via Fortnox Finans/);
      expect(description, name).toMatch(/leveransstatus är okänd/);
    }
  });

  it('warns in the send preview that a Finans invoice is already handled by Fortnox Finans', () => {
    const plan = buildInvoiceSendPlan({
      invoice: { ...finans, CustomerNumber: '1', EmailInformation: {} },
      customer: null,
      attachments: [],
      method: 'email',
      options: {},
    });
    expect(plan.status.noxFinans).toBe(true);
    expect(plan.warnings.join('\n')).toMatch(/Fortnox Finans/);
    const statusLine = formatInvoiceSendPlan(plan)
      .split('\n')
      .find((l) => l.trim().startsWith('Status:'));
    expect(statusLine).toBeDefined();
    expect(statusLine).not.toMatch(/sent via/i);
    expect(statusLine).toMatch(/sent unknown/i);
    expect(statusLine).toMatch(/Fortnox Finans/);
  });
});

// GitHub #253: CLI flag.
const CLI_PATH = path.resolve('dist/cli.js');

function run(args: string[], input = '') {
  const tmpHome = mkdtempSync(path.join(tmpdir(), 'noxctl-terms-home-'));
  try {
    return spawnSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, NOXCTL_PROFILE: 'default' },
      input,
      timeout: 30_000,
    });
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function payloadOf(output: string): unknown {
  const marker = 'Request payload:\n';
  const start = output.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(start + marker.length));
}

describe('noxctl invoices --terms-of-payment', () => {
  it('adds TermsOfPayment to a create preview', () => {
    const result = run(
      [
        'invoices',
        'create',
        '--customer',
        '25',
        '--input',
        '-',
        '--terms-of-payment',
        '5',
        '--dry-run',
      ],
      JSON.stringify({ InvoiceRows: [{ Description: 'X', DeliveredQuantity: 1, Price: 1 }] }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      Invoice: {
        CustomerNumber: '25',
        InvoiceRows: [{ Description: 'X', DeliveredQuantity: 1, Price: 1 }],
        TermsOfPayment: '5',
      },
    });
  });

  it('lets update run with only --terms-of-payment', () => {
    const result = run(['invoices', 'update', '28', '--terms-of-payment', '30', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({ Invoice: { TermsOfPayment: '30' } });
  });

  it('lets the flag override TermsOfPayment from the JSON input on update', () => {
    const result = run(
      ['invoices', 'update', '28', '--input', '-', '--terms-of-payment', '10', '--dry-run'],
      JSON.stringify({ DueDate: '2026-12-01', TermsOfPayment: '30' }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(payloadOf(result.stdout)).toEqual({
      Invoice: { DueDate: '2026-12-01', TermsOfPayment: '10' },
    });
  });

  it('refuses update with neither --input nor --terms-of-payment', () => {
    const result = run(['invoices', 'update', '28', '--dry-run']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--input|--terms-of-payment/);
  });
});
