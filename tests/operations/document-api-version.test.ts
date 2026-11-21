import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FortnoxTransport } from '../../src/fortnox-client.js';
import {
  DOCUMENT_API_ENV,
  InvalidDocumentApiEnvError,
  documentResource,
  parseDocumentApiEnv,
} from '../../src/document-api-version.js';
import { createArticleOperations } from '../../src/operations/articles.js';
import { createInvoiceOperations } from '../../src/operations/invoices.js';
import { createOfferOperations } from '../../src/operations/offers.js';
import { createOrderOperations } from '../../src/operations/orders.js';

function recordingTransport() {
  const endpoints: string[] = [];
  const record = (endpoint: string) => {
    endpoints.push(endpoint);
    return Promise.resolve({
      Invoice: {},
      Invoices: [],
      Offer: {},
      Offers: [],
      Order: {},
      Orders: [],
      Article: {},
      Articles: [],
    });
  };
  const transport = {
    request: vi.fn(record),
    requestWithMetadata: vi.fn(record),
    requestPdf: vi.fn((endpoint: string) => {
      endpoints.push(endpoint);
      return Promise.resolve(Buffer.from('%PDF'));
    }),
    requestPdfFromMutation: vi.fn((endpoint: string) => {
      endpoints.push(endpoint);
      return Promise.resolve(Buffer.from('%PDF'));
    }),
    requestFile: vi.fn(),
    fetchAllPages: vi.fn((endpoint: string) => {
      endpoints.push(endpoint);
      return Promise.resolve({ items: [], totalResources: 0 });
    }),
  } as unknown as FortnoxTransport;
  return { transport, endpoints };
}

async function exerciseAll(transport: FortnoxTransport) {
  const invoices = createInvoiceOperations(transport);
  const offers = createOfferOperations(transport);
  const orders = createOrderOperations(transport);
  const articles = createArticleOperations(transport);

  await invoices.listInvoices();
  await invoices.listInvoices({ all: true });
  await invoices.getInvoice('1');
  await invoices.getInvoicePdf('1');
  await offers.listOffers();
  await offers.getOffer('2');
  await offers.createInvoiceFromOffer('2');
  await orders.listOrders({ all: true });
  await orders.getOrder('3');
  await orders.createInvoiceFromOrder('3');
  await articles.listArticles();
  await articles.getArticle('A1');
}

describe('document API version (NOX-219..222)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('parseDocumentApiEnv', () => {
    it('defaults to v2 when unset or empty', () => {
      expect(parseDocumentApiEnv(undefined)).toBe('v2');
      expect(parseDocumentApiEnv('')).toBe('v2');
    });

    it('accepts classic and v2 in any case', () => {
      expect(parseDocumentApiEnv('classic')).toBe('classic');
      expect(parseDocumentApiEnv('V2')).toBe('v2');
    });

    it('fails closed on unknown values without echoing them', () => {
      expect(() => parseDocumentApiEnv('v3-ish')).toThrow(InvalidDocumentApiEnvError);
      expect(() => parseDocumentApiEnv('v3-ish')).not.toThrow(/v3-ish/);
    });
  });

  it('maps the four families to -v2 by default and to classic only when opted out', () => {
    vi.stubEnv(DOCUMENT_API_ENV, 'classic');
    expect(documentResource('invoices')).toBe('invoices');
    vi.stubEnv(DOCUMENT_API_ENV, '');
    expect(documentResource('invoices')).toBe('invoices-v2');
    expect(documentResource('offers')).toBe('offers-v2');
    expect(documentResource('orders')).toBe('orders-v2');
    expect(documentResource('articles')).toBe('articles-v2');
  });

  it('keeps the classic endpoints when opted out', async () => {
    vi.stubEnv(DOCUMENT_API_ENV, 'classic');
    const { transport, endpoints } = recordingTransport();
    await exerciseAll(transport);
    expect(endpoints).toEqual([
      'invoices',
      'invoices',
      'invoices/1',
      'invoices/1/preview',
      'offers',
      'offers/2',
      'offers/2/createinvoice',
      'orders',
      'orders/3',
      'orders/3/createinvoice',
      'articles',
      'articles/A1',
    ]);
  });

  it('routes every call of the four families to -v2 by default', async () => {
    vi.stubEnv(DOCUMENT_API_ENV, undefined);
    const { transport, endpoints } = recordingTransport();
    await exerciseAll(transport);
    expect(endpoints).toEqual([
      'invoices-v2',
      'invoices-v2',
      'invoices-v2/1',
      'invoices-v2/1/preview',
      'offers-v2',
      'offers-v2/2',
      'offers-v2/2/createinvoice',
      'orders-v2',
      'orders-v2/3',
      'orders-v2/3/createinvoice',
      'articles-v2',
      'articles-v2/A1',
    ]);
  });

  it('refuses to call Fortnox when the variable is invalid', async () => {
    vi.stubEnv(DOCUMENT_API_ENV, 'bogus');
    const { transport, endpoints } = recordingTransport();
    await expect(createInvoiceOperations(transport).getInvoice('1')).rejects.toThrow(
      InvalidDocumentApiEnvError,
    );
    expect(endpoints).toEqual([]);
  });
});
