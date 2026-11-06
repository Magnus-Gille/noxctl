import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/embedded.js';
import { createInvoiceOperations } from '../../src/operations/invoices.js';
import { createFortnoxOperations } from '../../src/operations/index.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createQueueObserver } from '../../src/shadow/observer.js';
import { canonicalEncode, openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';
import { AccountedMasterDataAdapter } from '../../src/shadow/accounted-adapter.js';
import {
  TargetNotDispatchedError,
  TargetReceiptPendingError,
  type ShadowAdapter,
  type ShadowBinding,
  type ShadowRecord,
} from '../../src/shadow/types.js';

/**
 * LOCAL SIMULATION ONLY. This is not an Accounted invoice adapter and makes no
 * claim of Fortnox/Accounted parity. The credit convention below is a synthetic
 * correction model, not a verified Fortnox accounting or cash-refund behavior.
 */

const binding: ShadowBinding = {
  sourceCompany: 'synthetic-fortnox-company',
  targetCompany: 'synthetic-accounted-company',
};
const invoiceNumber = '1000';
const creditNumber = '2000';
const paymentNumber = '5000';
const invoiceInput = {
  CustomerNumber: 'CUSTOMER-1',
  InvoiceRows: [
    {
      ArticleNumber: 'SYNTH-1000',
      DeliveredQuantity: 1,
      Description: 'Synthetic service',
      Price: 1000,
      VAT: 25,
    },
  ],
};
const expectedPaymentJournal = [
  { account: '1930', debit: 1250 },
  { account: '3001', credit: 1000 },
  { account: '2611', credit: 250 },
];
const expectedCreditJournal = [
  { account: '3001', debit: 1000 },
  { account: '2611', debit: 250 },
  { account: '1930', credit: 1250 },
];

type JournalLine = { account: string; debit?: number; credit?: number };
type InvoiceState = {
  number: string;
  targetId?: string;
  total: number;
  vat: number;
  sent: boolean;
  booked: boolean;
  creditOf?: string;
  ledger: JournalLine[];
};

function totalFromInput(input: Record<string, unknown>): { total: number; vat: number } {
  const rows = input.InvoiceRows;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Synthetic invoice row required');
  const row = rows[0] as Record<string, unknown>;
  const net = Number(row.Price) * Number(row.DeliveredQuantity);
  const vat = Math.round((net * Number(row.VAT)) / 100);
  return { total: net + vat, vat };
}

function targetTotalsFromInput(input: Record<string, unknown>): { total: number; vat: number } {
  const rows = input.InvoiceRows;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Target invoice row required');
  const row = rows[0] as Record<string, unknown>;
  const quantity = Number(row.DeliveredQuantity);
  const net = Number(row.Price) * quantity;
  const vat = Math.round((net * Number(row.VAT)) / 100);
  return { total: net + vat, vat };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function accountBalances(journal: JournalLine[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of journal) {
    result[line.account] = (result[line.account] ?? 0) + (line.debit ?? 0) - (line.credit ?? 0);
  }
  return result;
}

/** Stateful source transport with a closed allow-list of synthetic routes. */
class FakeFortnoxTransport implements FortnoxTransport {
  readonly calls: Array<{ endpoint: string; method: string }> = [];
  readonly invoices = new Map<string, InvoiceState>();
  readonly payments = new Map<
    string,
    { invoiceNumber: string; amount: number; booked: boolean; ledger: JournalLine[] }
  >();
  failPrintReadback = false;

  async request<T>(
    endpoint: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    this.calls.push({ endpoint, method });
    if (endpoint === 'invoices' && method === 'POST') {
      const input = clone((options.body as { Invoice: Record<string, unknown> }).Invoice);
      const { total, vat } = totalFromInput(input);
      const result: InvoiceState = {
        number: invoiceNumber,
        total,
        vat,
        sent: false,
        booked: false,
        ledger: [],
      };
      this.invoices.set(invoiceNumber, result);
      return { Invoice: this.invoicePayload(result) } as T;
    }
    const invoiceMatch = /^invoices\/([^/]+)(?:\/([^/]+))?$/.exec(endpoint);
    if (invoiceMatch) {
      const number = invoiceMatch[1]!;
      const action = invoiceMatch[2];
      if (action === undefined && method === 'GET') {
        if (this.failPrintReadback) throw new Error('synthetic print readback outage');
        return { Invoice: this.invoicePayload(this.requireInvoice(number)) } as T;
      }
      const invoice = this.requireInvoice(number);
      if (action === 'externalprint' && method === 'PUT') {
        invoice.sent = true;
        return { Invoice: this.invoicePayload(invoice) } as T;
      }
      if (action === 'bookkeep' && method === 'PUT') {
        invoice.booked = true;
        invoice.ledger = invoice.creditOf ? this.creditJournal(invoice) : [];
        return { Invoice: this.invoicePayload(invoice) } as T;
      }
      if (action === 'credit' && method === 'PUT') {
        const credit: InvoiceState = {
          number: creditNumber,
          total: -invoice.total,
          vat: -invoice.vat,
          sent: false,
          booked: false,
          creditOf: invoice.number,
          ledger: [],
        };
        this.invoices.set(creditNumber, credit);
        return { Invoice: this.invoicePayload(credit) } as T;
      }
      throw new Error(`Unknown synthetic Fortnox invoice operation: ${method} ${endpoint}`);
    }
    if (endpoint === 'invoicepayments' && method === 'POST') {
      const input = clone(
        (options.body as { InvoicePayment: Record<string, unknown> }).InvoicePayment,
      );
      const number = String(input.InvoiceNumber);
      const amount = Number(input.Amount);
      this.requireInvoice(number);
      this.payments.set(paymentNumber, {
        invoiceNumber: number,
        amount,
        booked: false,
        ledger: [],
      });
      return {
        InvoicePayment: { ...input, Number: paymentNumber, InvoiceNumber: number, Amount: amount },
      } as T;
    }
    const paymentMatch = /^invoicepayments\/([^/]+)(?:\/([^/]+))?$/.exec(endpoint);
    if (paymentMatch && paymentMatch[2] === 'bookkeep' && method === 'PUT') {
      const payment = this.payments.get(paymentMatch[1]!);
      if (!payment) throw new Error(`Unknown synthetic payment ${paymentMatch[1]}`);
      payment.booked = true;
      const invoice = this.requireInvoice(payment.invoiceNumber);
      payment.ledger = this.cashJournal(invoice.total, invoice.vat);
      return { InvoicePayment: { Number: paymentMatch[1], ...payment } } as T;
    }
    throw new Error(`Unknown synthetic Fortnox path or operation: ${method} ${endpoint}`);
  }

  async requestWithMetadata<T>(): Promise<T> {
    throw new Error('Unknown synthetic Fortnox operation: requestWithMetadata');
  }
  async requestPdf(): Promise<Buffer> {
    throw new Error('Unknown synthetic Fortnox operation: requestPdf');
  }
  async requestPdfFromMutation(endpoint: string): Promise<Buffer | undefined> {
    if (endpoint !== `invoices/${invoiceNumber}/print`) {
      throw new Error(`Unknown synthetic Fortnox PDF operation: ${endpoint}`);
    }
    this.requireInvoice(invoiceNumber).sent = true;
    return Buffer.from('%PDF-synthetic');
  }
  async requestFile(): Promise<never> {
    throw new Error('Unknown synthetic Fortnox operation: requestFile');
  }
  async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
    items: T[];
    totalResources: number;
  }> {
    throw new Error('Unknown synthetic Fortnox operation: fetchAllPages');
  }

  private requireInvoice(number: string): InvoiceState {
    const invoice = this.invoices.get(number);
    if (!invoice) throw new Error(`Unknown synthetic invoice ${number}`);
    return invoice;
  }
  private invoicePayload(invoice: InvoiceState): Record<string, unknown> {
    return {
      DocumentNumber: invoice.number,
      Total: invoice.total,
      TotalVAT: invoice.vat,
      Sent: invoice.sent,
      Booked: invoice.booked,
      CreditOf: invoice.creditOf,
      Ledger: clone(invoice.ledger),
    };
  }
  private cashJournal(total: number, vat: number): JournalLine[] {
    return [
      { account: '1930', debit: total },
      { account: '3001', credit: total - vat },
      { account: '2611', credit: vat },
    ];
  }
  private creditJournal(invoice: InvoiceState): JournalLine[] {
    const total = Math.abs(invoice.total);
    const vat = Math.abs(invoice.vat);
    return [
      { account: '3001', debit: total - vat },
      { account: '2611', debit: vat },
      { account: '1930', credit: total },
    ];
  }
}

type TargetModel = {
  mode: 'local-simulation';
  invoices: Map<string, InvoiceState>;
  payments: Map<
    string,
    { invoiceNumber: string; amount: number; booked: boolean; ledger: JournalLine[] }
  >;
  ledger: JournalLine[];
  applyCalls: string[];
  verifyCalls: number;
  nextId: number;
};

function targetModel(): TargetModel {
  return {
    mode: 'local-simulation',
    invoices: new Map(),
    payments: new Map(),
    ledger: [],
    applyCalls: [],
    verifyCalls: 0,
    nextId: 1,
  };
}

type AdapterOptions = {
  offlineBeforeDispatch?: boolean;
  receiptPendingOnCreate?: boolean;
  unknownAfterDispatch?: boolean;
};

/**
 * Test-only target model. It computes totals from operation inputs and rejects
 * every path/kind outside its explicit synthetic route catalogue. It is not
 * exported from production and must not be read as native Accounted support.
 */
class SimulatedTargetInvoiceAdapter implements ShadowAdapter {
  constructor(
    private readonly model: TargetModel,
    private readonly options: AdapterOptions = {},
  ) {}

  prepare(record: ShadowRecord): { request: unknown } | { blocked: string } {
    if (
      record.sourceCompany !== binding.sourceCompany ||
      record.targetCompany !== binding.targetCompany
    ) {
      return { blocked: 'Synthetic target company binding mismatch.' };
    }
    const args = record.args;
    if (record.operation === 'createInvoice' && args.length === 1 && this.isObject(args[0])) {
      const totals = targetTotalsFromInput(args[0]);
      return {
        request: {
          kind: 'invoice-create',
          total: totals.total,
          vat: totals.vat,
          input: clone(args[0]),
        },
      };
    }
    if (
      ((record.operation === 'externalPrintInvoice' && args.length === 1) ||
        (record.operation === 'sendInvoice' && args.length === 2 && args[1] === 'print')) &&
      typeof args[0] === 'string'
    ) {
      if (
        !this.isObject(record.sourceResult) ||
        record.sourceResult.Sent !== true ||
        record.sourceResult.DocumentNumber !== args[0]
      ) {
        return { blocked: 'Synthetic print requires source readback confirmation.' };
      }
      return { request: { kind: 'invoice-print', number: args[0] } };
    }
    if (
      record.operation === 'bookkeepInvoice' &&
      args.length === 1 &&
      typeof args[0] === 'string'
    ) {
      return {
        request: {
          kind: args[0] === creditNumber ? 'credit-bookkeep' : 'invoice-bookkeep',
          number: args[0],
        },
      };
    }
    if (
      record.operation === 'createInvoicePayment' &&
      args.length === 1 &&
      this.isObject(args[0])
    ) {
      const number = String(args[0].InvoiceNumber ?? '');
      const amount = Number(args[0].Amount);
      const invoice = this.model.invoices.get(number);
      if (!invoice || amount !== invoice.total) {
        return { blocked: 'Partial or unknown synthetic payment is unsupported.' };
      }
      return { request: { kind: 'payment-create', number, amount } };
    }
    if (
      record.operation === 'bookkeepInvoicePayment' &&
      args.length === 1 &&
      typeof args[0] === 'string'
    ) {
      if (!this.model.payments.has(args[0])) {
        return { blocked: 'Unknown synthetic target payment.' };
      }
      return { request: { kind: 'payment-bookkeep', number: args[0] } };
    }
    if (record.operation === 'creditInvoice' && args.length === 1 && typeof args[0] === 'string') {
      return { request: { kind: 'credit-create', number: args[0] } };
    }
    return { blocked: `Unsupported synthetic target operation: ${record.operation}` };
  }

  async apply(
    record: ShadowRecord,
    request: unknown,
  ): Promise<{ targetId: string; receipt: unknown }> {
    const prepared = this.prepare(record);
    if (
      !('request' in prepared) ||
      canonicalEncode(prepared.request) !== canonicalEncode(request)
    ) {
      throw new Error('Synthetic target request does not match its prepared operation.');
    }
    const typed = request as {
      kind: string;
      number?: string;
      total?: number;
      vat?: number;
      amount?: number;
    };
    if (this.options.offlineBeforeDispatch) {
      this.options.offlineBeforeDispatch = false;
      throw new TargetNotDispatchedError();
    }
    this.model.applyCalls.push(record.operation);
    if (typed.kind === 'invoice-create') {
      const targetId = `target-invoice-${this.model.nextId++}`;
      this.model.invoices.set(invoiceNumber, {
        number: invoiceNumber,
        targetId,
        total: typed.total!,
        vat: typed.vat!,
        sent: false,
        booked: false,
        ledger: [],
      });
      const receipt = { targetId, kind: typed.kind, total: typed.total };
      if (this.options.receiptPendingOnCreate) {
        this.options.receiptPendingOnCreate = false;
        throw new TargetReceiptPendingError(targetId, receipt, {
          cause: new Error('synthetic readback pending'),
        });
      }
      if (this.options.unknownAfterDispatch) {
        this.options.unknownAfterDispatch = false;
        throw new Error('synthetic dispatched timeout');
      }
      return { targetId, receipt };
    }
    if (typed.kind === 'invoice-print') {
      const invoice = this.requireInvoice(typed.number!);
      invoice.sent = true;
      return {
        targetId: `target-print-${this.model.nextId++}`,
        receipt: { targetId: invoice.number, sent: true },
      };
    }
    if (typed.kind === 'invoice-bookkeep') {
      const invoice = this.requireInvoice(typed.number!);
      invoice.booked = true;
      invoice.ledger = [];
      return {
        targetId: `target-bookkeep-${this.model.nextId++}`,
        receipt: { journal: invoice.ledger },
      };
    }
    if (typed.kind === 'payment-create') {
      const targetId = `target-payment-${this.model.nextId++}`;
      this.model.payments.set(paymentNumber, {
        invoiceNumber: typed.number!,
        amount: typed.amount ?? 1250,
        booked: false,
        ledger: [],
      });
      return { targetId, receipt: { targetId, booked: false } };
    }
    if (typed.kind === 'payment-bookkeep') {
      const payment = this.model.payments.get(typed.number!);
      if (!payment) throw new Error(`Unknown synthetic target payment ${typed.number}`);
      payment.booked = true;
      const invoice = this.requireInvoice(payment.invoiceNumber);
      payment.ledger = this.targetCashJournal(invoice.total, invoice.vat);
      this.model.ledger.push(...clone(payment.ledger));
      return {
        targetId: `target-payment-bookkeep-${this.model.nextId++}`,
        receipt: { journal: payment.ledger },
      };
    }
    if (typed.kind === 'credit-create') {
      // Synthetic target draft only: native Accounted credit issues immediately.
      const original = this.requireInvoice(typed.number!);
      const targetId = `target-credit-${this.model.nextId++}`;
      this.model.invoices.set(creditNumber, {
        number: creditNumber,
        total: -original.total,
        vat: -original.vat,
        sent: false,
        booked: false,
        creditOf: original.number,
        ledger: [],
      });
      return {
        targetId,
        receipt: { targetId, booked: false, creditOf: original.number },
      };
    }
    if (typed.kind === 'credit-bookkeep') {
      const credit = this.requireInvoice(typed.number!);
      credit.booked = true;
      credit.ledger = this.targetCreditJournal(credit);
      this.model.ledger.push(...clone(credit.ledger));
      return {
        targetId: `target-credit-bookkeep-${this.model.nextId++}`,
        receipt: { journal: credit.ledger },
      };
    }
    throw new Error(`Unknown synthetic target request kind: ${typed.kind}`);
  }

  async verify(record: ShadowRecord): Promise<boolean> {
    this.model.verifyCalls++;
    if (
      record.operation !== 'createInvoice' ||
      record.sourceCompany !== binding.sourceCompany ||
      record.targetCompany !== binding.targetCompany ||
      !record.targetId ||
      !this.isObject(record.targetReceipt) ||
      !this.model.invoices.has(invoiceNumber)
    ) {
      return false;
    }
    const invoice = this.model.invoices.get(invoiceNumber)!;
    const input = record.args[0];
    return (
      this.isObject(input) &&
      invoice.targetId === record.targetId &&
      record.targetReceipt.targetId === record.targetId &&
      record.targetReceipt.kind === 'invoice-create' &&
      record.targetReceipt.total === invoice.total &&
      invoice.total === targetTotalsFromInput(input).total &&
      invoice.vat === targetTotalsFromInput(input).vat &&
      invoice.number === invoiceNumber
    );
  }

  private requireInvoice(number: string): InvoiceState {
    const invoice = this.model.invoices.get(number);
    if (!invoice) throw new Error(`Unknown synthetic target invoice ${number}`);
    return invoice;
  }
  private targetCashJournal(total: number, vat: number): JournalLine[] {
    return [
      { account: '1930', debit: total },
      { account: '3001', credit: total - vat },
      { account: '2611', credit: vat },
    ];
  }
  private targetCreditJournal(invoice: InvoiceState): JournalLine[] {
    const total = Math.abs(invoice.total);
    const vat = Math.abs(invoice.vat);
    return [
      { account: '3001', debit: total - vat },
      { account: '2611', debit: vat },
      { account: '1930', credit: total },
    ];
  }
  private isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(now: () => number = Date.now) {
  const root = mkdtempSync(join(tmpdir(), 'noxctl-invoice-lifecycle-'));
  roots.push(root);
  const source = new FakeFortnoxTransport();
  const model = targetModel();
  const queue = await openShadowQueue(join(root, 'queue'), binding, now);
  const observer = createQueueObserver(queue, (operation, args) => {
    const document =
      typeof args[0] === 'string'
        ? args[0]
        : operation === 'createInvoicePayment'
          ? paymentNumber
          : invoiceNumber;
    return `synthetic-invoice:${document}:${operation}`;
  });
  const operations = createFortnoxOperations(source, observer);
  return { root, source, model, queue, operations };
}

async function drain(queue: ShadowQueue, adapter: ShadowAdapter): Promise<void> {
  while (await queue.drainOne(adapter)) {
    // Strict queue order is the behavior under test.
  }
}

function assertUniqueIds(queue: ShadowQueue): void {
  const ids = queue.status().items.map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
}

describe('synthetic invoice lifecycle shadow evaluation', () => {
  it('runs the source-first chain with independent target totals, journals, relationships, and stable IDs', async () => {
    const { source, model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model);
    expect(model.mode).toBe('local-simulation');
    const create = await operations.createInvoice(invoiceInput);
    expect(create).toMatchObject({
      DocumentNumber: invoiceNumber,
      Total: 1250,
      TotalVAT: 250,
      Sent: false,
      Booked: false,
    });
    expect(source.invoices.get(invoiceNumber)?.ledger).toEqual([]);
    await drain(queue, adapter);
    expect(model.invoices.get(invoiceNumber)).toMatchObject({
      total: 1250,
      vat: 250,
      sent: false,
      booked: false,
      ledger: [],
    });

    const printed = await operations.externalPrintInvoice(invoiceNumber);
    expect(printed).toMatchObject({ DocumentNumber: invoiceNumber, Sent: true, Booked: false });
    await drain(queue, adapter);
    expect(model.invoices.get(invoiceNumber)).toMatchObject({
      total: 1250,
      sent: true,
      booked: false,
      ledger: [],
    });

    const booked = await operations.bookkeepInvoice(invoiceNumber);
    expect(booked).toMatchObject({ DocumentNumber: invoiceNumber, Sent: true, Booked: true });
    expect(source.invoices.get(invoiceNumber)?.ledger).toEqual([]);
    await drain(queue, adapter);
    expect(model.invoices.get(invoiceNumber)?.ledger).toEqual([]);

    const payment = await operations.createInvoicePayment({
      InvoiceNumber: invoiceNumber,
      Amount: 1250,
      PaymentDate: '2026-01-01',
    });
    expect(payment).toMatchObject({ Number: paymentNumber, Amount: 1250 });
    expect(source.payments.get(paymentNumber)?.ledger).toEqual([]);
    expect(model.ledger).toEqual([]);
    await drain(queue, adapter);
    expect(model.payments.get(paymentNumber)).toMatchObject({
      amount: 1250,
      booked: false,
      ledger: [],
    });

    const paymentBooked = await operations.bookkeepInvoicePayment(paymentNumber);
    expect(paymentBooked).toMatchObject({ Number: paymentNumber });
    expect(source.payments.get(paymentNumber)?.ledger).toEqual(expectedPaymentJournal);
    await drain(queue, adapter);
    expect(model.payments.get(paymentNumber)?.ledger).toEqual(expectedPaymentJournal);
    expect(model.ledger.slice(-3)).toEqual(expectedPaymentJournal);
    expect(accountBalances(model.ledger)).toEqual({ '1930': 1250, '3001': -1000, '2611': -250 });

    const credit = await operations.creditInvoice(invoiceNumber);
    expect(credit).toMatchObject({
      DocumentNumber: creditNumber,
      Sent: false,
      Booked: false,
      Total: -1250,
    });
    await drain(queue, adapter);
    expect(model.invoices.get(creditNumber)).toMatchObject({
      total: -1250,
      sent: false,
      booked: false,
      creditOf: invoiceNumber,
      ledger: [],
    });
    expect(model.ledger).toEqual(expectedPaymentJournal);

    const creditBooked = await operations.bookkeepInvoice(creditNumber);
    expect(creditBooked).toMatchObject({ DocumentNumber: creditNumber, Sent: false, Booked: true });
    await drain(queue, adapter);
    expect(model.invoices.get(creditNumber)?.ledger).toEqual(expectedCreditJournal);
    expect(model.ledger.slice(-3)).toEqual(expectedCreditJournal);
    expect(accountBalances(model.ledger)).toEqual({ '1930': 0, '3001': 0, '2611': 0 });
    const sourceLedger = [
      ...[...source.invoices.values()].flatMap((invoice) => invoice.ledger),
      ...[...source.payments.values()].flatMap((payment) => payment.ledger),
    ];
    expect(accountBalances(sourceLedger)).toEqual({ '1930': 0, '3001': 0, '2611': 0 });
    expect(sourceLedger).toHaveLength(6);
    expect(model.ledger).toHaveLength(6);
    expect(queue.status().counts.applied).toBe(7);
    expect(queue.status().counts.blocked).toBe(0);
    assertUniqueIds(queue);

    const sourceCalls = source.calls.length;
    const targetCalls = model.applyCalls.length;
    expect(await operations.createInvoice(invoiceInput)).toMatchObject({
      DocumentNumber: invoiceNumber,
      Total: 1250,
    });
    expect(source.calls).toHaveLength(sourceCalls);
    expect(model.applyCalls).toHaveLength(targetCalls);
    await expect(
      operations.createInvoice({ ...invoiceInput, CustomerNumber: 'DIFFERENT' }),
    ).rejects.toThrow(/conflict/i);
    expect(source.calls).toHaveLength(sourceCalls);
    expect(model.applyCalls).toHaveLength(targetCalls);
    queue.close();
  });

  it('continues source work while target is offline, then catches up in strict order after queue reopen', async () => {
    let now = 1000;
    const { root, source, model, queue, operations } = await setup(() => now);
    const adapter = new SimulatedTargetInvoiceAdapter(model, { offlineBeforeDispatch: true });
    await operations.createInvoice(invoiceInput);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('synthetic-invoice:1000:createInvoice')?.state).toBe('retry_wait');
    await operations.externalPrintInvoice(invoiceNumber);
    await operations.bookkeepInvoice(invoiceNumber);
    await operations.createInvoicePayment({ InvoiceNumber: invoiceNumber, Amount: 1250 });
    expect(source.calls).toHaveLength(4);
    expect(model.applyCalls).toEqual([]);
    queue.close();
    now = 2000;
    const reopened = await openShadowQueue(join(root, 'queue'), binding, () => now);
    const catchup = new SimulatedTargetInvoiceAdapter(model);
    await drain(reopened, catchup);
    expect(reopened.status().counts.retry_wait).toBe(0);
    expect(reopened.status().counts.applied).toBe(4);
    expect(model.applyCalls).toEqual([
      'createInvoice',
      'externalPrintInvoice',
      'bookkeepInvoice',
      'createInvoicePayment',
    ]);
    expect(model.invoices.get(invoiceNumber)).toMatchObject({ sent: true, booked: true });
    expect(model.payments.get(paymentNumber)).toMatchObject({ booked: false, ledger: [] });
    reopened.close();
  });

  it('preserves a target receipt pending across queue reopen and reconciles by read only', async () => {
    const { root, model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model, { receiptPendingOnCreate: true });
    await operations.createInvoice(invoiceInput);
    expect(await queue.drainOne(adapter)).toBe(false);
    const unknown = queue.get('synthetic-invoice:1000:createInvoice');
    expect(unknown).toMatchObject({ state: 'target_unknown', targetId: 'target-invoice-1' });
    queue.close();
    const reopened = await openShadowQueue(join(root, 'queue'), binding);
    const readOnlyAdapter = new SimulatedTargetInvoiceAdapter(model);
    expect(await reopened.drainOne(readOnlyAdapter)).toBe(false);
    expect(model.applyCalls).toEqual(['createInvoice']);
    expect(
      await reopened.reconcileTarget('synthetic-invoice:1000:createInvoice', readOnlyAdapter),
    ).toBe(true);
    expect(reopened.get('synthetic-invoice:1000:createInvoice')?.state).toBe('applied');
    expect(model.applyCalls).toEqual(['createInvoice']);
    expect(model.verifyCalls).toBe(1);
    reopened.close();
  });

  it('freezes a dispatched-unknown target outcome without replaying it or its followers', async () => {
    const { model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model, { unknownAfterDispatch: true });
    await operations.createInvoice(invoiceInput);
    await operations.externalPrintInvoice(invoiceNumber);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('synthetic-invoice:1000:createInvoice')).toMatchObject({
      state: 'target_unknown',
    });
    expect(model.invoices.get(invoiceNumber)).toMatchObject({ total: 1250, sent: false });
    expect(model.applyCalls).toEqual(['createInvoice']);
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(model.applyCalls).toEqual(['createInvoice']);
    expect(queue.get('synthetic-invoice:1000:externalPrintInvoice')?.state).toBe('pending');
    queue.close();
  });

  it('blocks unsupported partial payment before target mutation or ledger change', async () => {
    const { model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model);
    await operations.createInvoice(invoiceInput);
    await drain(queue, adapter);
    const before = clone(model.ledger);
    await operations.createInvoicePayment({ InvoiceNumber: invoiceNumber, Amount: 500 });
    expect(await queue.drainOne(adapter)).toBe(false);
    const item = queue.status().items.at(-1);
    expect(item).toMatchObject({ operation: 'createInvoicePayment', state: 'blocked' });
    expect(item?.reason).toMatch(/partial/i);
    expect(model.ledger).toEqual(before);
    expect(model.payments.size).toBe(0);
    expect(model.applyCalls).toEqual(['createInvoice']);
    queue.close();
  });

  it('does not mutate the target for a source print whose Sent readback is unconfirmed', async () => {
    const { source, model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model);
    await operations.createInvoice(invoiceInput);
    await drain(queue, adapter);
    source.failPrintReadback = true;
    const print = await operations.sendInvoice(invoiceNumber, 'print');
    expect(print).toMatchObject({
      DocumentNumber: invoiceNumber,
      Note: expect.stringMatching(/could not be confirmed/),
    });
    expect(print).not.toHaveProperty('Sent', true);
    expect(queue.get('synthetic-invoice:1000:sendInvoice')?.state).toBe('pending');
    expect(await queue.drainOne(adapter)).toBe(false);
    expect(queue.get('synthetic-invoice:1000:sendInvoice')).toMatchObject({ state: 'blocked' });
    expect(queue.get('synthetic-invoice:1000:sendInvoice')?.reason).toMatch(/confirm/i);
    expect(model.applyCalls).toEqual(['createInvoice']);
    queue.close();
  });

  it('applies print representation when real print operation readback confirms Sent', async () => {
    const { model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model);
    await operations.createInvoice(invoiceInput);
    await drain(queue, adapter);
    expect(await operations.sendInvoice(invoiceNumber, 'print')).toMatchObject({ Sent: true });
    expect(await queue.drainOne(adapter)).toBe(true);
    expect(model.invoices.get(invoiceNumber)?.sent).toBe(true);
    expect(model.ledger).toEqual([]);
    queue.close();
  });

  it('requires the exact bound target identity and receipt for read-only reconciliation', async () => {
    const { model, queue, operations } = await setup();
    const adapter = new SimulatedTargetInvoiceAdapter(model, { receiptPendingOnCreate: true });
    await operations.createInvoice(invoiceInput);
    await queue.drainOne(adapter);
    const record = queue.get('synthetic-invoice:1000:createInvoice')!;
    expect(await adapter.verify({ ...record, targetId: 'different-target' })).toBe(false);
    expect(await adapter.verify({ ...record, targetCompany: 'different-company' })).toBe(false);
    expect(
      await adapter.verify({ ...record, targetReceipt: { targetId: 'different-target' } }),
    ).toBe(false);
    expect(await adapter.verify(record)).toBe(true);
    expect(model.applyCalls).toEqual(['createInvoice']);
    queue.close();
  });

  it('rejects unknown source routes, target operations, and payment identities', async () => {
    const source = new FakeFortnoxTransport();
    await expect(source.request('unknown-route')).rejects.toThrow(/unknown synthetic/i);
    const model = targetModel();
    const adapter = new SimulatedTargetInvoiceAdapter(model);
    const record = {
      id: 'unknown-operation',
      version: 1 as const,
      operation: 'unknownOperation',
      args: [],
      sourceCompany: binding.sourceCompany,
      targetCompany: binding.targetCompany,
      requestHash: 'fixture',
      state: 'pending' as const,
      createdAt: 1,
      updatedAt: 1,
    } satisfies ShadowRecord;
    expect(adapter.prepare(record)).toEqual({
      blocked: 'Unsupported synthetic target operation: unknownOperation',
    });
    expect(
      adapter.prepare({
        ...record,
        operation: 'bookkeepInvoicePayment',
        args: ['unknown-payment'],
      }),
    ).toMatchObject({
      blocked: expect.stringMatching(/unknown/i),
    });
    const production = new AccountedMasterDataAdapter(binding, async () => ({
      status: 500,
      json: {},
    }));
    for (const operation of ['createInvoice', 'createInvoicePayment', 'creditInvoice']) {
      expect(production.prepare({ ...record, operation })).toMatchObject({
        blocked: expect.any(String),
      });
    }
  });
});

describe('synthetic source print confirmation boundary', () => {
  it('uses the real operation aggregate and never synthesizes Sent true after readback failure', async () => {
    const source = new FakeFortnoxTransport();
    const operations = createInvoiceOperations(source);
    await operations.createInvoice(invoiceInput);
    source.failPrintReadback = true;
    const result = await operations.sendInvoice(invoiceNumber, 'print');
    expect(result).toMatchObject({
      DocumentNumber: invoiceNumber,
      Note: expect.stringMatching(/could not be confirmed/),
    });
    expect(result).not.toHaveProperty('Sent', true);
  });
});

describe('synthetic MCP mutation gate', () => {
  it('keeps invoice create dry-run and unconfirmed calls side-effect free', async () => {
    const { source, queue } = await setup();
    const observer = createQueueObserver(queue, (operation) => `mcp-invoice:${operation}`);
    const server = createServer({ transport: source, observer });
    const client = new Client({ name: 'synthetic-invoice-lifecycle', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const args = { ...invoiceInput };
      const dryRun = await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: { ...args, dryRun: true },
      });
      expect(dryRun.isError).not.toBe(true);
      expect(source.calls).toHaveLength(0);
      expect(queue.status().items).toHaveLength(0);

      const unconfirmed = await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: args,
      });
      expect(unconfirmed.isError).toBe(true);
      expect(source.calls).toHaveLength(0);
      expect(queue.status().items).toHaveLength(0);

      const confirmed = await client.callTool({
        name: 'fortnox_create_invoice',
        arguments: { ...args, confirm: true },
      });
      expect(confirmed.isError).not.toBe(true);
      expect(source.calls).toHaveLength(1);
      expect(queue.status().counts.pending).toBe(1);
    } finally {
      await client.close();
      await server.close();
      queue.close();
    }
  });
});
