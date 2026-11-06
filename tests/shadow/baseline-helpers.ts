import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { openShadowQueue } from '../../src/shadow/queue.js';
import type { AccountedRequest, AccountedResponse } from '../../src/shadow/accounted-adapter.js';
import type { ShadowRecord } from '../../src/shadow/types.js';

export const binding = {
  sourceCompany: 'synthetic-source',
  targetCompany: '33333333-3333-4333-8333-333333333333',
};
export const ids = [
  '550e8400-e29b-41d4-a716-446655440000',
  '7a1c89b0-d2f3-41c6-a7f1-879a44c3d177',
  '4ab23938-fdb6-4470-8d12-d47b338090a2',
  '9e7dc1a5-72a0-42ce-a332-fec2800c6207',
];

const roots: string[] = [];
export function useTempDirs(): () => string {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  return () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-'));
    roots.push(root);
    return root;
  };
}

export type Queue = Awaited<ReturnType<typeof openShadowQueue>>;

export const sourceCustomer = {
  CustomerNumber: '7',
  Name: 'Exempel AB',
  Type: 'COMPANY',
  VATType: 'SEVAT',
  Currency: 'SEK',
  CountryCode: 'SE',
  Country: 'Sverige',
};

/** In-memory fake of the native customer routes; records every request. */
export function fakeCustomerTarget(options: { postStatus?: number; postThrows?: boolean } = {}) {
  const calls: AccountedRequest[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const request = async (input: AccountedRequest): Promise<AccountedResponse> => {
    calls.push(input);
    if (input.method === 'POST') {
      if (options.postThrows) throw new Error('socket hang up');
      const data = { id: ids[0]!, ...(input.body as Record<string, unknown>) };
      stored.set(data.id, data);
      return { status: options.postStatus ?? 201, json: { data } };
    }
    const id = decodeURIComponent(input.path.split('/').pop()!);
    const data = stored.get(id);
    return data ? { status: 200, json: { data } } : { status: 404, json: {} };
  };
  return { calls, request };
}

export function articleEntry(
  id: string,
  articleNumber: string | null,
  extra: Record<string, unknown> = {},
) {
  return { id, article_number: articleNumber, name: 'Synthetic', active: true, ...extra };
}

/** Fake of GET .../articles; `articles` may be replaced between calls to simulate drift. */
export function fakeArticleTarget(initial: unknown[]) {
  const calls: AccountedRequest[] = [];
  const state = { articles: initial, status: 200 };
  const request = async (input: AccountedRequest): Promise<AccountedResponse> => {
    calls.push(input);
    return { status: state.status, json: { data: { articles: state.articles } } };
  };
  return { calls, state, request };
}

export function invoiceRecord(articleNumber?: string): ShadowRecord {
  return {
    version: 1,
    id: 'invoice-intent',
    operation: 'createInvoice',
    args: [
      {
        CustomerNumber: '7',
        InvoiceDate: '2026-01-01',
        DueDate: '2026-01-31',
        Currency: 'SEK',
        InvoiceRows: [
          {
            Description: 'Row',
            DeliveredQuantity: 1,
            Price: 100,
            VAT: 25,
            Unit: 'st',
            ...(articleNumber === undefined ? {} : { ArticleNumber: articleNumber }),
          },
        ],
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
      Net: 100,
      TotalVAT: 25,
      Total: 125,
      TotalToPay: 125,
      Balance: 125,
      InvoiceRows: [
        {
          Description: 'Row',
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
          ArticleNumber: articleNumber ?? '',
          AccountNumber: 3001,
        },
      ],
    },
  };
}
