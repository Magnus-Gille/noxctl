import { fortnoxRequest, fetchAllPages } from '../fortnox-client.js';

interface ArticleResponse {
  Article: Record<string, unknown>;
}

interface ArticlesResponse {
  Articles: Record<string, unknown>[];
  MetaInformation?: { '@TotalResources': number; '@TotalPages': number; '@CurrentPage': number };
}

export interface ListArticlesParams {
  search?: string;
  page?: number;
  limit?: number;
  all?: boolean;
}

export async function listArticles(params: ListArticlesParams = {}): Promise<ArticlesResponse> {
  const queryParams: Record<string, string | number | undefined> = {
    ...(params.search ? { description: params.search } : {}),
  };

  if (params.all) {
    const { items, totalResources } = await fetchAllPages<Record<string, unknown>>(
      'articles',
      'Articles',
      queryParams,
    );
    return {
      Articles: items,
      MetaInformation: { '@TotalResources': totalResources, '@TotalPages': 1, '@CurrentPage': 1 },
    };
  }

  return fortnoxRequest<ArticlesResponse>('articles', {
    params: { ...queryParams, page: params.page || 1, limit: params.limit || 100 },
  });
}

export async function getArticle(articleNumber: string): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ArticleResponse>(
    `articles/${encodeURIComponent(articleNumber)}`,
  );
  return data.Article;
}

export async function createArticle(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = await fortnoxRequest<ArticleResponse>('articles', {
    method: 'POST',
    body: { Article: params },
  });
  return data.Article;
}

export async function updateArticle(
  articleNumber: string,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ArticleNumber: _, ...body } = fields;
  const data = await fortnoxRequest<ArticleResponse>(
    `articles/${encodeURIComponent(articleNumber)}`,
    {
      method: 'PUT',
      body: { Article: body },
    },
  );
  return data.Article;
}
