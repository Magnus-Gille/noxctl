import { fortnoxRequest } from '../fortnox-client.js';

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
}

export async function listArticles(params: ListArticlesParams = {}): Promise<ArticlesResponse> {
  return fortnoxRequest<ArticlesResponse>('articles', {
    params: {
      page: params.page || 1,
      limit: params.limit || 100,
      ...(params.search ? { description: params.search } : {}),
    },
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
