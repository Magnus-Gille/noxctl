import { describe, expect, it, vi } from 'vitest';
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
const lineIds = [
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
  '66666666-6666-4666-8666-666666666663',
];
const createPaymentId = 'payment-create';
const bookkeepPaymentId = 'payment-bookkeep';

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
    Net: 100,
    TotalVAT: 25,
    Total: 125,
    TotalToPay: 125,
    Balance: 125,
    InvoiceRows: [
      {
        Description: 'Synthetic service',
        DeliveredQuantity: '1',
        Price: 100,
        PriceExcludingVAT: 100,
        TotalExcludingVAT: 100,
        Total: 100,
        Discount: 0,
        VAT: 25,
        Unit: 'st',
        HouseWork: false,
        CostCenter: '',
        Project: '',
        ArticleNumber: '',
        AccountNumber: 3001,
      },
    ],
    ...overrides,
  };
}

function sourcePayment(booked: boolean): Record<string, unknown> {
  return {
    Number: 17,
    InvoiceNumber: 10,
    Booked: booked,
    Amount: 125,
    AmountCurrency: 125,
    Currency: 'SEK',
    CurrencyRate: 1,
    CurrencyUnit: 1,
    InvoiceTotal: '125',
    WriteOffs: [],
    ModeOfPaymentAccount: 1930,
    PaymentDate: '2026-01-15',
    VoucherYear: 2,
    VoucherSeries: 'A',
    VoucherNumber: 7,
  };
}

function voucherCapture(): CapturedPaymentVoucher {
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
        {
          Account: 1930,
          CostCenter: '',
          Credit: 0,
          Debit: 125,
          Description: 'Payment',
          Project: '',
          Quantity: 0,
          Removed: false,
          TransactionInformation: '',
        },
        {
          Account: 3001,
          CostCenter: '',
          Credit: 100,
          Debit: 0,
          Description: 'Revenue',
          Project: '',
          Quantity: 0,
          Removed: false,
          TransactionInformation: '',
        },
        {
          Account: 2611,
          CostCenter: '',
          Credit: 25,
          Debit: 0,
          Description: 'VAT',
          Project: '',
          Quantity: 0,
          Removed: false,
          TransactionInformation: '',
        },
      ],
    },
  };
}

function targetInvoice(status: 'draft' | 'sent' | 'paid', paid = false) {
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
    subtotal: 100,
    vat_amount: 25,
    total: 125,
    remaining_amount: paid ? 0 : 125,
    subtotal_sek: 100,
    vat_amount_sek: 25,
    total_sek: 125,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    paid_amount: paid ? 125 : 0,
    credited_invoice_id: null,
    deduction_total: 0,
    default_dimensions: {},
    customer: {
      id: customerId,
      customer_type: 'swedish_business',
      country: 'SE',
      archived_at: null,
    },
    items: [
      {
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
      },
    ],
    payments: paid
      ? [
          {
            id: paymentId,
            invoice_id: invoiceId,
            amount: 125,
            currency: 'SEK',
            payment_date: '2026-01-15',
            journal_entry_id: journalId,
            transaction_id: null,
          },
        ]
      : [],
  };
}

function journal() {
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
        id: lineIds[0],
        account_number: '1930',
        debit_amount: 125,
        credit_amount: 0,
        currency: 'SEK',
        amount_in_currency: null,
        exchange_rate: null,
        tax_code: null,
        cost_center: null,
        project: null,
        dimensions: {},
      },
      {
        id: lineIds[1],
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 100,
        currency: 'SEK',
        amount_in_currency: null,
        exchange_rate: null,
        tax_code: null,
        cost_center: null,
        project: null,
        dimensions: {},
      },
      {
        id: lineIds[2],
        account_number: '2611',
        debit_amount: 0,
        credit_amount: 25,
        currency: 'SEK',
        amount_in_currency: null,
        exchange_rate: null,
        tax_code: null,
        cost_center: null,
        project: null,
        dimensions: {},
      },
    ],
  };
}

function issueResponse() {
  return {
    id: invoiceId,
    status: 'sent',
    invoice_number: 'A-10',
    total: 125,
    journal_entry_id: null,
  };
}

function makeTransport(
  options: {
    failReadbackAfterCommit?: boolean;
    loseCommitResponse?: boolean;
    wrongCommitAmount?: boolean;
    dryRunAccountingMethod?: 'cash' | 'accrual';
  } = {},
) {
  const calls: AccountedRequest[] = [];
  let sent = false;
  let committed = false;
  let failedReadback = false;
  let commitCount = 0;
  const request = vi.fn(async (input: AccountedRequest) => {
    calls.push(input);
    if (input.method === 'POST' && input.path.endsWith('/invoices'))
      return { status: 201, json: { data: { id: invoiceId } } };
    if (input.method === 'POST' && input.path.endsWith('/mark-sent')) {
      sent = true;
      return { status: 200, json: { data: issueResponse() } };
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
              total: 125,
              paid_amount: 125,
              remaining_amount: 0,
              paid_at: '2026-01-15T12:00:00Z',
              journal_entry_id: null,
              accounting_method: options.dryRunAccountingMethod ?? 'cash',
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
      if (options.loseCommitResponse) throw new Error('synthetic lost commit response');
      return {
        status: 200,
        json: {
          data: {
            id: invoiceId,
            status: 'paid',
            total: 125,
            paid_amount: options.wrongCommitAmount ? 124 : 125,
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
      return { status: 200, json: { data: targetInvoice(sent ? 'sent' : 'draft') } };
    }
    if (
      input.method === 'GET' &&
      (input.path.endsWith(`/invoices/${invoiceId}?expand=items,payments`) ||
        input.path.endsWith(`/invoices/${invoiceId}?expand=payments`))
    ) {
      if (committed && options.failReadbackAfterCommit && !failedReadback) {
        failedReadback = true;
        throw new Error('synthetic payment row readback outage');
      }
      return {
        status: 200,
        json: { data: targetInvoice(committed ? 'paid' : sent ? 'sent' : 'draft', committed) },
      };
    }
    if (input.method === 'GET' && input.path.endsWith(`/journal-entries/${journalId}`))
      return { status: 200, json: { data: journal() } };
    throw new Error(`Unexpected synthetic request ${input.method} ${input.path}`);
  });
  return {
    request,
    calls,
    get commitCount() {
      return commitCount;
    },
  };
}

async function seedIssuedInvoice(
  queue: Awaited<ReturnType<typeof openShadowQueue>>,
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
) {
  await queue.execute(
    { id: 'customer-create', operation: 'createCustomer', args: [] },
    async () => ({ CustomerNumber: '7' }),
  );
  await queue.drainOne({
    prepare: () => ({ request: {} }),
    apply: async () => ({ targetId: customerId, receipt: { data: { id: customerId } } }),
  });
  const source = invoiceSource();
  await queue.execute(
    {
      id: 'invoice-create',
      operation: 'createInvoice',
      args: [
        {
          CustomerNumber: '7',
          InvoiceDate: '2026-01-01',
          DueDate: '2026-01-31',
          Currency: 'SEK',
          InvoiceRows: [
            {
              Description: 'Synthetic service',
              DeliveredQuantity: 1,
              Price: 100,
              VAT: 25,
              Unit: 'st',
            },
          ],
        },
      ],
    },
    async () => source,
  );
  const draft = new AccountedInvoiceDraftAdapter(
    binding,
    (kind, id) => queue.resolveIdentity(kind, id),
    request,
  );
  expect(await queue.drainOne(draft)).toBe(true);
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
  voucherLookup: () => CapturedPaymentVoucher | undefined = () => voucherCapture(),
): ShadowPaymentAdapter {
  return new AccountedInvoicePaymentAdapter(
    binding,
    () => queue.snapshot(),
    voucherLookup,
    request,
  );
}

const normalAdapter = {
  prepare: (record: ShadowRecord) => ({ request: record.args }),
  apply: async (record: ShadowRecord) => ({
    targetId: `normal-${record.id}`,
    receipt: { ok: true },
  }),
};

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

describe('synthetic-only Accounted invoice payment adapter queue integration', () => {
  it('books one full cash payment, persists the source-linked target identity, and keeps it after reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-adapter-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    try {
      const result = await runToBookedPayment(queue, transport.request);
      expect(result).toMatchObject({
        state: 'applied',
        intentIds: [createPaymentId, bookkeepPaymentId],
      });
      expect(transport.commitCount).toBe(1);
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid?dry_run=true'),
        ),
      ).toHaveLength(1);
      const commits = transport.calls.filter(
        (call) => call.method === 'POST' && call.path.endsWith('/mark-paid'),
      );
      expect(commits).toHaveLength(1);
      expect(commits[0]?.body).toMatchObject({
        payment_date: '2026-01-15',
        lines: [
          { account_number: '1930', debit_amount: 125, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 100 },
          { account_number: '2611', debit_amount: 0, credit_amount: 25 },
        ],
      });
      expect(commits[0]?.idempotencyKey).toBeTruthy();
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(queue.get(bookkeepPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(queue.resolveIdentity('invoice-payment', '17')).toMatchObject({
        state: 'ready',
        resource: 'invoice-payment',
        sourceId: '17',
        targetId: paymentId,
      });
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(queue.get(bookkeepPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(
        await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)),
      ).toMatchObject({ state: 'idle' });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles a known payment receipt after a failed GET with read-only requests after reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-readback-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ failReadbackAfterCommit: true });
    try {
      const result = await runToBookedPayment(queue, transport.request);
      expect(result.state).toBe('unknown');
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
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(queue.get(bookkeepPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(transport.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a lost commit response unknown across reopen and never replays it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-lost-response-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ loseCommitResponse: true });
    try {
      expect((await runToBookedPayment(queue, transport.request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'target_unknown' });
      expect(queue.get(createPaymentId)?.targetId).toBeUndefined();
      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(
        await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)),
      ).toMatchObject({ state: 'idle' });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a valid payment ID with an incomplete contradictory amount receipt without promoting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-incomplete-receipt-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ wrongCommitAmount: true });
    try {
      expect((await runToBookedPayment(queue, transport.request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({
        state: 'target_unknown',
        targetId: paymentId,
      });
      expect(queue.get(createPaymentId)?.targetReceipt).toMatchObject({ complete: false });
      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(
        await queue.reconcilePaymentGroup(
          createPaymentId,
          paymentAdapter(queue, transport.request),
        ),
      ).toBe(false);
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

  it('blocks a missing captured source voucher before any mark-paid request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-missing-voucher-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    try {
      await seedIssuedInvoice(queue, transport.request);
      await seedPayment(queue);
      expect(
        (await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)))
          .state,
      ).toBe('deferred');
      const missingVoucherAdapter = paymentAdapter(queue, transport.request, () => undefined);
      expect(await queue.drainPaymentAware(normalAdapter, missingVoucherAdapter)).toMatchObject({
        state: 'blocked',
      });
      expect(transport.calls.filter((call) => call.path.includes('/mark-paid'))).toHaveLength(0);
      expect(transport.commitCount).toBe(0);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an accrual dry-run preview without issuing the committing POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-accrual-preview-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport({ dryRunAccountingMethod: 'accrual' });
    try {
      await seedIssuedInvoice(queue, transport.request);
      await seedPayment(queue);
      expect(
        (await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)))
          .state,
      ).toBe('deferred');
      const result = await queue.drainPaymentAware(
        normalAdapter,
        paymentAdapter(queue, transport.request),
      );
      expect(result.state).not.toBe('applied');
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid?dry_run=true'),
        ),
      ).toHaveLength(1);
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid'),
        ),
      ).toHaveLength(0);
      expect(transport.commitCount).toBe(0);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('adversarial payment mutation receipts and recovery', () => {
  const invalidMutationResponses: Array<{
    name: string;
    status?: number;
    mutate: (data: Record<string, unknown>) => void;
  }> = [
    {
      name: 'wrong invoice',
      mutate: (data) => {
        data.id = customerId;
      },
    },
    {
      name: 'wrong status',
      mutate: (data) => {
        data.status = 'partially_paid';
      },
    },
    {
      name: 'wrong amount',
      mutate: (data) => {
        data.paid_amount = 124;
      },
    },
    {
      name: 'wrong paid date',
      mutate: (data) => {
        data.paid_at = '2026-01-14T12:00:00Z';
      },
    },
    {
      name: 'journal and payment IDs collide',
      mutate: (data) => {
        data.journal_entry_id = paymentId;
      },
    },
    { name: 'non-200 response', status: 201, mutate: () => {} },
    {
      name: 'warnings in mutation response',
      mutate: (data) => {
        data.warnings = [{ code: 'SYNTHETIC', message: 'unresolved warning' }];
      },
    },
  ];

  it.each(invalidMutationResponses)(
    '$name preserves the payment ID as incomplete and cannot reconcile it',
    async ({ status, mutate }) => {
      const root = mkdtempSync(join(tmpdir(), 'invoice-payment-invalid-receipt-'));
      const queue = await openShadowQueue(root, binding);
      const transport = makeTransport();
      const request = async (input: AccountedRequest) => {
        const response = await transport.request(input);
        if (input.method !== 'POST' || !input.path.endsWith('/mark-paid')) return response;
        const json = structuredClone(response.json) as { data: Record<string, unknown> };
        mutate(json.data);
        return { status: status ?? response.status, json };
      };
      try {
        expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
        expect(queue.get(createPaymentId)).toMatchObject({
          state: 'target_unknown',
          targetId: paymentId,
          targetReceipt: { complete: false, data: { id: paymentId } },
        });
        const before = transport.calls.length;
        expect(
          await queue.reconcilePaymentGroup(createPaymentId, paymentAdapter(queue, request)),
        ).toBe(false);
        expect(transport.calls.slice(before).some((call) => call.method === 'POST')).toBe(false);
        expect(transport.commitCount).toBe(1);
      } finally {
        queue.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps a mutation response without payment_id unknown and never replays after reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-missing-row-id-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    const request = async (input: AccountedRequest) => {
      const response = await transport.request(input);
      if (input.method !== 'POST' || !input.path.endsWith('/mark-paid')) return response;
      const json = structuredClone(response.json) as { data: Record<string, unknown> };
      delete json.data.payment_id;
      return { ...response, json };
    };
    try {
      expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'target_unknown' });
      expect(queue.get(createPaymentId)?.targetId).toBeUndefined();
      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(
        await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, request)),
      ).toMatchObject({ state: 'idle' });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('converts a transport TargetNotDispatchedError during commit into unknown and disables retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-dispatch-boundary-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    const { TargetNotDispatchedError } = await import('../../src/shadow/types.js');
    let commitAttempts = 0;
    const request = async (input: AccountedRequest) => {
      if (input.method === 'POST' && input.path.endsWith('/mark-paid')) {
        commitAttempts += 1;
        throw new TargetNotDispatchedError();
      }
      return transport.request(input);
    };
    try {
      expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'target_unknown' });
      expect(queue.get(createPaymentId)?.targetId).toBeUndefined();
      queue.close();
      queue = await openShadowQueue(root, binding);
      expect(
        await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, request)),
      ).toMatchObject({ state: 'idle' });
      expect(commitAttempts).toBe(1);
      expect(transport.commitCount).toBe(0);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not commit if the captured source voucher changes after dry-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-voucher-drift-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    let previewObserved = false;
    const request = async (input: AccountedRequest) => {
      const response = await transport.request(input);
      if (input.path.endsWith('/mark-paid?dry_run=true')) previewObserved = true;
      return response;
    };
    const changingVoucher = (): CapturedPaymentVoucher => {
      const captured = voucherCapture();
      if (previewObserved) {
        const data = captured.data as { VoucherRows: Array<{ Debit: number }> };
        data.VoucherRows[0]!.Debit = 124;
      }
      return captured;
    };
    try {
      await seedIssuedInvoice(queue, transport.request);
      await seedPayment(queue);
      expect(
        (
          await queue.drainPaymentAware(
            normalAdapter,
            paymentAdapter(queue, request, changingVoucher),
          )
        ).state,
      ).toBe('deferred');
      const result = await queue.drainPaymentAware(
        normalAdapter,
        paymentAdapter(queue, request, changingVoucher),
      );
      expect(result.state).not.toBe('applied');
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid?dry_run=true'),
        ),
      ).toHaveLength(1);
      expect(
        transport.calls.filter(
          (call) => call.method === 'POST' && call.path.endsWith('/mark-paid'),
        ),
      ).toHaveLength(0);
      expect(transport.commitCount).toBe(0);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a complete receipt unknown on journal mismatch, then reconciles with GETs only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-journal-drift-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    let mismatchOnce = true;
    const request = async (input: AccountedRequest) => {
      const response = await transport.request(input);
      if (
        input.method !== 'GET' ||
        !input.path.endsWith(`/journal-entries/${journalId}`) ||
        !mismatchOnce
      )
        return response;
      mismatchOnce = false;
      const json = structuredClone(response.json) as { data: Record<string, unknown> };
      json.data.source_id = customerId;
      return { ...response, json };
    };
    try {
      expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({
        state: 'target_unknown',
        targetId: paymentId,
        targetReceipt: { complete: true },
      });
      queue.close();
      queue = await openShadowQueue(root, binding);
      const before = transport.calls.length;
      expect(
        await queue.reconcilePaymentGroup(createPaymentId, paymentAdapter(queue, request)),
      ).toBe(true);
      expect(transport.calls.slice(before).length).toBeGreaterThan(0);
      expect(transport.calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
      expect(queue.get(createPaymentId)).toMatchObject({ state: 'applied', targetId: paymentId });
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a tampered durable receipt without issuing a target mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-payment-tampered-receipt-'));
    let queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    try {
      expect((await runToBookedPayment(queue, transport.request)).state).toBe('applied');
      queue.close();
      const { DatabaseSync } = await import('node:sqlite');
      const { decode } = await import('../../src/shadow/codec.js');
      const { canonicalEncode } = await import('../../src/shadow/queue.js');
      const db = new DatabaseSync(join(root, 'shadow.sqlite'));
      for (const id of [createPaymentId, bookkeepPaymentId]) {
        const row = db.prepare('SELECT record FROM intents WHERE id=?').get(id) as {
          record: string;
        };
        const record = decode(row.record) as ShadowRecord;
        const stored = record.targetReceipt as Record<string, unknown>;
        record.targetReceipt = { ...stored, complete: false };
        db.prepare('UPDATE intents SET record=? WHERE id=?').run(canonicalEncode(record), id);
      }
      db.close();
      queue = await openShadowQueue(root, binding);
      const before = transport.calls.length;
      expect(
        await queue.verifyPaymentGroup(createPaymentId, paymentAdapter(queue, transport.request)),
      ).toBe(false);
      expect(transport.calls.slice(before).some((call) => call.method === 'POST')).toBe(false);
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('payment adapter boundary evidence', () => {
  it('keeps a valid payment identity even when the response cannot be serialized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'payment-encoding-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    const request = async (input: AccountedRequest) => {
      const response = await transport.request(input);
      if (input.method === 'POST' && input.path.endsWith('/mark-paid'))
        return { ...response, json: { ...response.json, unsupported: () => true } };
      return response;
    };
    try {
      expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
      expect(queue.get(createPaymentId)).toMatchObject({
        targetId: paymentId,
        targetReceipt: { complete: false, data: { id: paymentId } },
      });
      expect(
        await queue.reconcilePaymentGroup(createPaymentId, paymentAdapter(queue, request)),
      ).toBe(false);
      expect(transport.commitCount).toBe(1);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['meta-warning', 'partial-expansion', 'existing-payment'])(
    'refuses %s before the payment preview',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'payment-preflight-'));
      const queue = await openShadowQueue(root, binding);
      const transport = makeTransport();
      const request = async (input: AccountedRequest) => {
        const response = await transport.request(input);
        if (!input.path.endsWith('?expand=items,payments')) return response;
        const json = structuredClone(response.json) as {
          data: Record<string, unknown>;
          meta?: unknown;
        };
        if (kind === 'existing-payment') json.data.payments = [{ id: paymentId }];
        else
          json.meta =
            kind === 'meta-warning'
              ? { warnings: [{ code: 'UNCERTAIN' }] }
              : { partial_expansions: ['payments'] };
        return { ...response, json };
      };
      try {
        expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
        expect(transport.calls.some((call) => call.path.includes('/mark-paid'))).toBe(false);
        expect(transport.commitCount).toBe(0);
      } finally {
        queue.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses a fabricated group identity before target access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'payment-group-proof-'));
    const queue = await openShadowQueue(root, binding);
    const transport = makeTransport();
    try {
      await seedIssuedInvoice(queue, transport.request);
      await seedPayment(queue);
      expect(
        (await queue.drainPaymentAware(normalAdapter, paymentAdapter(queue, transport.request)))
          .state,
      ).toBe('deferred');
      const { planPaymentQueue } = await import('../../src/shadow/payment-queue-plan.js');
      const planned = planPaymentQueue(queue.snapshot(), binding);
      if (planned.kind !== 'payment') throw new Error('Expected a real eligible group');
      const before = transport.calls.length;
      const adapter = paymentAdapter(queue, transport.request);
      expect(adapter.prepare({ ...planned.group, id: 'fabricated-group' })).toHaveProperty(
        'blocked',
      );
      expect(adapter.prepare({ ...planned.group, sourcePaymentId: '18' })).toHaveProperty(
        'blocked',
      );
      expect(transport.calls).toHaveLength(before);
    } finally {
      queue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('binds the final preflight invoice number to the persisted issue receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'payment-issued-number-'));
  const queue = await openShadowQueue(root, binding);
  const transport = makeTransport();
  const request = async (input: AccountedRequest) => {
    const response = await transport.request(input);
    if (input.path.endsWith('?expand=items,payments')) {
      const json = structuredClone(response.json) as { data: Record<string, unknown> };
      json.data.invoice_number = 'CHANGED-10';
      return { ...response, json };
    }
    if (input.path.endsWith('/mark-paid?dry_run=true')) {
      const json = structuredClone(response.json) as { data: { preview: Record<string, unknown> } };
      json.data.preview.invoice_number = 'CHANGED-10';
      return { ...response, json };
    }
    return response;
  };
  try {
    expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
    expect(transport.commitCount).toBe(0);
    expect(transport.calls.some((call) => call.path.includes('/mark-paid'))).toBe(false);
  } finally {
    queue.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not trust a preflight response object mutated by the later preview callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'payment-preflight-alias-'));
  const queue = await openShadowQueue(root, binding);
  const transport = makeTransport();
  let retained: Record<string, unknown> | undefined;
  const request = async (input: AccountedRequest) => {
    const response = await transport.request(input);
    if (input.path.endsWith('?expand=items,payments')) {
      retained = (response.json as { data: Record<string, unknown> }).data;
    }
    if (input.path.endsWith('/mark-paid?dry_run=true')) {
      if (!retained) throw new Error('Preflight was not observed');
      retained.invoice_number = 'MUTATED-10';
      const json = structuredClone(response.json) as { data: { preview: Record<string, unknown> } };
      json.data.preview.invoice_number = 'MUTATED-10';
      return { ...response, json };
    }
    return response;
  };
  try {
    expect((await runToBookedPayment(queue, request)).state).toBe('unknown');
    expect(transport.commitCount).toBe(0);
    expect(
      transport.calls.filter((call) => call.path.endsWith('/mark-paid?dry_run=true')),
    ).toHaveLength(1);
  } finally {
    queue.close();
    rmSync(root, { recursive: true, force: true });
  }
});
