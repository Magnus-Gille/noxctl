import { describe, expect, it, vi } from 'vitest';
import {
  AccountedInvoiceCreditAdapter,
  CREDIT_REFUSAL,
  matchesCreditNoteExpected,
} from '../../src/shadow/invoice-credit-adapter.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';
import type { ShadowIdentityResolution } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const issueId = 'issue-intent';
const creatorId = 'invoice-intent';

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

function creator(): ShadowRecord {
  const source = invoiceSource();
  return {
    version: 1,
    id: creatorId,
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
    ...binding,
    requestHash: 'creator-request-hash',
    state: 'applied',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: source,
    targetId: invoiceId,
    targetReceipt: {
      data: { id: invoiceId },
      expected: {
        customer_id: customerId,
        invoice_date: '2026-01-01',
        due_date: '2026-01-31',
        currency: 'SEK',
        document_type: 'invoice',
        payment_link_auto: false,
        ore_rounding: false,
        status: 'draft',
        invoice_number: null,
        subtotal: 100,
        vat_amount: 25,
        total: 125,
        remaining_amount: 125,
        mirrored_customer: {
          name: '',
          org_number: '',
          phone: '',
          address_line1: '',
          address_line2: '',
          postal_code: '',
          city: '',
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
          },
        ],
      },
      sourceInvoiceId: '10',
    },
  };
}

function issue(overrides: Record<string, unknown> = {}): ShadowRecord {
  const source = invoiceSource({ Sent: true });
  return {
    version: 1,
    id: issueId,
    operation: 'markInvoicePrinted',
    args: ['10'],
    ...binding,
    requestHash: 'issue-request-hash',
    state: 'pending',
    createdAt: 2,
    updatedAt: 2,
    sourceResult: { invoice: source, confirmed: true, pdf: Buffer.from('%PDF-synthetic') },
    ...overrides,
  };
}

function customerIdentity(): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: 'customer',
    sourceId: '7',
    targetId: customerId,
    intentId: 'customer-intent',
    requestHash: 'customer-request-hash',
    ...binding,
    sourceCustomer: {
      Name: '',
      OrganisationNumber: '',
      Phone1: '',
      Phone2: '',
      Address1: '',
      Address2: '',
      ZipCode: '',
      City: '',
    },
  };
}

function invoiceIdentity(): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: 'invoice',
    sourceId: '10',
    targetId: invoiceId,
    intentId: creatorId,
    requestHash: 'creator-request-hash',
    ...binding,
    sourceCustomer: {
      Name: '',
      OrganisationNumber: '',
      Phone1: '',
      Phone2: '',
      Address1: '',
      Address2: '',
      ZipCode: '',
      City: '',
    },
  };
}

function targetInvoice(status: 'draft' | 'sent', invoiceNumber: string | null = null) {
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
    vat_treatment: 'standard_25',
    vat_rate: 25,
    paid_amount: 0,
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
  };
}

const creditId = '44444444-4444-4444-8444-444444444444';
const creditIntentId = 'credit-intent';
const originalNumber = 'A-10';

function appliedIssue(): ShadowRecord {
  const base = issue();
  const expected = (creator().targetReceipt as { expected: unknown }).expected;
  return {
    ...base,
    state: 'applied',
    targetId: invoiceId,
    targetReceipt: {
      version: 1,
      kind: 'invoice-issue',
      complete: true,
      issueIntentId: issueId,
      issueRequestHash: 'issue-request-hash',
      creatorIntentId: creatorId,
      creatorRequestHash: 'creator-request-hash',
      sourceCompany: binding.sourceCompany,
      targetCompany: binding.targetCompany,
      sourceInvoiceId: '10',
      targetId: invoiceId,
      expected,
      mutation: {
        status: 200,
        response: {
          id: invoiceId,
          status: 'sent',
          invoice_number: originalNumber,
          total: 125,
          journal_entry_id: null,
        },
      },
    },
  };
}

type Row = Record<string, unknown>;
const originalRow = (invoiceSource().InvoiceRows as Row[])[0]!;

function creditSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...invoiceSource(),
    DocumentNumber: '11',
    Credit: true,
    CreditInvoiceReference: '10',
    Net: -100,
    TotalVAT: -25,
    Total: -125,
    TotalToPay: -125,
    Balance: -125,
    InvoiceRows: [
      { ...originalRow, DeliveredQuantity: '-1', Total: -100, TotalExcludingVAT: -100 },
    ],
    ...overrides,
  };
}

function credit(overrides: Record<string, unknown> = {}): ShadowRecord {
  return {
    version: 1,
    id: creditIntentId,
    operation: 'creditInvoice',
    args: ['10'],
    ...binding,
    requestHash: 'credit-request-hash',
    state: 'pending',
    createdAt: 3,
    updatedAt: 3,
    sourceResult: creditSource(),
    ...overrides,
  };
}

function targetCredit(overrides: Record<string, unknown> = {}) {
  const base = targetInvoice('sent', `KR-${originalNumber}`);
  return {
    ...base,
    id: creditId,
    credited_invoice_id: invoiceId,
    invoice_date: '2026-02-01',
    due_date: '2026-02-01',
    notes: `Krediterar faktura ${originalNumber}`,
    subtotal: -100,
    vat_amount: -25,
    total: -125,
    subtotal_sek: -100,
    vat_amount_sek: -25,
    total_sek: -125,
    remaining_amount: -125,
    items: base.items.map((item) => ({
      ...item,
      quantity: -1,
      line_total: -100,
      vat_amount: -25,
      revenue_account: null,
    })),
    ...overrides,
  };
}

function creditResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: creditId,
    invoice_number: `KR-${originalNumber}`,
    credited_invoice_id: invoiceId,
    status: 'sent',
    total: -125,
    journal_entry_id: null,
    ...overrides,
  };
}

interface Options {
  response?: unknown;
  status?: number;
  originalStatus?: string;
  neverFlip?: boolean;
  credited?: Record<string, unknown>;
  /** Start in the state after a successful credit POST (the original reads as credited). */
  alreadyPosted?: boolean;
  postThrows?: boolean;
  snapshot?: ShadowRecord[];
  identityOverride?: ShadowIdentityResolution;
}

function setup(options: Options = {}) {
  let posted = options.alreadyPosted ?? false;
  const request = vi.fn(async (input: AccountedRequest) => {
    if (input.method === 'POST') {
      if (options.postThrows) throw new Error('synthetic transport failure');
      posted = true;
      return {
        status: options.status ?? 201,
        json: { data: options.response ?? creditResponse() },
      };
    }
    if (input.path.includes(creditId)) {
      return { status: 200, json: { data: targetCredit(options.credited) } };
    }
    const flipped = posted && !options.neverFlip;
    return {
      status: 200,
      json: {
        data: {
          ...targetInvoice('sent', originalNumber),
          status: flipped ? 'credited' : (options.originalStatus ?? 'sent'),
        },
      },
    };
  });
  const snapshot = options.snapshot ?? [appliedIssue()];
  const adapter = new AccountedInvoiceCreditAdapter(
    binding,
    (kind, id) => {
      if (kind !== 'invoice') return customerIdentity();
      if (options.identityOverride) return options.identityOverride;
      return id === '10'
        ? invoiceIdentity()
        : ({ state: 'unresolved', intentIds: [], reason: 'none' } as ShadowIdentityResolution);
    },
    (id) => (id === creatorId ? creator() : undefined),
    () => snapshot.map((record, index) => ({ sequence: index + 1, record })),
    request,
  );
  return { adapter, request };
}

function prepared(adapter: AccountedInvoiceCreditAdapter, record = credit()) {
  const result = adapter.prepare(record);
  if (!('request' in result)) throw new Error(result.blocked);
  return result.request;
}

const posts = (request: ReturnType<typeof setup>['request']) =>
  request.mock.calls.filter(([input]) => input.method === 'POST').map(([input]) => input);

describe('credit adapter prepare (pure, fail closed)', () => {
  it('prepares a full credit of a mirrored and issued original without any request', () => {
    const { adapter, request } = setup();
    expect(prepared(adapter)).toMatchObject({
      originalTargetId: invoiceId,
      originalSourceInvoiceId: '10',
      originalInvoiceNumber: originalNumber,
      creditSourceInvoiceId: '11',
      issueIntentId: issueId,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts Credit as the string "true"', () => {
    const { adapter } = setup();
    expect(
      adapter.prepare(credit({ sourceResult: creditSource({ Credit: 'true' }) })),
    ).toHaveProperty('request');
  });

  const partialRow = (quantity: string) => [
    { ...originalRow, DeliveredQuantity: quantity, Total: -100, TotalExcludingVAT: -100 },
  ];

  it.each([
    ['not a credit', credit({ sourceResult: creditSource({ Credit: false }) }), 'notCredit'],
    [
      'no reference',
      credit({ sourceResult: creditSource({ CreditInvoiceReference: '' }) }),
      'referenceMismatch',
    ],
    [
      'reference to another invoice',
      credit({ sourceResult: creditSource({ CreditInvoiceReference: '99' }) }),
      'referenceMismatch',
    ],
    ['argument differs from reference', credit({ args: ['99'] }), 'referenceMismatch'],
    ['extra arguments', credit({ args: ['10', 'x'] }), 'arguments'],
    [
      'credit number equals original',
      credit({ sourceResult: creditSource({ DocumentNumber: '10' }) }),
      'numbers',
    ],
    ['other operation', credit({ operation: 'cancelInvoice' }), 'operation'],
    [
      'partial amounts',
      credit({ sourceResult: creditSource({ Net: -50, TotalVAT: -12.5, Total: -62.5 }) }),
      'partial',
    ],
    ['positive total', credit({ sourceResult: creditSource({ Total: 125 }) }), 'partial'],
    [
      'partial quantity',
      credit({ sourceResult: creditSource({ InvoiceRows: partialRow('-0.5') }) }),
      'partial',
    ],
    [
      'positive row quantity',
      credit({ sourceResult: creditSource({ InvoiceRows: partialRow('1') }) }),
      'partial',
    ],
    ['no rows', credit({ sourceResult: creditSource({ InvoiceRows: [] }) }), 'partial'],
    ['header drift', credit({ sourceResult: creditSource({ Country: 'Norge' }) }), 'sourceDrift'],
    [
      'foreign currency',
      credit({ sourceResult: creditSource({ Currency: 'EUR' }) }),
      'sourceDrift',
    ],
    ['malformed source', credit({ sourceResult: 'x' }), 'sourceDrift'],
  ] as const)('blocks %s', (_name, record, code) => {
    const { adapter, request } = setup();
    expect(adapter.prepare(record)).toEqual({
      blocked: expect.stringContaining(CREDIT_REFUSAL[code]),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks when the original is not mirrored (identity unresolved)', () => {
    const { adapter } = setup({
      identityOverride: { state: 'unresolved', intentIds: [], reason: 'none' },
    });
    expect(adapter.prepare(credit())).toEqual({
      blocked: expect.stringContaining(CREDIT_REFUSAL.originalNotMirrored),
    });
  });

  it.each([
    ['no issue receipt', []],
    ['unapplied issue', [{ ...appliedIssue(), state: 'target_unknown' as const }]],
    ['issue receipt for another UUID', [{ ...appliedIssue(), targetId: customerId }]],
    [
      'incomplete issue receipt',
      [
        {
          ...appliedIssue(),
          targetReceipt: { ...(appliedIssue().targetReceipt as object), complete: false },
        },
      ],
    ],
    ['ambiguous duplicate issue receipts', [appliedIssue(), { ...appliedIssue(), id: 'issue-2' }]],
  ])('blocks without a usable issue receipt: %s', (_name, snapshot) => {
    const { adapter } = setup({ snapshot });
    expect(adapter.prepare(credit())).toEqual({
      blocked: expect.stringContaining(CREDIT_REFUSAL.originalNotIssued),
    });
  });

  it('blocks a second applied credit of the same original', () => {
    const { adapter } = setup({
      snapshot: [appliedIssue(), credit({ id: 'credit-other', state: 'applied' })],
    });
    expect(adapter.prepare(credit())).toEqual({
      blocked: expect.stringContaining(CREDIT_REFUSAL.duplicate),
    });
  });

  it('ignores its own record in the snapshot', () => {
    const { adapter } = setup({ snapshot: [appliedIssue(), credit()] });
    expect(adapter.prepare(credit())).toHaveProperty('request');
  });
});

describe('credit adapter apply', () => {
  it('verifies the sent original, POSTs credit once with an idempotency key and no body, reads back', async () => {
    const { adapter, request } = setup();
    const result = await adapter.apply(credit(), prepared(adapter));
    expect(result.targetId).toBe(creditId);
    const sent = posts(request);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe(
      `/api/v1/companies/${binding.targetCompany}/invoices/${invoiceId}/credit`,
    );
    expect(sent[0]!.body).toBeUndefined();
    expect(sent[0]!.idempotencyKey).toMatch(/^shadow_credit_[0-9a-f]{64}$/);
    expect(result.receipt).toMatchObject({
      version: 1,
      kind: 'invoice-credit',
      complete: true,
      data: { id: creditId },
      creditIntentId,
      originalTargetId: invoiceId,
      mutation: { status: 201 },
    });
    const firstPost = request.mock.calls.findIndex(([input]) => input.method === 'POST');
    expect(firstPost).toBeGreaterThan(0);
  });

  it('refuses before POST when the original is not exactly in the issued state', async () => {
    for (const originalStatus of ['paid', 'overdue', 'credited', 'draft']) {
      const { adapter, request } = setup({ originalStatus });
      await expect(adapter.apply(credit(), prepared(adapter))).rejects.toThrow();
      expect(posts(request)).toHaveLength(0);
    }
  });

  it('refuses a tampered plan without any request', async () => {
    const { adapter, request } = setup();
    const plan = { ...prepared(adapter), originalTargetId: creditId };
    await expect(adapter.apply(credit(), plan)).rejects.toThrow(/prepared mapping/);
    expect(request).not.toHaveBeenCalled();
  });

  it('derives a stable key bound to the intent', async () => {
    const keys: Array<string | undefined> = [];
    for (const id of ['credit-intent', 'credit-intent', 'credit-other-intent']) {
      const { adapter, request } = setup();
      const record = credit({ id });
      await adapter.apply(record, prepared(adapter, record));
      keys.push(posts(request)[0]!.idempotencyKey);
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    ['status 200 instead of 201', creditResponse(), 200],
    [
      'warnings present',
      creditResponse({ warnings: [{ code: 'JOURNAL_ENTRY_NOT_POSTED', message: 'x' }] }),
      201,
    ],
    ['malformed warnings', creditResponse({ warnings: 'x' }), 201],
    [
      'journal entry posted',
      creditResponse({ journal_entry_id: '55555555-5555-4555-8555-555555555555' }),
      201,
    ],
    [
      'journal entry key missing',
      (() => {
        const { journal_entry_id: _drop, ...rest } = creditResponse();
        return rest;
      })(),
      201,
    ],
    ['credited_invoice_id missing', creditResponse({ credited_invoice_id: undefined }), 201],
    ['credited_invoice_id null', creditResponse({ credited_invoice_id: null }), 201],
    ['credited_invoice_id other', creditResponse({ credited_invoice_id: creditId }), 201],
    ['wrong status', creditResponse({ status: 'draft' }), 201],
    ['wrong total', creditResponse({ total: 125 }), 201],
    ['wrong number', creditResponse({ invoice_number: 'KR-other' }), 201],
  ])('keeps an unresolved incomplete receipt for %s', async (_name, response, status) => {
    const { adapter } = setup({ response, status });
    const error = (await adapter.apply(credit(), prepared(adapter)).catch((e: unknown) => e)) as {
      name: string;
      receipt: Record<string, unknown>;
    };
    expect(error.name).toBe('TargetReceiptPendingError');
    expect(error.receipt.complete).toBe(false);
    expect(error.receipt).not.toHaveProperty('data');
  });

  it('treats a response without a usable credit note id as an unknown outcome', async () => {
    for (const id of ['nope', undefined, invoiceId]) {
      const { adapter } = setup({ response: creditResponse({ id }) });
      const error = (await adapter
        .apply(credit(), prepared(adapter))
        .catch((e: unknown) => e)) as Error;
      expect(error.name).not.toBe('TargetReceiptPendingError');
      expect(error.message).toMatch(/unknown/i);
    }
  });

  it('treats a transport failure as an unknown outcome without inventing a target id', async () => {
    const { adapter } = setup({ postThrows: true });
    const error = (await adapter
      .apply(credit(), prepared(adapter))
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).not.toBe('TargetReceiptPendingError');
    expect(error.message).toMatch(/unknown/i);
  });

  it.each([
    ['a non-credit draft', { credited_invoice_id: null, status: 'draft', invoice_number: null }],
    ['credited_invoice_id null on a sent invoice', { credited_invoice_id: null }],
    ['credited_invoice_id undefined', { credited_invoice_id: undefined }],
    ['credited_invoice_id of another invoice', { credited_invoice_id: customerId }],
    ['positive total', { total: 125, total_sek: 125 }],
    ['positive quantity row', { items: targetCredit().items.map((i) => ({ ...i, quantity: 1 })) }],
    [
      'partial row amounts',
      { items: targetCredit().items.map((i) => ({ ...i, line_total: -50 })) },
    ],
    ['an extra row', { items: [...targetCredit().items, ...targetCredit().items] }],
    ['wrong notes', { notes: 'other' }],
    ['wrong invoice number', { invoice_number: 'KR-zzz' }],
  ])('keeps a complete receipt pending when readback shows %s', async (_name, credited) => {
    const { adapter } = setup({ credited });
    const error = (await adapter.apply(credit(), prepared(adapter)).catch((e: unknown) => e)) as {
      name: string;
      receipt: Record<string, unknown>;
      targetId: string;
    };
    expect(error.name).toBe('TargetReceiptPendingError');
    expect(error.targetId).toBe(creditId);
    expect(error.receipt.complete).toBe(true);
  });

  it('keeps the receipt pending when the original is not flipped to credited', async () => {
    const { adapter } = setup({ neverFlip: true });
    const error = (await adapter.apply(credit(), prepared(adapter)).catch((e: unknown) => e)) as {
      name: string;
    };
    expect(error.name).toBe('TargetReceiptPendingError');
  });
});

describe('credit adapter verify', () => {
  async function applied() {
    const { adapter, request } = setup();
    const result = await adapter.apply(credit(), prepared(adapter));
    const record = credit({
      state: 'applied',
      targetId: result.targetId,
      targetReceipt: result.receipt,
    });
    return { adapter, request, record };
  }

  it('verifies a complete receipt with GET only', async () => {
    const { adapter, request, record } = await applied();
    request.mockClear();
    expect(await adapter.verify(record)).toBe(true);
    expect(posts(request)).toHaveLength(0);
  });

  it('rejects incomplete, tampered and mismatched receipts', async () => {
    const { adapter, record } = await applied();
    const receipt = record.targetReceipt as Record<string, unknown>;
    for (const bad of [
      { ...receipt, complete: false },
      { ...receipt, kind: 'invoice-issue' },
      { ...receipt, creditIntentId: 'other' },
      { ...receipt, originalTargetId: creditId },
      { ...receipt, data: { id: invoiceId } },
      { ...receipt, mutation: { status: 200, response: creditResponse() } },
      {
        ...receipt,
        mutation: { status: 201, response: creditResponse({ journal_entry_id: 'x' }) },
      },
    ]) {
      expect(await adapter.verify({ ...record, targetReceipt: bad })).toBe(false);
    }
    expect(await adapter.verify({ ...record, targetId: invoiceId })).toBe(false);
  });

  it('is false when the credit note readback is not a credit', async () => {
    const { record } = await applied();
    // Passing control: the same fixture verifies before it is mutated.
    const { adapter: control } = setup({ alreadyPosted: true });
    expect(await control.verify(record)).toBe(true);
    const { adapter: drifted } = setup({
      alreadyPosted: true,
      credited: { credited_invoice_id: null },
    });
    expect(await drifted.verify(record)).toBe(false);
  });

  it('is false when the readback reports a journal entry or drifted header fields', async () => {
    const { record } = await applied();
    for (const credited of [
      { journal_entry_id: 'b6e1b3f0-0000-4000-8000-000000000000' },
      { due_date: '2026-03-01' },
      { due_date: undefined },
      { our_reference: 'changed' },
      { your_reference: 'changed' },
      { invoice_marking: 'changed' },
      { delivery_date: '2026-01-01' },
    ]) {
      const { adapter } = setup({ alreadyPosted: true, credited });
      expect(await adapter.verify(record)).toBe(false);
    }
  });
});

describe('matchesCreditNoteExpected', () => {
  const expected = (creator().targetReceipt as { expected: never }).expected;
  const check = (value: unknown) =>
    matchesCreditNoteExpected(value, creditId, invoiceId, expected, originalNumber);

  it('accepts only the exact negated credit note', () => {
    expect(check({ data: targetCredit() })).toBe(true);
    expect(check({ data: targetCredit({ credited_invoice_id: null }) })).toBe(false);
    expect(check({ data: targetCredit({ id: invoiceId }) })).toBe(false);
    expect(check({ data: targetCredit({ status: 'draft' }) })).toBe(false);
    expect(check({ data: targetCredit({ paid_amount: 5 }) })).toBe(false);
    expect(check({ data: targetCredit({ invoice_date: 'today' }) })).toBe(false);
    expect(check(undefined)).toBe(false);
  });
});
