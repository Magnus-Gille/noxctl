import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountedInvoiceIssueAdapter } from '../../src/shadow/invoice-issue-adapter.js';
import {
  AccountedInvoiceDraftAdapter,
  matchesInvoiceExpected,
} from '../../src/shadow/invoice-draft-adapter.js';
import { INVOICE_REFUSAL } from '../../src/shadow/invoice-draft-mapping.js';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import { createFortnoxOperations } from '../../src/operations/index.js';
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

describe('customer evidence is mandatory for issue verification', () => {
  it('blocks prepare when the ready customer identity lacks mirrored customer evidence', () => {
    for (const evidence of [undefined, {}, { Name: 'only name' }]) {
      const adapter = new AccountedInvoiceIssueAdapter(
        binding,
        (kind) =>
          kind === 'invoice'
            ? invoiceIdentity()
            : ({ ...customerIdentity(), sourceCustomer: evidence } as ShadowIdentityResolution),
        (id) => (id === creatorId ? creator() : undefined),
        vi.fn(async () => ({ status: 200, json: {} })),
      );
      const prepared = adapter.prepare(issue());
      expect(prepared).toEqual({
        blocked: expect.stringContaining(INVOICE_REFUSAL.customerEvidenceMissing),
      });
    }
  });

  it('fails the sent-state readback check when the expectation has no mirrored customer', () => {
    const { mirrored_customer: _omitted, ...rest } = (
      creator().targetReceipt as {
        expected: Record<string, unknown>;
      }
    ).expected;
    expect(
      matchesInvoiceExpected({ data: targetInvoice('sent', 'A-10') }, invoiceId, rest as never, {
        status: 'sent',
        invoiceNumber: 'A-10',
      }),
    ).toBe(false);
  });
});

function issueResponse(invoiceNumber = 'A-10', overrides: Record<string, unknown> = {}) {
  return {
    id: invoiceId,
    status: 'sent',
    invoice_number: invoiceNumber,
    total: 125,
    journal_entry_id: null,
    ...overrides,
  };
}

function setup(response = issueResponse(), mutationStatus = 200) {
  let issued = false;
  const request = vi.fn(async (input: AccountedRequest) => {
    if (input.method === 'POST') {
      issued = true;
      return { status: mutationStatus, json: { data: response } };
    }
    return {
      status: 200,
      json: { data: issued ? targetInvoice('sent', 'A-10') : targetInvoice('draft') },
    };
  });
  const adapter = new AccountedInvoiceIssueAdapter(
    binding,
    (kind) => (kind === 'invoice' ? invoiceIdentity() : customerIdentity()),
    (id) => (id === creatorId ? creator() : undefined),
    request,
  );
  return { adapter, request };
}

function makeAdapter(
  request: (input: AccountedRequest) => Promise<{ status: number; json: unknown }>,
  identity: ShadowIdentityResolution = invoiceIdentity(),
  intent: ShadowRecord | undefined = creator(),
) {
  return new AccountedInvoiceIssueAdapter(
    binding,
    (kind) => (kind === 'invoice' ? identity : customerIdentity()),
    () => intent,
    request,
  );
}

describe('synthetic-only native invoice issue adapter', () => {
  it('prepares only a confirmed markInvoicePrinted receipt tied to the applied creator', () => {
    const { adapter } = setup();
    const result = adapter.prepare(issue());
    expect(result).toMatchObject({ request: { targetId: invoiceId, sourceInvoiceId: '10' } });
  });

  it('GETs the exact draft, POSTs mark-sent once, then verifies the issued invoice', async () => {
    const { adapter, request } = setup();
    const source = issue();
    const prepared = adapter.prepare(source);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    const result = await adapter.apply(source, prepared.request);
    expect(result.targetId).toBe(invoiceId);
    expect(request.mock.calls.map(([call]) => [call.method, call.path])).toEqual([
      ['GET', `/api/v1/companies/${binding.targetCompany}/invoices/${invoiceId}?expand=items`],
      ['POST', `/api/v1/companies/${binding.targetCompany}/invoices/${invoiceId}/mark-sent`],
      ['GET', `/api/v1/companies/${binding.targetCompany}/invoices/${invoiceId}?expand=items`],
    ]);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(
      await adapter.verify({ ...source, targetId: result.targetId, targetReceipt: result.receipt }),
    ).toBe(true);
  });

  it('recovers a complete issue receipt after queue reopen without a second POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoice-issue-adapter-'));
    const queue = await openShadowQueue(root, binding);
    let sent = false;
    let failReadback = true;
    let issuePosts = 0;
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'POST' && input.path.endsWith('/invoices')) {
        return { status: 201, json: { data: { id: invoiceId } } };
      }
      if (input.method === 'POST' && input.path.endsWith('/mark-sent')) {
        sent = true;
        issuePosts += 1;
        return { status: 200, json: { data: issueResponse() } };
      }
      if (failReadback && sent) {
        failReadback = false;
        throw new Error('synthetic expanded readback outage');
      }
      return {
        status: 200,
        json: { data: targetInvoice(sent ? 'sent' : 'draft', sent ? 'A-10' : null) },
      };
    });
    try {
      const source = invoiceSource();
      await queue.execute(
        { id: creatorId, operation: 'createInvoice', args: creator().args },
        async () => source,
      );
      const draft = new AccountedInvoiceDraftAdapter(
        binding,
        (kind) => (kind === 'customer' ? customerIdentity() : queue.resolveIdentity(kind, '10')),
        request,
      );
      expect(await queue.drainOne(draft)).toBe(true);
      const sourceIssue = issue();
      await queue.execute(
        { id: issueId, operation: 'markInvoicePrinted', args: sourceIssue.args },
        async () => sourceIssue.sourceResult,
      );
      const issueAdapter = new AccountedInvoiceIssueAdapter(
        binding,
        (kind, id) => (kind === 'customer' ? customerIdentity() : queue.resolveIdentity(kind, id)),
        (id) => queue.get(id),
        request,
      );
      expect(await queue.drainOne(issueAdapter)).toBe(false);
      expect(queue.get(issueId)).toMatchObject({ state: 'target_unknown', targetId: invoiceId });
      queue.close();
      const reopened = await openShadowQueue(root, binding);
      const resumed = new AccountedInvoiceIssueAdapter(
        binding,
        (kind, id) =>
          kind === 'customer' ? customerIdentity() : reopened.resolveIdentity(kind, id),
        (id) => reopened.get(id),
        request,
      );
      expect(await reopened.reconcileTarget(issueId, resumed)).toBe(true);
      expect(reopened.get(issueId)?.state).toBe('applied');
      expect(issuePosts).toBe(1);
      reopened.close();
    } finally {
      try {
        queue.close();
      } catch {
        // Queue was deliberately closed before reopen in the successful path.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'unconfirmed source',
      {
        sourceResult: {
          invoice: invoiceSource({ Sent: true }),
          confirmed: false,
          pdf: Buffer.from('x'),
        },
      },
    ],
    ['wrong UUID', { targetId: customerId }],
    [
      'source drift',
      {
        sourceResult: {
          invoice: invoiceSource({ Sent: true, Total: 124 }),
          confirmed: true,
          pdf: Buffer.from('x'),
        },
      },
    ],
    ['warning response', undefined],
  ])('blocks %s before an unsafe issue', async (_name, overrides) => {
    const { adapter, request } = setup(
      overrides === undefined
        ? issueResponse('A-10', { warnings: ['synthetic'] })
        : issueResponse(),
    );
    const prepared = adapter.prepare(issue(overrides ?? {}));
    if (overrides === undefined) {
      const valid = adapter.prepare(issue());
      if (!('request' in valid)) throw new Error(valid.blocked);
      await expect(adapter.apply(issue(), valid.request)).rejects.toThrow();
    } else {
      expect(prepared).toHaveProperty('blocked');
    }
    if (overrides !== undefined) expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['missing response identity', { ...issueResponse(), id: undefined }, 200],
    ['journal response', { ...issueResponse(), journal_entry_id: 'journal-1' }, 200],
    ['warning response', { ...issueResponse(), warnings: ['synthetic'] }, 200],
    ['non-200 response', issueResponse(), 503],
  ])(
    'retains an incomplete receipt for %s and never promotes it with GET',
    async (_name, response, status) => {
      const { adapter, request } = setup(response, status);
      const source = issue();
      const prepared = adapter.prepare(source);
      if (!('request' in prepared)) throw new Error(prepared.blocked);
      let error: unknown;
      try {
        await adapter.apply(source, prepared.request);
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ name: 'TargetReceiptPendingError', targetId: invoiceId });
      const pending = error as { receipt: Record<string, unknown> };
      expect(pending.receipt.complete).toBe(false);
      const callsBeforeVerify = request.mock.calls.length;
      expect(
        await adapter.verify({ ...source, targetId: invoiceId, targetReceipt: pending.receipt }),
      ).toBe(false);
      expect(request.mock.calls.length).toBe(callsBeforeVerify);
    },
  );

  it('retains a known UUID when the mark-sent response is missing', async () => {
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'POST') throw new Error('synthetic missing response');
      return { status: 200, json: { data: targetInvoice('draft') } };
    });
    const adapter = new AccountedInvoiceIssueAdapter(
      binding,
      (kind) => (kind === 'invoice' ? invoiceIdentity() : customerIdentity()),
      (id) => (id === creatorId ? creator() : undefined),
      request,
    );
    const source = issue();
    const prepared = adapter.prepare(source);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await expect(adapter.apply(source, prepared.request)).rejects.toMatchObject({
      name: 'TargetReceiptPendingError',
      targetId: invoiceId,
    });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['source company', { sourceCompany: 'other-source' }],
    ['target company', { targetCompany: '44444444-4444-4444-8444-444444444444' }],
  ])('refuses a %s binding mismatch before target dispatch', (_name, overrides) => {
    const { adapter, request } = setup();
    expect(adapter.prepare(issue(overrides))).toHaveProperty('blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['creator intent', { identity: { ...invoiceIdentity(), intentId: 'missing-intent' } }],
    ['creator hash', { identity: { ...invoiceIdentity(), requestHash: 'other-hash' } }],
    ['creator state', { intent: { ...creator(), state: 'pending' } }],
    [
      'creator receipt identity',
      {
        intent: {
          ...creator(),
          targetReceipt: { ...creator().targetReceipt, data: { id: customerId } },
        },
      },
    ],
  ])('refuses a %s mismatch before target dispatch', (_name, options) => {
    const request = vi.fn(async () => ({ status: 200, json: { data: targetInvoice('draft') } }));
    const adapter = makeAdapter(
      request,
      options.identity ?? invoiceIdentity(),
      options.intent ?? creator(),
    );
    expect(adapter.prepare(issue())).toHaveProperty('blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses target draft field drift before mark-sent POST', async () => {
    const request = vi.fn(async (input: AccountedRequest) =>
      input.method === 'POST'
        ? { status: 200, json: { data: issueResponse() } }
        : { status: 200, json: { data: { ...targetInvoice('draft'), total: 124 } } },
    );
    const adapter = makeAdapter(request);
    const prepared = adapter.prepare(issue());
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await expect(adapter.apply(issue(), prepared.request)).rejects.toThrow(/exact confirmed draft/);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(0);
  });

  it('refuses a tampered prepared plan without making any request', async () => {
    const request = vi.fn(async () => ({ status: 200, json: { data: targetInvoice('draft') } }));
    const adapter = makeAdapter(request);
    const prepared = adapter.prepare(issue());
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await expect(
      adapter.apply(issue(), { ...prepared.request, targetId: customerId }),
    ).rejects.toThrow(/prepared mapping/);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['creator changes', { identity: undefined, intent: 'changed' }],
    ['identity mapping changes', { identity: 'changed', intent: undefined }],
  ])('refuses a %s during the pre-GET recheck without POST', async (_name, mode) => {
    let prepareCalls = 0;
    const request = vi.fn(async () => ({ status: 200, json: { data: targetInvoice('draft') } }));
    const identity = () => {
      prepareCalls += 1;
      return mode.identity === 'changed' && prepareCalls >= 3
        ? { ...invoiceIdentity(), targetId: customerId }
        : invoiceIdentity();
    };
    const intent = () =>
      mode.intent === 'changed' && prepareCalls >= 3
        ? { ...creator(), requestHash: 'changed-hash' }
        : creator();
    const adapter = new AccountedInvoiceIssueAdapter(
      binding,
      (kind) => (kind === 'invoice' ? identity() : customerIdentity()),
      () => intent(),
      request,
    );
    const source = issue();
    const prepared = adapter.prepare(source);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await expect(adapter.apply(source, prepared.request)).rejects.toThrow(
      /mapping changed|verified/,
    );
    expect(prepareCalls).toBeGreaterThanOrEqual(3);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['identity', (receipt: Record<string, unknown>) => ({ ...receipt, targetId: customerId })],
    [
      'hash',
      (receipt: Record<string, unknown>) => ({ ...receipt, issueRequestHash: 'other-hash' }),
    ],
    [
      'company',
      (receipt: Record<string, unknown>) => ({ ...receipt, targetCompany: 'other-company' }),
    ],
    [
      'warnings',
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        mutation: {
          ...(receipt.mutation as Record<string, unknown>),
          response: {
            ...((receipt.mutation as Record<string, unknown>).response as Record<string, unknown>),
            warnings: ['synthetic'],
          },
        },
      }),
    ],
    [
      'journal',
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        mutation: {
          ...(receipt.mutation as Record<string, unknown>),
          response: {
            ...((receipt.mutation as Record<string, unknown>).response as Record<string, unknown>),
            journal_entry_id: 'journal-1',
          },
        },
      }),
    ],
  ])('refuses a tampered complete %s receipt without GET', async (_name, mutate) => {
    const { adapter, request } = setup();
    const source = issue();
    const prepared = adapter.prepare(source);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    const applied = await adapter.apply(source, prepared.request);
    request.mockClear();
    const tampered = mutate(JSON.parse(JSON.stringify(applied.receipt)));
    expect(
      await adapter.verify({ ...source, targetId: applied.targetId, targetReceipt: tampered }),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts the actual markInvoicePrinted envelope with pdf undefined and rejects unconfirmed output', async () => {
    const calls: string[] = [];
    const transport: FortnoxTransport = {
      async request<T>(endpoint: string): Promise<T> {
        calls.push(`GET ${endpoint}`);
        if (endpoint === 'invoices/10') {
          return { Invoice: invoiceSource({ Sent: true }) } as T;
        }
        throw new Error(`Unexpected synthetic Fortnox call: ${endpoint}`);
      },
      async requestWithMetadata<T>(): Promise<T> {
        throw new Error('Unexpected synthetic metadata request');
      },
      async requestPdf(): Promise<Buffer> {
        throw new Error('Unexpected synthetic PDF read');
      },
      async requestPdfFromMutation(endpoint: string): Promise<Buffer | undefined> {
        calls.push(`PDF_MUTATION ${endpoint}`);
        return undefined;
      },
      async requestFile(): Promise<never> {
        throw new Error('Unexpected synthetic file request');
      },
      async fetchAllPages<T extends Record<string, unknown>>(): Promise<{
        items: T[];
        totalResources: number;
      }> {
        throw new Error('Unexpected synthetic pagination request');
      },
    };
    const operations = createFortnoxOperations(transport);
    const envelope = await operations.markInvoicePrinted('10');
    expect(envelope).toEqual({
      invoice: invoiceSource({ Sent: true }),
      confirmed: true,
      pdf: undefined,
    });
    expect(calls).toEqual(['PDF_MUTATION invoices/10/print', 'GET invoices/10']);

    const targetRequest = vi.fn(async () => ({
      status: 200,
      json: { data: targetInvoice('draft') },
    }));
    const adapter = makeAdapter(targetRequest);
    expect(adapter.prepare(issue({ sourceResult: envelope }))).toHaveProperty('request');
    expect(
      adapter.prepare(issue({ sourceResult: { ...envelope, confirmed: false } })),
    ).toHaveProperty('blocked');
    expect(targetRequest).not.toHaveBeenCalled();
  });
});
