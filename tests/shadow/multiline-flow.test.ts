import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountedInvoicePaymentAdapter } from '../../src/shadow/invoice-payment-adapter.js';
import { AccountedInvoiceDraftAdapter } from '../../src/shadow/invoice-draft-adapter.js';
import { AccountedInvoiceIssueAdapter } from '../../src/shadow/invoice-issue-adapter.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';
import type { CapturedPaymentVoucher } from '../../src/shadow/payment-source-mapping.js';
import type { ShadowRecord, ShadowPaymentAdapter } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const paymentId = '44444444-4444-4444-8444-444444444444';
const journalId = '55555555-5555-4555-8555-555555555555';
const wrongJournalId = '77777777-7777-4777-8777-777777777777';
const itemIds = ['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662'];
const journalLineIds = [
  '88888888-8888-4888-8888-888888888881',
  '88888888-8888-4888-8888-888888888882',
  '88888888-8888-4888-8888-888888888883',
  '88888888-8888-4888-8888-888888888884',
];
const createPaymentId = 'payment-create';
const bookkeepPaymentId = 'payment-bookkeep';

type SourceRow = {
  Description: string;
  DeliveredQuantity: number;
  Price: number;
  VAT: 25;
  Unit: string;
  AccountNumber: number;
};

const sourceRows: SourceRow[] = [
  {
    Description: 'Synthetic service',
    DeliveredQuantity: 1,
    Price: 100,
    VAT: 25,
    Unit: 'st',
    AccountNumber: 3001,
  },
  {
    Description: 'Synthetic consulting',
    DeliveredQuantity: 1,
    Price: 200,
    VAT: 25,
    Unit: 'tim',
    AccountNumber: 3002,
  },
];

function invoiceSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CustomerNumber: '7',
    InvoiceDate: '2026-01-01',
    DueDate: '2026-01-31',
    Currency: 'SEK',
    DocumentNumber: '10',
    AccountingMethod: 'CASH',
    InvoiceType: 'INVOICE',
    Country: 'Sverige',
    Booked: false,
    Sent: false,
    Cancelled: false,
    Credit: 'false',
    VATIncluded: false,
    CurrencyRate: 1,
    CurrencyUnit: 1,
    AdministrationFee: 0,
    AdministrationFeeVAT: 0,
    Freight: 0,
    FreightVAT: 0,
    RoundOff: 0,
    TaxReduction: 0,
    HouseWork: false,
    Net: 300,
    TotalVAT: 75,
    Total: 375,
    TotalToPay: 375,
    Balance: 375,
    InvoiceRows: sourceRows.map((row) => ({
      ...row,
      DeliveredQuantity: '1',
      PriceExcludingVAT: row.Price,
      TotalExcludingVAT: row.Price,
      Total: row.Price,
      Discount: 0,
      HouseWork: false,
      CostCenter: '',
      Project: '',
      ArticleNumber: '',
    })),
    ...overrides,
  };
}

function draftArgs() {
  return [
    {
      CustomerNumber: '7',
      InvoiceDate: '2026-01-01',
      DueDate: '2026-01-31',
      Currency: 'SEK',
      InvoiceRows: sourceRows.map((row) => ({ ...row, AccountNumber: String(row.AccountNumber) })),
    },
  ];
}

function sourcePayment(booked: boolean): Record<string, unknown> {
  return {
    Number: 17,
    InvoiceNumber: 10,
    Booked: booked,
    Amount: 375,
    AmountCurrency: 375,
    Currency: 'SEK',
    CurrencyRate: 1,
    CurrencyUnit: 1,
    InvoiceTotal: '375',
    WriteOffs: [],
    ModeOfPaymentAccount: 1930,
    PaymentDate: '2026-01-15',
    VoucherYear: 2,
    VoucherSeries: 'A',
    VoucherNumber: 7,
  };
}

function voucherCapture(): CapturedPaymentVoucher {
  const common = {
    CostCenter: '',
    Project: '',
    Quantity: 0,
    Removed: false,
    TransactionInformation: '',
  };
  return {
    sourceCompany: binding.sourceCompany,
    financialYearId: '2',
    data: {
      Year: 2,
      VoucherSeries: 'A',
      VoucherNumber: 7,
      ReferenceType: 'INVOICEPAYMENT',
      ReferenceNumber: 10,
      TransactionDate: '2026-01-15',
      CostCenter: '',
      Project: '',
      VoucherRows: [
        { ...common, Account: 1930, Credit: 0, Debit: 375, Description: 'Payment' },
        { ...common, Account: 3001, Credit: 100, Debit: 0, Description: 'Product revenue' },
        { ...common, Account: 3002, Credit: 200, Debit: 0, Description: 'Service revenue' },
        { ...common, Account: 2611, Credit: 75, Debit: 0, Description: 'VAT' },
      ],
    },
  };
}

function targetItems(driftSecond = false) {
  const first = {
    id: itemIds[0],
    sort_order: 0,
    description: 'Synthetic service',
    quantity: 1,
    unit: 'st',
    unit_price: 100,
    vat_rate: 25,
    revenue_account: '3001',
    line_total: 100,
    vat_amount: 25,
    discount_percent: 0,
    line_type: 'product',
    article_id: null,
    deduction_type: null,
    deduction_amount: 0,
    dimensions: {},
  };
  const second = {
    id: itemIds[1],
    sort_order: 1,
    description: 'Synthetic consulting',
    quantity: 1,
    unit: 'tim',
    unit_price: 200,
    vat_rate: 25,
    revenue_account: '3002',
    line_total: driftSecond ? 201 : 200,
    vat_amount: 50,
    discount_percent: 0,
    line_type: 'product',
    article_id: null,
    deduction_type: null,
    deduction_amount: 0,
    dimensions: {},
  };
  // Deliberately reversed response order; persisted sort_order retains source order.
  return [second, first];
}

function targetInvoice(
  status: 'draft' | 'sent' | 'paid',
  options: { paid?: boolean; driftSecond?: boolean; wrongPaymentJournalRow?: boolean } = {},
) {
  const paid = options.paid ?? status === 'paid';
  return {
    id: invoiceId,
    customer_id: customerId,
    invoice_date: '2026-01-01',
    due_date: '2026-01-31',
    currency: 'SEK',
    document_type: 'invoice',
    payment_link_auto: false,
    ore_rounding: false,
    status,
    invoice_number: status === 'draft' ? null : 'A-10',
    subtotal: 300,
    vat_amount: 75,
    total: 375,
    remaining_amount: paid ? 0 : 375,
    subtotal_sek: 300,
    vat_amount_sek: 75,
    total_sek: 375,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    paid_amount: paid ? 375 : 0,
    credited_invoice_id: null,
    deduction_total: 0,
    default_dimensions: {},
    customer: {
      id: customerId,
      customer_type: 'swedish_business',
      country: 'SE',
      archived_at: null,
    },
    items: targetItems(options.driftSecond),
    payments: paid
      ? [
          {
            id: paymentId,
            invoice_id: invoiceId,
            amount: 375,
            currency: 'SEK',
            payment_date: '2026-01-15',
            journal_entry_id: options.wrongPaymentJournalRow ? wrongJournalId : journalId,
            transaction_id: null,
          },
        ]
      : [],
  };
}

function journal() {
  const common = {
    currency: 'SEK',
    amount_in_currency: null,
    exchange_rate: null,
    tax_code: null,
    cost_center: null,
    project: null,
    dimensions: {},
  };
  return {
    id: journalId,
    status: 'posted',
    source_type: 'invoice_paid',
    source_id: invoiceId,
    entry_date: '2026-01-15',
    reverses_id: null,
    reversed_by_id: null,
    correction_of_id: null,
    lines: [
      {
        ...common,
        id: journalLineIds[0],
        account_number: '1930',
        debit_amount: 375,
        credit_amount: 0,
      },
      {
        ...common,
        id: journalLineIds[1],
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 100,
      },
      {
        ...common,
        id: journalLineIds[2],
        account_number: '3002',
        debit_amount: 0,
        credit_amount: 200,
      },
      {
        ...common,
        id: journalLineIds[3],
        account_number: '2611',
        debit_amount: 0,
        credit_amount: 75,
      },
    ],
  };
}

function makeTransport(
  options: {
    failPaymentReadbackOnce?: boolean;
    driftSecond?: boolean;
    wrongPaymentJournalRow?: boolean;
  } = {},
) {
  const calls: AccountedRequest[] = [];
  let sent = false;
  let committed = false;
  let failedPaymentReadback = false;
  let commitCount = 0;
  const request = async (input: AccountedRequest): Promise<{ status: number; json: unknown }> => {
    calls.push(input);
    if (input.method === 'POST' && input.path.endsWith('/invoices'))
      return { status: 201, json: { data: { id: invoiceId } } };
    if (input.method === 'POST' && input.path.endsWith('/mark-sent')) {
      sent = true;
      return {
        status: 200,
        json: {
          data: {
            id: invoiceId,
            status: 'sent',
            invoice_number: 'A-10',
            total: 375,
            journal_entry_id: null,
          },
        },
      };
    }
    if (input.method === 'POST' && input.path.endsWith('/mark-paid?dry_run=true')) {
      return {
        status: 200,
        json: {
          data: {
            dry_run: true,
            preview: {
              id: invoiceId,
              invoice_number: 'A-10',
              status: 'paid',
              currency: 'SEK',
              total: 375,
              paid_amount: 375,
              remaining_amount: 0,
              paid_at: '2026-01-15T12:00:00Z',
              journal_entry_id: null,
              accounting_method: 'cash',
              would_use_custom_lines: true,
              would_create_journal_entry: true,
            },
          },
        },
      };
    }
    if (input.method === 'POST' && input.path.endsWith('/mark-paid')) {
      committed = true;
      commitCount += 1;
      return {
        status: 200,
        json: {
          data: {
            id: invoiceId,
            status: 'paid',
            total: 375,
            paid_amount: 375,
            remaining_amount: 0,
            paid_at: '2026-01-15T12:00:00Z',
            payment_id: paymentId,
            journal_entry_id: journalId,
            warnings: [],
          },
        },
      };
    }
    if (input.method === 'GET' && input.path.endsWith(`/invoices/${invoiceId}?expand=items`)) {
      return {
        status: 200,
        json: {
          data: targetInvoice(sent ? 'sent' : 'draft', { driftSecond: options.driftSecond }),
        },
      };
    }
    if (
      input.method === 'GET' &&
      (input.path.endsWith(`/invoices/${invoiceId}?expand=items,payments`) ||
        input.path.endsWith(`/invoices/${invoiceId}?expand=payments`))
    ) {
      if (committed && options.failPaymentReadbackOnce && !failedPaymentReadback) {
        failedPaymentReadback = true;
        throw new Error('synthetic payment readback outage');
      }
      return {
        status: 200,
        json: {
          data: targetInvoice(committed ? 'paid' : sent ? 'sent' : 'draft', {
            paid: committed,
            driftSecond: options.driftSecond,
            wrongPaymentJournalRow: options.wrongPaymentJournalRow,
          }),
        },
      };
    }
    if (input.method === 'GET' && input.path.endsWith(`/journal-entries/${journalId}`))
      return { status: 200, json: { data: journal() } };
    throw new Error(`Unexpected synthetic request ${input.method} ${input.path}`);
  };
  return {
    request,
    calls,
    get commitCount() {
      return commitCount;
    },
  };
}

const normalAdapter = {
  prepare: (record: ShadowRecord) => ({ request: record.args }),
  apply: async (record: ShadowRecord) => ({
    targetId: `normal-${record.id}`,
    receipt: { ok: true },
  }),
};

async function seedCustomer(queue: Awaited<ReturnType<typeof openShadowQueue>>) {
  await queue.execute(
    { id: 'customer-create', operation: 'createCustomer', args: [] },
    async () => ({ CustomerNumber: '7' }),
  );
  await queue.drainOne({
    prepare: () => ({ request: {} }),
    apply: async () => ({ targetId: customerId, receipt: { data: { id: customerId } } }),
  });
}

async function seedDraft(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
) {
  await seedCustomer(queue);
  const source = invoiceSource();
  await queue.execute(
    { id: 'invoice-create', operation: 'createInvoice', args: draftArgs() },
    async () => source,
  );
  const draft = new AccountedInvoiceDraftAdapter(
    binding,
    (kind, id) => queue.resolveIdentity(kind, id),
    request,
  );
  return queue.drainOne(draft);
}

async function seedIssuedInvoice(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
) {
  expect(await seedDraft(queue, request)).toBe(true);
  const issueSource = {
    invoice: invoiceSource({ Sent: true }),
    confirmed: true,
    pdf: Buffer.from('%PDF-synthetic'),
  };
  await queue.execute(
    { id: 'invoice-issue', operation: 'markInvoicePrinted', args: ['10'] },
    async () => issueSource,
  );
  const issue = new AccountedInvoiceIssueAdapter(
    binding,
    (kind, id) => queue.resolveIdentity(kind, id),
    (id) => queue.get(id),
    request,
  );
  expect(await queue.drainOne(issue)).toBe(true);
}

async function seedPayment(queue: Awaited<ReturnType<typeof openShadowQueue>>) {
  await queue.execute(
    { id: createPaymentId, operation: 'createInvoicePayment', args: [{ InvoiceNumber: 10 }] },
    async () => sourcePayment(false),
  );
  await queue.execute(
    { id: bookkeepPaymentId, operation: 'bookkeepInvoicePayment', args: [17] },
    async () => sourcePayment(true),
  );
}

function paymentAdapter(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
): ShadowPaymentAdapter {
  return new AccountedInvoicePaymentAdapter(
    binding,
    () => queue.snapshot(),
    () => voucherCapture(),
    request,
  );
}

async function runToBookedPayment(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
) {
  await seedIssuedInvoice(queue, request);
  await seedPayment(queue);
  expect(
    await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, request)),
  ).toMatchObject({ state: 'deferred' });
  return queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, request));
}

describe('synthetic two-row invoice and payment flow', () => {
  it('creates, issues, pays, and reconstructs identities across queue reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'accounted-multiline-flow-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    try {
      const result = await runToBookedPayment(queue, transport.request);
      expect(result).toMatchObject({
        state: 'applied',
        intentIds: [createPaymentId, bookkeepPaymentId],
      });
      expect(transport.commitCount).toBe(1);

      const create = transport.calls.find(
        (call) => call.method === 'POST' && call.path.endsWith('/invoices'),
      );
      expect(create?.body).toMatchObject({
        items: [
          {
            description: 'Synthetic service',
            quantity: 1,
            unit: 'st',
            unit_price: 100,
            revenue_account: '3001',
          },
          {
            description: 'Synthetic consulting',
            quantity: 1,
            unit: 'tim',
            unit_price: 200,
            revenue_account: '3002',
          },
        ],
      });
      const commit = transport.calls.find(
        (call) => call.method === 'POST' && call.path.endsWith('/mark-paid'),
      );
      expect(commit?.body).toMatchObject({
        payment_date: '2026-01-15',
        lines: [
          { account_number: '1930', debit_amount: 375, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 100 },
          { account_number: '3002', debit_amount: 0, credit_amount: 200 },
          { account_number: '2611', debit_amount: 0, credit_amount: 75 },
        ],
      });
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid?dry_run=true'),
        ),
      ).toHaveLength(1);
      expect(transport.calls.some((call) => call.path.endsWith('?expand=items,payments'))).toBe(
        true,
      );
      expect(
        transport.calls.some((call) => call.path.endsWith(`/journal-entries/${journalId}`)),
      ).toBe(true);

      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(queue.resolveIdentity('invoice', '10')).toMatchObject({
        state: 'ready',
        targetId: invoiceId,
      });
      expect(queue.resolveIdentity('invoice-payment', '17')).toMatchObject({
        state: 'ready',
        targetId: paymentId,
      });
      expect(
        await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)),
      ).toMatchObject({ state: 'idle' });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles a known payment receipt after one failed payment GET using GET-only recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'accounted-multiline-readback-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ failPaymentReadbackOnce: true });
    try {
      expect((await runToBookedPayment(queue, transport.request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({
        state: 'target_unknown',
        targetId: paymentId,
      });
      queue.close();
      queue = await openShadowQueue(root, binding);
      const before = transport.calls.length;
      expect(
        await queue.reconcilePaymentGroup(
          createPaymentId,
          paymentAdapter(queue, transport.request),
        ),
      ).toBe(true);
      expect(transport.calls.slice(before).length).toBeGreaterThan(0);
      expect(transport.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
      expect(queue.resolveIdentity('invoice-payment', '17')).toMatchObject({
        state: 'ready',
        targetId: paymentId,
      });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not positively complete a draft when the second target item drifts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'accounted-multiline-item-drift-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ driftSecond: true });
    try {
      expect(await seedDraft(queue, transport.request)).toBe(false);
      expect(queue.get('invoice-create')).toMatchObject({
        state: 'target_unknown',
        targetId: invoiceId,
      });
      expect(queue.resolveIdentity('invoice', '10').state).toBe('unresolved');
      expect(transport.calls.some((call) => call.path.endsWith('/mark-sent'))).toBe(false);
      expect(transport.calls.some((call) => call.path.includes('/mark-paid'))).toBe(false);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a known payment receipt unknown when the expanded payment row names the wrong journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'accounted-multiline-journal-row-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ wrongPaymentJournalRow: true });
    try {
      expect((await runToBookedPayment(queue, transport.request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({
        state: 'target_unknown',
        targetId: paymentId,
        targetReceipt: { complete: true },
      });
      queue.close();
      queue = await openShadowQueue(root, binding);
      const before = transport.calls.length;
      expect(
        await queue.reconcilePaymentGroup(
          createPaymentId,
          paymentAdapter(queue, transport.request),
        ),
      ).toBe(false);
      expect(transport.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
      expect(queue.get(createPaymentId)).toMatchObject({
        state: 'target_unknown',
        targetId: paymentId,
      });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
