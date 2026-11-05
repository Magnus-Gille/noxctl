import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFortnoxOperations } from '../../src/operations/index.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { AccountedShadowAdapter } from '../../src/shadow/accounted-adapter.js';
import type { AccountedRequest, AccountedResponse } from '../../src/shadow/accounted-adapter.js';
import { AccountedInvoiceDraftAdapter } from '../../src/shadow/invoice-draft-adapter.js';
import { AccountedInvoiceIssueAdapter } from '../../src/shadow/invoice-issue-adapter.js';
import { AccountedInvoiceStageVerifier } from '../../src/shadow/invoice-stage-verifier.js';
import { OPERATION_CATALOGUE } from '../../src/shadow/operations.js';
import { openShadowQueue, type ShadowQueue } from '../../src/shadow/queue.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4222-8222-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';

function invoiceSource(sent = false, documentNumber = '10', unit = 'st'): Record<string, unknown> {
  return {
    CustomerNumber: '7',
    InvoiceDate: '2026-01-01',
    DueDate: '2026-01-31',
    Currency: 'SEK',
    DocumentNumber: documentNumber,
    AccountingMethod: 'CASH',
    InvoiceType: 'INVOICE',
    Country: 'Sverige',
    Booked: false,
    Sent: sent,
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
        Unit: unit,
        HouseWork: false,
        CostCenter: '',
        Project: '',
        ArticleNumber: '',
        AccountNumber: 3001,
      },
    ],
  };
}

function invoiceArgs(customerNumber = '7', unit = 'st') {
  return [
    {
      CustomerNumber: customerNumber,
      InvoiceDate: '2026-01-01',
      DueDate: '2026-01-31',
      Currency: 'SEK',
      InvoiceRows: [
        { Description: 'Synthetic service', DeliveredQuantity: 1, Price: 100, VAT: 25, Unit: unit },
      ],
    },
  ];
}

function targetInvoice(
  status: 'draft' | 'sent',
  invoiceNumber: string | null = null,
  unit: string | null = 'st',
) {
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
    invoice_number: invoiceNumber,
    subtotal: 100,
    vat_amount: 25,
    total: 125,
    remaining_amount: 125,
    subtotal_sek: 100,
    vat_amount_sek: 25,
    total_sek: 125,
    vat_treatment: 'standard',
    vat_rate: 25,
    paid_amount: 0,
    credited_invoice_id: null,
    deduction_total: 0,
    default_dimensions: {},
    customer: {
      id: customerId,
      name: 'Synthetic Customer',
      customer_type: 'swedish_business',
      country: 'SE',
      archived_at: null,
    },
    items: [
      {
        description: 'Synthetic service',
        quantity: 1,
        unit,
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
  };
}

function issueResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: invoiceId,
    status: 'sent',
    invoice_number: 'A-10',
    total: 125,
    journal_entry_id: null,
    ...overrides,
  };
}

type Runtime = { queue: ShadowQueue; root: string; request: ReturnType<typeof vi.fn> };

async function seedRuntime(
  options: { issue?: boolean; issueResponse?: Record<string, unknown>; unit?: string } = {},
): Promise<Runtime> {
  const root = mkdtempSync(join(tmpdir(), 'invoice-stage-runtime-'));
  const queue = await openShadowQueue(root, binding);
  let sent = false;
  const response = options.issueResponse ?? issueResponse();
  const unit = options.unit ?? 'st';
  const request = vi.fn(async (input: AccountedRequest): Promise<AccountedResponse> => {
    if (input.method === 'POST' && input.path.endsWith('/customers'))
      return {
        status: 201,
        json: {
          data: {
            id: customerId,
            name: 'Synthetic Customer',
            customer_type: 'swedish_business',
            country: 'SE',
            customer_number: '7',
          },
        },
      };
    if (input.method === 'POST' && input.path.endsWith('/invoices'))
      return { status: 201, json: { data: { id: invoiceId } } };
    if (input.method === 'POST' && input.path.endsWith('/mark-sent')) {
      sent = true;
      return { status: 200, json: { data: response } };
    }
    if (input.method === 'GET' && input.path.endsWith(`/customers/${customerId}`))
      return {
        status: 200,
        json: {
          data: {
            id: customerId,
            name: 'Synthetic Customer',
            customer_type: 'swedish_business',
            country: 'SE',
            customer_number: '7',
          },
        },
      };
    if (input.method === 'GET' && input.path.includes(`/invoices/${invoiceId}?expand=items`))
      return {
        status: 200,
        json: { data: targetInvoice(sent ? 'sent' : 'draft', sent ? 'A-10' : null, unit) },
      };
    throw new Error(`Unexpected synthetic target call: ${input.method} ${input.path}`);
  });
  await queue.execute(
    {
      id: 'customer-intent',
      operation: 'createCustomer',
      args: [
        { Name: 'Synthetic Customer', Type: 'COMPANY', CountryCode: 'SE', CustomerNumber: '7' },
      ],
    },
    async () => ({
      CustomerNumber: '7',
      Name: 'Synthetic Customer',
      Type: 'COMPANY',
      CountryCode: 'SE',
    }),
  );
  expect(await queue.drainOne(new AccountedShadowAdapter(binding.targetCompany, request))).toBe(
    true,
  );
  await queue.execute(
    { id: 'invoice-intent', operation: 'createInvoice', args: invoiceArgs('7', unit) },
    async () => invoiceSource(false, '10', unit),
  );
  const draft = new AccountedInvoiceDraftAdapter(
    binding,
    (kind, id) => queue.resolveIdentity(kind, id),
    request,
  );
  expect(await queue.drainOne(draft)).toBe(true);
  if (options.issue) {
    await queue.execute(
      { id: 'issue-intent', operation: 'markInvoicePrinted', args: ['10'] },
      async () => ({
        invoice: invoiceSource(true, '10', unit),
        confirmed: true,
        pdf: Buffer.from('%PDF-synthetic'),
      }),
    );
    const issue = new AccountedInvoiceIssueAdapter(
      binding,
      (kind, id) => queue.resolveIdentity(kind, id),
      (id) => queue.get(id),
      request,
    );
    await queue.drainOne(issue);
  }
  return { queue, root, request };
}

function verifier(runtime: Runtime, snapshot = () => runtime.queue.snapshot()) {
  return new AccountedInvoiceStageVerifier(binding, snapshot, runtime.request);
}

async function dispose(runtime: Runtime) {
  runtime.queue.close();
  rmSync(runtime.root, { recursive: true, force: true });
}

describe('read-only invoice stage verifier', () => {
  it('accepts real queue create then issue as sent', async () => {
    const runtime = await seedRuntime({ issue: true });
    try {
      const before = runtime.queue.snapshot();
      runtime.request.mockClear();
      await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
        state: 'verified',
        stage: 'sent',
        proof: 'issue-receipt',
        targetId: invoiceId,
        intentId: 'issue-intent',
        sequence: 3,
      });
      expect(runtime.request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
      expect(runtime.queue.snapshot()).toEqual(before);
      const returned = runtime.queue.snapshot();
      returned[0]!.record.id = 'mutated-local-copy';
      expect(runtime.queue.snapshot()).toEqual(before);
    } finally {
      await dispose(runtime);
    }
  });

  it('verifies draft and sent stages for an empty-unit row and rejects a changed target unit', async () => {
    const runtime = await seedRuntime({ issue: true, unit: '' });
    try {
      await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
        state: 'verified',
        stage: 'sent',
        proof: 'issue-receipt',
      });
      for (const unit of ['st', null]) {
        const request = vi.fn(async (): Promise<AccountedResponse> => ({
          status: 200,
          json: { data: targetInvoice('sent', 'A-10', unit) },
        }));
        const result = await new AccountedInvoiceStageVerifier(
          binding,
          () => runtime.queue.snapshot(),
          request,
        ).verify('10');
        expect(result.state).not.toBe('verified');
      }
    } finally {
      await dispose(runtime);
    }
  });

  it('uses real draft verification and rejects an unexpected sent target', async () => {
    const runtime = await seedRuntime();
    try {
      await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
        state: 'verified',
        stage: 'draft',
        proof: 'draft-receipt',
      });
      const request = vi.fn(async (): Promise<AccountedResponse> => ({
        status: 200,
        json: { data: targetInvoice('sent', 'A-10') },
      }));
      await expect(
        new AccountedInvoiceStageVerifier(binding, () => runtime.queue.snapshot(), request).verify(
          '10',
        ),
      ).resolves.toMatchObject({ state: 'mismatch' });
    } finally {
      await dispose(runtime);
    }
  });

  it('reports a target read failure as unresolved with a safe diagnostic', async () => {
    const runtime = await seedRuntime({ issue: true });
    try {
      const before = runtime.queue.snapshot();
      const request = vi.fn(async (_input: AccountedRequest): Promise<AccountedResponse> => {
        const cause = new Error('synthetic private transport detail');
        cause.name = 'SyntheticReadError';
        throw cause;
      });
      const diagnostics: Error[] = [];
      runtime.request.mockClear();
      const report = await new AccountedInvoiceStageVerifier(
        binding,
        () => runtime.queue.snapshot(),
        request,
        (error) => diagnostics.push(error),
      ).verify('10');
      expect(report).toMatchObject({
        state: 'unresolved',
        reason: expect.stringContaining('SyntheticReadError'),
      });
      expect(report.reason).not.toContain('private transport detail');
      expect(JSON.stringify(report)).not.toContain('private transport detail');
      expect(report).not.toHaveProperty('diagnostic');
      expect(diagnostics[0]?.cause).toBeInstanceOf(Error);
      expect(request.mock.calls.length).toBeGreaterThan(0);
      expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
      expect(runtime.queue.snapshot()).toEqual(before);
    } finally {
      await dispose(runtime);
    }
  });

  it('keeps pending, unknown, warning, and incomplete issues unresolved', async () => {
    const pending = await seedRuntime();
    try {
      await pending.queue.execute(
        { id: 'issue-intent', operation: 'markInvoicePrinted', args: ['10'] },
        async () => ({ invoice: invoiceSource(true), confirmed: true, pdf: Buffer.from('x') }),
      );
      await expect(verifier(pending).verify('10')).resolves.toMatchObject({ state: 'unresolved' });
    } finally {
      await dispose(pending);
    }
    const warning = await seedRuntime({
      issue: true,
      issueResponse: issueResponse({ warnings: ['synthetic'] }),
    });
    try {
      await expect(verifier(warning).verify('10')).resolves.toMatchObject({ state: 'unresolved' });
    } finally {
      await dispose(warning);
    }
  });

  it('blocks unsupported related changes and payment-ID-only ambiguity', async () => {
    for (const [operation, args] of [
      ['updateInvoice', ['10', {}]],
      ['attachInvoiceFiles', [{ documentNumber: '10', filePaths: [] }]],
      ['createInvoicePayment', [{ InvoiceNumber: '10', Amount: 125 }]],
      ['updateInvoicePayment', [{ InvoiceNumber: '10' }]],
      ['createInvoiceRequest', [{}]],
    ] as const) {
      const runtime = await seedRuntime();
      try {
        await runtime.queue.execute(
          { id: `later-${operation}`, operation, args },
          async () => ({}),
        );
        await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
          state: 'unsupported',
        });
      } finally {
        await dispose(runtime);
      }
    }
  });

  it('allows unrelated customer and other-invoice operations', async () => {
    const runtime = await seedRuntime();
    try {
      await runtime.queue.execute(
        {
          id: 'other-customer',
          operation: 'createCustomer',
          args: [{ Name: 'Other', Type: 'COMPANY', CountryCode: 'SE', CustomerNumber: '8' }],
        },
        async () => ({ CustomerNumber: '8', Name: 'Other', Type: 'COMPANY', CountryCode: 'SE' }),
      );
      await runtime.queue.execute(
        { id: 'other-invoice', operation: 'createInvoice', args: invoiceArgs('8') },
        async () => invoiceSource(false, '99'),
      );
      await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
        state: 'verified',
        stage: 'draft',
      });
    } finally {
      await dispose(runtime);
    }
  });

  it('blocks duplicate issues, wrong companies, and sequence corruption', async () => {
    const duplicate = await seedRuntime({ issue: true });
    try {
      await duplicate.queue.execute(
        { id: 'issue-two', operation: 'markInvoicePrinted', args: ['10'] },
        async () => ({ invoice: invoiceSource(true), confirmed: true, pdf: Buffer.from('x') }),
      );
      await expect(verifier(duplicate).verify('10')).resolves.toMatchObject({ state: 'conflict' });
    } finally {
      await dispose(duplicate);
    }
    const runtime = await seedRuntime();
    try {
      const snapshot = runtime.queue.snapshot();
      const wrongCompany = snapshot.map(({ sequence, record }) => ({
        sequence,
        record: {
          ...record,
          sourceCompany: record.id === 'invoice-intent' ? 'wrong' : binding.sourceCompany,
        },
      }));
      await expect(
        new AccountedInvoiceStageVerifier(binding, () => wrongCompany, runtime.request).verify(
          '10',
        ),
      ).resolves.toMatchObject({ state: 'conflict' });
      await expect(
        new AccountedInvoiceStageVerifier(
          binding,
          () => [...snapshot].reverse(),
          runtime.request,
        ).verify('10'),
      ).resolves.toMatchObject({ state: 'conflict' });
    } finally {
      await dispose(runtime);
    }
  });

  it('ignores unsupported history before the creator but rejects a matching issue before it', async () => {
    const runtime = await seedRuntime();
    try {
      const base = runtime.queue.snapshot();
      const historical = {
        ...base[0]!.record,
        id: 'historical-payment-update',
        operation: 'updateInvoicePayment',
        args: [{ InvoiceNumber: '10' }],
      };
      const beforeCreator = base.map(({ sequence, record }) => ({
        sequence: sequence + 1,
        record,
      }));
      const ignored = [{ sequence: 1, record: historical }, ...beforeCreator];
      await expect(
        new AccountedInvoiceStageVerifier(binding, () => ignored, runtime.request).verify('10'),
      ).resolves.toMatchObject({ state: 'verified', stage: 'draft' });

      const issueBefore = {
        ...historical,
        id: 'historical-print',
        operation: 'markInvoicePrinted',
        args: ['10'],
        sourceResult: { invoice: invoiceSource(true), confirmed: true, pdf: Buffer.from('x') },
      };
      const contradictory = [{ sequence: 1, record: issueBefore }, ...beforeCreator];
      await expect(
        new AccountedInvoiceStageVerifier(binding, () => contradictory, runtime.request).verify(
          '10',
        ),
      ).resolves.toMatchObject({ state: 'mismatch' });
    } finally {
      await dispose(runtime);
    }
  });

  it('reports stale when the queue changes during GET and survives close/reopen', async () => {
    const runtime = await seedRuntime();
    try {
      const first = runtime.queue.snapshot();
      let calls = 0;
      const snapshot = () => {
        calls += 1;
        return calls === 1
          ? first
          : [
              ...first,
              { sequence: first.length + 1, record: { ...first[0]!.record, id: 'concurrent' } },
            ];
      };
      await expect(verifier(runtime, snapshot).verify('10')).resolves.toMatchObject({
        state: 'stale',
      });
      const reopened = await openShadowQueue(runtime.root, binding);
      runtime.queue.close();
      await expect(
        new AccountedInvoiceStageVerifier(
          binding,
          () => reopened.snapshot(),
          runtime.request,
        ).verify('10'),
      ).resolves.toMatchObject({ state: 'verified', stage: 'draft' });
      reopened.close();
    } finally {
      rmSync(runtime.root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered issue receipt without a target GET', async () => {
    const runtime = await seedRuntime({ issue: true });
    try {
      const snapshot = runtime.queue.snapshot().map(({ sequence, record }) =>
        record.id === 'issue-intent'
          ? {
              sequence,
              record: {
                ...record,
                targetId: customerId,
                targetReceipt: {
                  ...(record.targetReceipt as Record<string, unknown>),
                  targetId: customerId,
                },
              },
            }
          : { sequence, record },
      );
      const request = vi.fn(async (): Promise<AccountedResponse> => {
        throw new Error('GET should not be called');
      });
      await expect(
        new AccountedInvoiceStageVerifier(binding, () => snapshot, request).verify('10'),
      ).resolves.toMatchObject({ state: 'mismatch' });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await dispose(runtime);
    }
  });

  it('rejects creator state, intent, hash, and receipt drift from the fixed snapshot', async () => {
    const runtime = await seedRuntime({ issue: true });
    try {
      const base = runtime.queue.snapshot();
      const variants = [
        base.map(({ sequence, record }) =>
          record.id === 'invoice-intent'
            ? { sequence, record: { ...record, state: 'pending' as const } }
            : { sequence, record },
        ),
        base.map(({ sequence, record }) =>
          record.id === 'invoice-intent'
            ? { sequence, record: { ...record, id: 'other-intent' } }
            : { sequence, record },
        ),
        base.map(({ sequence, record }) =>
          record.id === 'issue-intent'
            ? {
                sequence,
                record: {
                  ...record,
                  targetReceipt: {
                    ...(record.targetReceipt as Record<string, unknown>),
                    creatorRequestHash: 'other-hash',
                  },
                },
              }
            : { sequence, record },
        ),
        base.map(({ sequence, record }) =>
          record.id === 'invoice-intent'
            ? {
                sequence,
                record: {
                  ...record,
                  targetReceipt: {
                    ...(record.targetReceipt as Record<string, unknown>),
                    expected: {},
                  },
                },
              }
            : { sequence, record },
        ),
      ];
      for (const snapshot of variants) {
        await expect(
          new AccountedInvoiceStageVerifier(binding, () => snapshot, runtime.request).verify('10'),
        ).resolves.not.toMatchObject({ state: 'verified' });
      }
    } finally {
      await dispose(runtime);
    }
  });

  it('classifies every current invoice-family write conservatively', async () => {
    const matching = Object.entries(OPERATION_CATALOGUE).filter(
      ([operation, classification]) =>
        classification === 'write' &&
        /Invoice|Attachment|Accrual|TaxReduction/.test(operation) &&
        !/SupplierInvoice/.test(operation) &&
        operation !== 'increaseInvoiceCount',
    );
    for (const [operation] of matching) {
      const runtime = await seedRuntime();
      try {
        await runtime.queue.execute(
          { id: `catalogue-${operation}`, operation, args: [] },
          async () => ({}),
        );
        expect((await verifier(runtime).verify('10')).state, operation).not.toBe('verified');
      } finally {
        await dispose(runtime);
      }
    }
    expect(matching.length).toBeGreaterThan(20);
  });

  it.each([
    ['constructor', []],
    ['toString', []],
    ['attachInvoiceFiles', { 0: { documentNumber: '99' } }],
    ['createDocumentAttachment', { 0: '99', 1: 'F' }],
    ['createInvoicePayment', { 0: { InvoiceNumber: '99' } }],
    ...[
      'updateInvoice',
      'sendInvoice',
      'markInvoicePrinted',
      'bookkeepInvoice',
      'creditInvoice',
      'cancelInvoice',
      'externalPrintInvoice',
      'eprintInvoice',
      'getInvoiceReminderPdf',
      'createInvoiceFromContract',
      'createInvoiceFromOffer',
      'createInvoiceFromOrder',
    ].map((operation) => [operation, { 0: '99' }]),
  ])('fails closed for unsupported or malformed evidence: %s', async (operation, args) => {
    const runtime = await seedRuntime();
    try {
      await runtime.queue.execute(
        { id: 'malformed-later', operation: operation as string, args: args as unknown[] },
        async () => ({ DocumentNumber: '99' }),
      );
      runtime.request.mockClear();
      expect(await verifier(runtime).verify('10')).toMatchObject({ state: 'unsupported' });
      expect(runtime.request).not.toHaveBeenCalled();
    } finally {
      await dispose(runtime);
    }
  });

  it('uses the actual markInvoicePrinted envelope with pdf undefined', async () => {
    const calls: string[] = [];
    const transport: FortnoxTransport = {
      async request<T>(endpoint: string): Promise<T> {
        calls.push(`GET ${endpoint}`);
        if (endpoint === 'invoices/10') return { Invoice: invoiceSource(true) } as T;
        throw new Error(`Unexpected synthetic source call: ${endpoint}`);
      },
      async requestWithMetadata<T>(): Promise<T> {
        throw new Error('Unexpected metadata call');
      },
      async requestPdf(): Promise<Buffer> {
        throw new Error('Unexpected PDF read');
      },
      async requestPdfFromMutation(endpoint: string): Promise<Buffer | undefined> {
        calls.push(`PDF ${endpoint}`);
        return undefined;
      },
      async requestFile(): Promise<never> {
        throw new Error('Unexpected file call');
      },
      async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
        items: T[];
        totalResources: number;
      }> {
        throw new Error('Unexpected pagination call');
      },
    };
    const source = await createFortnoxOperations(transport).markInvoicePrinted('10');
    expect(source).toEqual({ invoice: invoiceSource(true), confirmed: true, pdf: undefined });
    expect(calls).toEqual(['PDF invoices/10/print', 'GET invoices/10']);
    const runtime = await seedRuntime();
    try {
      await runtime.queue.execute(
        { id: 'issue-intent', operation: 'markInvoicePrinted', args: ['10'] },
        async () => source,
      );
      const issue = new AccountedInvoiceIssueAdapter(
        binding,
        (kind, id) => runtime.queue.resolveIdentity(kind, id),
        (id) => runtime.queue.get(id),
        runtime.request,
      );
      expect(await runtime.queue.drainOne(issue)).toBe(true);
      await expect(verifier(runtime).verify('10')).resolves.toMatchObject({
        state: 'verified',
        stage: 'sent',
        proof: 'issue-receipt',
      });
    } finally {
      await dispose(runtime);
    }
    const unconfirmedTransport: FortnoxTransport = {
      ...transport,
      async request<T>(): Promise<T> {
        throw new Error('synthetic source readback outage');
      },
    };
    const unconfirmed =
      await createFortnoxOperations(unconfirmedTransport).markInvoicePrinted('10');
    expect(unconfirmed.confirmed).toBe(false);
    const pending = await seedRuntime();
    try {
      await pending.queue.execute(
        { id: 'issue-intent', operation: 'markInvoicePrinted', args: ['10'] },
        async () => unconfirmed,
      );
      await expect(verifier(pending).verify('10')).resolves.toMatchObject({ state: 'unresolved' });
    } finally {
      await dispose(pending);
    }
  });
});
