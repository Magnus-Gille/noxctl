import { isDeepStrictEqual } from 'node:util';
import { TargetBlockedError } from './types.js';
import type { ShadowAdapter, ShadowRecord, ShadowTargetReceipt } from './types.js';
import type { AccountedRequestCallback } from './accounted-adapter.js';

/** Stable reasons (NOX-213). Each prefixes the persisted `reason` of a blocked record. */
export const ARTICLE_LINK_ARGS_INVALID = 'ARTICLE_LINK_ARGS_INVALID';
export const ARTICLE_LINK_NUMBER_INVALID = 'ARTICLE_LINK_NUMBER_INVALID';
export const ARTICLE_LINK_UUID_INVALID = 'ARTICLE_LINK_UUID_INVALID';
export const ARTICLE_LINK_NOT_FOUND = 'ARTICLE_LINK_NOT_FOUND';
export const ARTICLE_LINK_NUMBER_MISMATCH = 'ARTICLE_LINK_NUMBER_MISMATCH';
export const ARTICLE_LINK_ACTIVE = 'ARTICLE_LINK_ACTIVE';
export const ARTICLE_LINK_AMBIGUOUS = 'ARTICLE_LINK_AMBIGUOUS';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface ArticleLinkRequest {
  articleNumber: string;
  targetArticleId: string;
}

interface ArticleLinkData {
  id: string;
  article_number: string;
  active: true;
}

/**
 * Links an existing Fortnox article to an operator-chosen existing Accounted article. It performs
 * read-only requests only: Accounted articles are never created or changed by shadow mirroring.
 * The article number is an opaque string and is never coerced, trimmed or case-folded.
 */
export class AccountedArticleLinkAdapter implements ShadowAdapter {
  private readonly path: string;

  constructor(
    private readonly targetCompany: string,
    private readonly request: AccountedRequestCallback,
  ) {
    // Accounted has no GET-by-id for articles. Inactive articles are included so that an inactive
    // target is reported as such and an article_number reused by an inactive article is ambiguous.
    this.path = `/api/v1/companies/${encodeURIComponent(targetCompany)}/articles?include_inactive=true`;
  }

  prepare(record: ShadowRecord): { request: ArticleLinkRequest } | { blocked: string } {
    if (record.targetCompany !== this.targetCompany)
      return { blocked: 'Target company does not match the adapter binding.' };
    if (record.operation !== 'baselineArticle')
      return { blocked: `Unsupported operation: ${record.operation}.` };
    if (!Array.isArray(record.args) || record.args.length !== 1 || !plain(record.args[0])) {
      return {
        blocked: `${ARTICLE_LINK_ARGS_INVALID}: baselineArticle requires exactly one plain object argument.`,
      };
    }
    const input = record.args[0];
    const keys = Object.keys(input).sort();
    if (keys.length !== 2 || keys[0] !== 'ArticleNumber' || keys[1] !== 'targetArticleId') {
      return {
        blocked: `${ARTICLE_LINK_ARGS_INVALID}: baselineArticle requires exactly { ArticleNumber, targetArticleId }.`,
      };
    }
    const wanted = input.ArticleNumber;
    const source = plain(record.sourceResult) ? record.sourceResult.ArticleNumber : undefined;
    if (
      typeof wanted !== 'string' ||
      wanted.length === 0 ||
      wanted.length > 200 ||
      wanted.trim() !== wanted ||
      /[\u0000-\u001f\u007f-\u009f]/.test(wanted) ||
      typeof source !== 'string' ||
      source !== wanted
    ) {
      return {
        blocked: `${ARTICLE_LINK_NUMBER_INVALID}: ArticleNumber must be a nonblank, unpadded opaque string equal to the confirmed source article's ArticleNumber.`,
      };
    }
    const targetArticleId = input.targetArticleId;
    if (typeof targetArticleId !== 'string' || !UUID.test(targetArticleId)) {
      return { blocked: `${ARTICLE_LINK_UUID_INVALID}: targetArticleId must be a UUID.` };
    }
    return { request: { articleNumber: wanted, targetArticleId } };
  }

  /** Read the article list and check the link; throws TargetBlockedError on a proven mismatch. */
  private async check(link: ArticleLinkRequest): Promise<ArticleLinkData> {
    const response = await this.request({ method: 'GET', path: this.path });
    if (response.status !== 200)
      throw new Error(`Accounted articles list returned HTTP ${response.status}.`);
    const body = response.json;
    const list = plain(body) && plain(body.data) ? body.data.articles : undefined;
    if (!Array.isArray(list)) throw new Error('Accounted articles list is malformed.');
    // Every entry must carry valid identity fields, or the list cannot prove uniqueness.
    const entries = list.filter(
      (entry): entry is { id: string; article_number: string | null; active: boolean } =>
        plain(entry) &&
        typeof entry.id === 'string' &&
        UUID.test(entry.id) &&
        (entry.article_number === null || typeof entry.article_number === 'string') &&
        typeof entry.active === 'boolean',
    );
    if (entries.length !== list.length) throw new Error('Accounted articles list is malformed.');
    const wantedId = link.targetArticleId.toLowerCase();
    const distinctIds = new Set(entries.map((entry) => entry.id.toLowerCase()));
    if (distinctIds.size !== entries.length)
      throw new TargetBlockedError(
        `${ARTICLE_LINK_AMBIGUOUS}: the article list contains duplicate ids (case-insensitive).`,
      );

    const byId = entries.filter((entry) => entry.id.toLowerCase() === wantedId);
    if (byId.length === 0)
      throw new TargetBlockedError(
        `${ARTICLE_LINK_NOT_FOUND}: target article is not in the company's article list.`,
      );
    const sameNumber = entries.filter((entry) => entry.article_number === link.articleNumber);
    if (byId.length > 1 || sameNumber.length > 1)
      throw new TargetBlockedError(
        `${ARTICLE_LINK_AMBIGUOUS}: the article id or article_number matches more than one target article.`,
      );
    const target = byId[0]!;
    if (target.article_number !== link.articleNumber)
      throw new TargetBlockedError(
        `${ARTICLE_LINK_NUMBER_MISMATCH}: target article_number differs from the source ArticleNumber.`,
      );
    if (target.active !== true)
      throw new TargetBlockedError(`${ARTICLE_LINK_ACTIVE}: target article is not active.`);
    return { id: link.targetArticleId, article_number: link.articleNumber, active: true };
  }

  async apply(record: ShadowRecord, request: unknown): Promise<ShadowTargetReceipt> {
    const prepared = this.prepare(record);
    if (!('request' in prepared) || !isDeepStrictEqual(prepared.request, request))
      throw new Error('Article link request does not match the prepared mapping.');
    const data = await this.check(prepared.request);
    return { targetId: data.id, receipt: { data, expected: prepared.request } };
  }

  /** Drift detection: repeat the read-only checks against the persisted link. */
  async verify(record: ShadowRecord): Promise<boolean> {
    if (record.targetCompany !== this.targetCompany) return false;
    const prepared = this.prepare(record);
    if (!('request' in prepared) || record.targetId !== prepared.request.targetArticleId)
      return false;
    const receipt = record.targetReceipt;
    if (
      !plain(receipt) ||
      !plain(receipt.data) ||
      receipt.data.id !== record.targetId ||
      receipt.data.article_number !== prepared.request.articleNumber ||
      !isDeepStrictEqual(receipt.expected, prepared.request)
    )
      return false;
    try {
      await this.check(prepared.request);
      return true;
    } catch (error) {
      if (error instanceof TargetBlockedError) return false;
      throw error;
    }
  }
}
