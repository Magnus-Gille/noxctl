import { defaultFortnoxTransport, type FortnoxTransport } from '../fortnox-client.js';

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

export function createArticleOperations(transport: FortnoxTransport) {
  async function listArticles(params: ListArticlesParams = {}): Promise<ArticlesResponse> {
    const queryParams: Record<string, string | number | undefined> = {
      ...(params.search ? { description: params.search } : {}),
    };

    if (params.all) {
      const { items, totalResources } = await transport.fetchAllPages<Record<string, unknown>>(
        'articles',
        'Articles',
        queryParams,
      );
      return {
        Articles: items,
        MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
      };
    }

    return transport.request<ArticlesResponse>('articles', {
      params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
    });
  }

  async function getArticle(articleNumber: string): Promise<Record<string, unknown>> {
    const data = await transport.request<ArticleResponse>(
      `articles/${encodeURIComponent(articleNumber)}`,
    );
    return data.Article;
  }

  async function createArticle(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = await transport.request<ArticleResponse>('articles', {
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
      `articles/${encodeURIComponent(articleNumber)}`,
      {
        method: 'PUT',
        body: { Article: body },
      },
    );
    return data.Article;
  }

  async function deleteArticle(articleNumber: string): Promise<void> {
    await transport.request(`articles/${encodeURIComponent(articleNumber)}`, {
      method: 'DELETE',
    });
  }

  return { listArticles, getArticle, createArticle, updateArticle, deleteArticle };
}

export const { listArticles, getArticle, createArticle, updateArticle, deleteArticle } =
  createArticleOperations(defaultFortnoxTransport);
