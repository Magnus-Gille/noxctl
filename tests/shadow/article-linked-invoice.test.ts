import { describe, expect, it, vi } from 'vitest';
import { mapInvoiceDraft } from '../../src/shadow/invoice-draft-mapping.js';
import {
  AccountedInvoiceDraftAdapter,
  matchesInvoiceExpected,
} from '../../src/shadow/invoice-draft-adapter.js';
import { AccountedInvoiceIssueAdapter } from '../../src/shadow/invoice-issue-adapter.js';
import type { AccountedRequest } from '../../src/shadow/accounted-adapter.js';
import type { ShadowIdentityResolution, ShadowResourceKind } from '../../src/shadow/identity.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
const customerId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const articleA = '44444444-4444-4444-8444-444444444441';
const articleB = '44444444-4444-4444-8444-444444444442';
const itemIds = [
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
  '66666666-6666-4666-8666-666666666663',
];

type Spec = { description: string; price: number; article?: string; inputArticle?: unknown };

function creator(specs: Spec[], id = 'invoice-intent'): ShadowRecord {
  const net = specs.reduce((sum, spec) => sum + spec.price, 0);
  return {
    version: 1,
    id,
    operation: 'createInvoice',
    args: [
      {
        CustomerNumber: '7',
        InvoiceDate: '2026-01-01',
        DueDate: '2026-01-31',
        Currency: 'SEK',
        InvoiceRows: specs.map((spec) => ({
          Description: spec.description,
          DeliveredQuantity: 1,
          Price: spec.price,
          VAT: 25,
          Unit: 'st',
          ...(spec.inputArticle === undefined ? {} : { ArticleNumber: spec.inputArticle }),
        })),
      },
    ],
    ...binding,
    requestHash: 'creator-request-hash',
    state: 'applied',
    createdAt: 1,
    updatedAt: 1,
    sourceResult: {
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
      Net: net,
      TotalVAT: net / 4,
      Total: net * 1.25,
      TotalToPay: net * 1.25,
      Balance: net * 1.25,
      InvoiceRows: specs.map((spec) => ({
        Description: spec.description,
        DeliveredQuantity: '1',
        Price: spec.price,
        PriceExcludingVAT: spec.price,
        TotalExcludingVAT: spec.price,
        Total: spec.price,
        Discount: 0,
        VAT: 25,
        Unit: 'st',
        HouseWork: false,
        CostCenter: '',
        Project: '',
        ArticleNumber: spec.article ?? '',
        AccountNumber: 3001,
      })),
    },
  };
}

type ArticleMap = Record<string, ShadowIdentityResolution>;
function ready(sourceId: string, targetId: string): ShadowIdentityResolution {
  return {
    state: 'ready',
    resource: 'article',
    sourceId,
    targetId,
    intentId: `article-${sourceId}`,
    requestHash: `article-hash-${sourceId}`,
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
function lookupWith(articles: ArticleMap) {
  const calls: Array<[ShadowResourceKind, string]> = [];
  const lookup = (kind: ShadowResourceKind, id: string): ShadowIdentityResolution => {
    calls.push([kind, id]);
    if (kind === 'customer') {
      return {
        state: 'ready',
        resource: 'customer',
        sourceId: id,
        targetId: customerId,
        intentId: 'customer-intent',
        requestHash: 'customer-hash',
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
    if (kind === 'invoice') {
      return {
        state: 'ready',
        resource: 'invoice',
        sourceId: id,
        targetId: invoiceId,
        intentId: 'invoice-intent',
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
    return articles[id] ?? { state: 'missing' };
  };
  return { lookup, calls };
}

const linked: Spec[] = [
  { description: 'Plain text-free row', price: 100 },
  { description: 'Linked row A', price: 200, article: '00123-aB' },
  { description: 'Linked row B', price: 300, article: 'X-9' },
  { description: 'Linked row A again', price: 400, article: '00123-aB' },
];
const articles = (): ArticleMap => ({
  '00123-aB': ready('00123-aB', articleA),
  'X-9': ready('X-9', articleB),
});

function mapped(specs: Spec[], map: ArticleMap = articles()) {
  return mapInvoiceDraft(creator(specs), binding, lookupWith(map).lookup);
}
function mappedOk(specs: Spec[], map: ArticleMap = articles()) {
  const result = mapped(specs, map);
  if ('blocked' in result) throw new Error(result.blocked);
  return result;
}

describe('article-linked invoice rows: mapping', () => {
  it('emits article_id for linked rows, keeps row values and order, leaves unlinked rows bare', () => {
    const result = mappedOk(linked);
    expect(result.request.items.map((item) => item.description)).toEqual(
      linked.map((spec) => spec.description),
    );
    expect(result.request.items.map((item) => item.article_id)).toEqual([
      undefined,
      articleA,
      articleB,
      articleA,
    ]);
    expect(result.request.items.map((item) => item.unit_price)).toEqual([100, 200, 300, 400]);
    expect(result.request.items.every((item) => item.unit === 'st')).toBe(true);
    expect(Object.hasOwn(result.request.items[0]!, 'article_id')).toBe(false);
    expect(result.expected.items.map((item) => item.article_id)).toEqual([
      undefined,
      articleA,
      articleB,
      articleA,
    ]);
  });

  it('looks up the exact opaque ArticleNumber once per distinct number, preserving leading zeros and case', () => {
    const { lookup, calls } = lookupWith(articles());
    mapInvoiceDraft(creator(linked), binding, lookup);
    expect(calls.filter(([kind]) => kind === 'article')).toEqual([
      ['article', '00123-aB'],
      ['article', 'X-9'],
    ]);
  });

  it('does not look up articles for unlinked invoices', () => {
    const { lookup, calls } = lookupWith({});
    mapInvoiceDraft(creator([{ description: 'x', price: 100 }]), binding, lookup);
    expect(calls.map(([kind]) => kind)).toEqual(['customer']);
  });

  it('accepts a matching input ArticleNumber and refuses a differing one', () => {
    expect(
      'request' in mapped([{ description: 'a', price: 100, article: 'X-9', inputArticle: 'X-9' }]),
    ).toBe(true);
    const differing = mapped([
      { description: 'a', price: 100, article: 'X-9', inputArticle: 'x-9' },
    ]);
    expect(differing).toMatchObject({ blocked: expect.stringContaining('ARTICLE_NUMBER_INPUT') });
  });

  it('lowercases the persisted target UUID so readback compares exactly', () => {
    const upper = articleA.toUpperCase();
    const result = mappedOk([{ description: 'a', price: 100, article: 'X-9' }], {
      'X-9': ready('X-9', upper),
    });
    expect(result.request.items[0]!.article_id).toBe(articleA);
  });

  it.each([
    ['unmapped', {}, 'ARTICLE_UNMAPPED'],
    [
      'unknown outcome',
      {
        '00123-aB': {
          state: 'unresolved',
          intentIds: ['a'],
          reason: 'not applied',
        } as ShadowIdentityResolution,
      },
      'ARTICLE_IDENTITY_UNRESOLVED',
    ],
    [
      'conflict',
      {
        '00123-aB': {
          state: 'conflict',
          intentIds: ['a', 'b'],
          reason: 'dup',
        } as ShadowIdentityResolution,
      },
      'ARTICLE_IDENTITY_CONFLICT',
    ],
    [
      'wrong resource',
      { '00123-aB': { ...ready('00123-aB', articleA), resource: 'customer' as const } },
      'ARTICLE_IDENTITY_MALFORMED',
    ],
    ['wrong source id', { '00123-aB': ready('0123-aB', articleA) }, 'ARTICLE_IDENTITY_MALFORMED'],
    [
      'non-uuid target',
      { '00123-aB': ready('00123-aB', 'not-a-uuid') },
      'ARTICLE_IDENTITY_MALFORMED',
    ],
    [
      'wrong company',
      { '00123-aB': { ...ready('00123-aB', articleA), targetCompany: 'other' } },
      'ARTICLE_IDENTITY_MALFORMED',
    ],
  ])('refuses %s article identity without a request', (_name, map, code) => {
    const result = mapped(
      [{ description: 'a', price: 100, article: '00123-aB' }],
      map as ArticleMap,
    );
    expect(result).toMatchObject({ blocked: expect.stringContaining(code) });
    expect('request' in result).toBe(false);
  });

  it('refuses when a lookup throws', () => {
    const result = mapInvoiceDraft(
      creator([{ description: 'a', price: 100, article: 'X-9' }]),
      binding,
      (kind) => {
        if (kind === 'article') throw new Error('boom');
        return lookupWith({}).lookup(kind, '7');
      },
    );
    expect(result).toMatchObject({
      blocked: expect.stringContaining('ARTICLE_IDENTITY_UNRESOLVED'),
    });
  });

  it.each([
    ['numeric', 123],
    ['padded', ' X-9'],
    ['control character', 'X\n9'],
    ['object', {}],
  ])('refuses a %s ArticleNumber without parsing it', (_name, value) => {
    const record = creator([{ description: 'a', price: 100, article: 'X-9' }]);
    (
      record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> }
    ).InvoiceRows[0]!.ArticleNumber = value;
    const result = mapInvoiceDraft(record, binding, lookupWith(articles()).lookup);
    expect(result).toMatchObject({ blocked: expect.stringContaining('ARTICLE_NUMBER_INVALID') });
  });

  it('treats a null source ArticleNumber as an unlinked row', () => {
    for (const inputArticle of [undefined, null, '']) {
      const record = creator([{ description: 'a', price: 100, inputArticle }]);
      (
        record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> }
      ).InvoiceRows[0]!.ArticleNumber = null;
      const result = mapInvoiceDraft(record, binding, lookupWith(articles()).lookup);
      expect(result, String(inputArticle)).toHaveProperty('request');
      const items = (result as { request: { items: Array<Record<string, unknown>> } }).request
        .items;
      expect(items[0]).not.toHaveProperty('article_id');
    }
    const record = creator([{ description: 'a', price: 100, inputArticle: 'X-9' }]);
    (
      record.sourceResult as { InvoiceRows: Array<Record<string, unknown>> }
    ).InvoiceRows[0]!.ArticleNumber = null;
    expect(mapInvoiceDraft(record, binding, lookupWith(articles()).lookup)).toMatchObject({
      blocked: expect.stringContaining('ARTICLE_NUMBER_INPUT_MISMATCH'),
    });
  });

  it('changes the bound expected content when article_id changes', () => {
    const one = mappedOk([{ description: 'a', price: 100, article: 'X-9' }]);
    const two = mappedOk([{ description: 'a', price: 100, article: 'X-9' }], {
      'X-9': ready('X-9', articleA),
    });
    const bare = mappedOk([{ description: 'a', price: 100 }]);
    expect(JSON.stringify(one.expected)).not.toEqual(JSON.stringify(two.expected));
    expect(JSON.stringify(one.expected)).not.toEqual(JSON.stringify(bare.expected));
    expect(JSON.stringify(one.request)).not.toEqual(JSON.stringify(two.request));
  });
});

function targetInvoice(
  expected: ReturnType<typeof mappedOk>['expected'],
  overrides: unknown[] = [],
) {
  return {
    ...expected,
    id: invoiceId,
    subtotal_sek: expected.subtotal,
    vat_amount_sek: expected.vat_amount,
    total_sek: expected.total,
    vat_treatment: 'standard',
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
    items: expected.items.map((item, index) => ({
      ...item,
      id: itemIds[index] ?? `66666666-6666-4666-8666-66666666667${index}`,
      sort_order: index,
      line_type: 'product',
      article_id: item.article_id ?? null,
      deduction_type: null,
      deduction_amount: 0,
      dimensions: {},
      ...(overrides[index] as object | undefined),
    })),
  };
}

describe('article-linked invoice rows: readback verification', () => {
  const specs: Spec[] = [
    { description: 'Linked', price: 100, article: '00123-aB' },
    { description: 'Free text', price: 200 },
  ];

  it('accepts matching article_id and null for unlinked rows', () => {
    const { expected } = mappedOk(specs);
    expect(matchesInvoiceExpected({ data: targetInvoice(expected) }, invoiceId, expected)).toBe(
      true,
    );
  });

  it.each([
    ['wrong article uuid', [{ article_id: articleB }]],
    ['dropped article link', [{ article_id: null }]],
    ['link on unlinked row', [{}, { article_id: articleA }]],
    ['missing article_id', [{ article_id: undefined }]],
  ])('rejects %s', (_name, overrides) => {
    const { expected } = mappedOk(specs);
    expect(
      matchesInvoiceExpected({ data: targetInvoice(expected, overrides) }, invoiceId, expected),
    ).toBe(false);
  });

  it('draft apply retains the UUID as pending, without a second create, on article_id mismatch', async () => {
    const { lookup } = lookupWith(articles());
    const plan = mappedOk(specs);
    const request = vi.fn(async (input: AccountedRequest) => {
      if (input.method === 'POST') return { status: 201, json: { data: { id: invoiceId } } };
      return {
        status: 200,
        json: { data: targetInvoice(plan.expected, [{ article_id: articleB }]) },
      };
    });
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
    const record = creator(specs);
    const prepared = adapter.prepare(record);
    if (!('request' in prepared)) throw new Error(prepared.blocked);
    await expect(adapter.apply(record, prepared.request)).rejects.toMatchObject({
      targetId: invoiceId,
    });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(
      (
        request.mock.calls[0]![0] as { body: { items: Array<{ article_id?: string }> } }
      ).body.items.map((item) => item.article_id),
    ).toEqual([articleA, undefined]);
  });

  it('draft verify fails when the saved receipt predates the article binding', async () => {
    const { lookup } = lookupWith(articles());
    const plan = mappedOk(specs);
    const request = vi.fn(async () => ({
      status: 200,
      json: { data: targetInvoice(plan.expected) },
    }));
    const adapter = new AccountedInvoiceDraftAdapter(binding, lookup, request);
    const record = {
      ...creator(specs),
      targetId: invoiceId,
      targetReceipt: { data: { id: invoiceId }, expected: plan.expected, sourceInvoiceId: '10' },
    };
    expect(await adapter.verify(record)).toBe(true);
    const stripped = {
      ...record,
      targetReceipt: {
        ...record.targetReceipt,
        expected: {
          ...plan.expected,
          items: plan.expected.items.map(({ article_id: _drop, ...rest }) => rest),
        },
      },
    };
    expect(await adapter.verify(stripped)).toBe(false);
  });
});

describe('article-linked invoice rows: issue adapter binding', () => {
  const specs: Spec[] = [
    { description: 'Linked', price: 100, article: '00123-aB' },
    { description: 'Free text', price: 200 },
  ];
  function issueRecord(): ShadowRecord {
    const base = creator(specs);
    return {
      ...base,
      id: 'issue-intent',
      operation: 'markInvoicePrinted',
      args: ['10'],
      requestHash: 'issue-request-hash',
      state: 'pending',
      createdAt: 2,
      updatedAt: 2,
      sourceResult: {
        invoice: { ...(base.sourceResult as object), Sent: true },
        confirmed: true,
        pdf: Buffer.from('%PDF-synthetic'),
      },
    };
  }
  function adapterFor(map: ArticleMap, receiptExpected?: unknown) {
    const plan = mappedOk(specs);
    const base = creator(specs);
    const intent: ShadowRecord = {
      ...base,
      targetId: invoiceId,
      targetReceipt: {
        data: { id: invoiceId },
        expected: receiptExpected ?? plan.expected,
        sourceInvoiceId: '10',
      },
    };
    return new AccountedInvoiceIssueAdapter(
      binding,
      lookupWith(map).lookup,
      (id) => (id === 'invoice-intent' ? intent : undefined),
      vi.fn(),
    );
  }

  it('prepares when creator receipt and remapped article identity agree', () => {
    expect(adapterFor(articles()).prepare(issueRecord())).toHaveProperty('request');
  });

  it('blocks when the creator receipt was bound without article_id', () => {
    const plan = mappedOk(specs);
    const stripped = {
      ...plan.expected,
      items: plan.expected.items.map(({ article_id: _drop, ...rest }) => rest),
    };
    expect(adapterFor(articles(), stripped).prepare(issueRecord())).toHaveProperty('blocked');
  });

  it('blocks when the article now resolves to a different UUID or is no longer mapped', () => {
    expect(
      adapterFor({ '00123-aB': ready('00123-aB', articleB) }).prepare(issueRecord()),
    ).toHaveProperty('blocked');
    expect(adapterFor({}).prepare(issueRecord())).toHaveProperty('blocked');
  });
});
