import { documentResource } from '../document-api-version.js';
import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';
import { pathSegment } from '../identifiers.js';

interface ArticleResponse {
  Article: Record<string, unknown>;
}

export interface ArticlesResponse {
  Articles: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListArticlesParams {
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

/**
 * One row of a bundle price calculation: a bundle's target price and its sub
 * rows. Fortnox's OpenAPI request schema for this endpoint is wrong (it reuses
 * the article envelope), so the row is passed through as documented in the
 * endpoint description instead of being typed from the spec.
 */
export type BundlePriceCalculationRow = Record<string, unknown>;

export interface BundlePriceCalculation {
  Rows: Record<string, unknown>[];
  [key: string]: unknown;
}

interface BundlePriceCalculationResponse {
  BundlePriceCalculation: BundlePriceCalculation;
}

/**
 * Bundle price calculation exists only in the v2 article family, so it ignores
 * NOXCTL_FORTNOX_DOCUMENT_API=classic: there is no classic endpoint to fall back to.
 */
const BUNDLE_PRICE_CALCULATION_PATH = 'articles-v2/calculatebundleprices';

export function createArticleOperations(transport: FortnoxTransport) {
  async function listArticles(params: ListArticlesParams = {}): Promise<ArticlesResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.search ? { description: params.search } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        documentResource('articles'),
        'Articles',
        queryParams,
      );
      return {
        Articles: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<ArticlesResponse>(documentResource('articles'), {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getArticle(articleNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ArticleResponse>(
      `${documentResource('articles')}/${pathSegment('article number', articleNumber)}`,
    );
    return data.Article;
  }

  async function createArticle(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<ArticleResponse>(documentResource('articles'), {
      method: 'POST',
      body: { Article: params },
    });
    return data.Article;
  }

  async function updateArticle(
    articleNumber: string,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { ArticleNumber: _, ...body } = fields;
    const data = await transport.request<ArticleResponse>(
      `${documentResource('articles')}/${pathSegment('article number', articleNumber)}`,
      {
        method: 'PUT',
        body: { Article: body },
      },
    );
    return data.Article;
  }

  async function deleteArticle(articleNumber: string): Promise<void> {
    await transport.request(
      `${documentResource('articles')}/${pathSegment('article number', articleNumber)}`,
      {
        method: 'DELETE',
      },
    );
  }

  /**
   * Ask Fortnox to split each bundle row's price over its sub rows (and,
   * optionally, a price adjustment row). Fortnox documents this as a pure
   * calculation: it returns the prices and saves nothing, even though it is a POST.
   */
  async function calculateBundlePrices(
    rows: BundlePriceCalculationRow[],
  ): Promise<BundlePriceCalculation> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Bundle price calculation needs at least one row.');
    }
    const data = await transport.request<BundlePriceCalculationResponse>(
      BUNDLE_PRICE_CALCULATION_PATH,
      {
        method: 'POST',
        body: { BundlePriceCalculation: { Rows: rows } },
      },
    );
    return data.BundlePriceCalculation;
  }

  return {
    listArticles,
    getArticle,
    createArticle,
    updateArticle,
    deleteArticle,
    calculateBundlePrices,
  };
}

export const {
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  calculateBundlePrices,
} = createArticleOperations(defaultFortnoxTransport);
