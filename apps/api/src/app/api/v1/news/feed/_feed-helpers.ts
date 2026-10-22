export type NewsFeedSource = 'all' | 'news' | 'tweets';

export interface FeedArticle {
    title: string;
    url: string;
    image: string;
    author: string;
    posted_at: string;
    type: 'news';
    source_name: string;
    related_coin_ids: string[];
    feed_source: 'coingecko' | 'x';
}

export function parseBoundedInt(
    value: string | null,
    defaults: { defaultValue: number; min: number; max: number },
): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed)) return defaults.defaultValue;
    return Math.min(Math.max(parsed, defaults.min), defaults.max);
}

export function parseFeedSource(value: string | null): NewsFeedSource {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'news' || normalized === 'tweets') return normalized;
    return 'all';
}

export function getEffectiveTweetReserve(params: {
    source: NewsFeedSource;
    limit: number;
    requestedTweetReserve: number;
}): number {
    if (params.source === 'news') return 0;
    if (params.source === 'tweets') return params.limit;
    return Math.min(Math.max(params.requestedTweetReserve, 0), params.limit);
}

export function getCoinGeckoNewsPageCount(params: { requestedCount: number; perPage: number; maxPages: number }): number {
    if (params.requestedCount <= 0 || params.perPage <= 0 || params.maxPages <= 0) return 0;
    return Math.min(Math.ceil(params.requestedCount / params.perPage), params.maxPages);
}

export async function collectPaginatedFeedPages<PageItem, Result>(params: {
    pageCount: number;
    requestedCount: number;
    fetchPage: (page: number) => Promise<PageItem[]>;
    mapPageItems: (items: PageItem[]) => Result[];
    onPageError?: (error: unknown, context: { page: number; collectedCount: number }) => void;
}): Promise<Result[]> {
    const results: Result[] = [];
    if (params.pageCount <= 0 || params.requestedCount <= 0) return results;

    for (let page = 1; page <= params.pageCount; page += 1) {
        let pageItems: PageItem[];
        try {
            pageItems = await params.fetchPage(page);
        } catch (error) {
            params.onPageError?.(error, { page, collectedCount: results.length });
            break;
        }

        if (pageItems.length === 0) break;

        results.push(...params.mapPageItems(pageItems));
        if (results.length >= params.requestedCount) break;
    }

    return results;
}

function parsePostedAtMs(value: string): number {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function isSafeHref(value: string | undefined | null): value is string {
    if (!value) return false;

    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

export function normalizeFeedTerm(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * `extraText` is matched alongside the article's visible fields but never
 * displayed: X posts pass their pre-rewrite text so a `solana:<mint>` token tag
 * still matches a mint term after the title has been rewritten to `$SYMBOL`.
 */
export function articleMatchesTerms(article: FeedArticle, terms: string[], extraText = ''): boolean {
    const normalizedTerms = terms.map(normalizeFeedTerm).filter(Boolean);
    if (normalizedTerms.length === 0) return false;

    const relatedCoinIds = new Set(article.related_coin_ids.map(normalizeFeedTerm).filter(Boolean));
    const text = `${article.title} ${article.source_name} ${article.author} ${extraText}`.toLowerCase();
    return normalizedTerms.some(term => {
        if (relatedCoinIds.has(term)) return true;

        if (term.length <= 2) return text.includes(`$${term}`);
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text.includes(`$${term}`) || new RegExp(`\\b${escaped}\\b`, 'i').test(text);
    });
}

export function selectFeedArticles(params: {
    newsArticles: FeedArticle[];
    xArticles: FeedArticle[];
    limit: number;
    source: NewsFeedSource;
    tweetReserve: number;
}): FeedArticle[] {
    const sortedNews = params.newsArticles
        .filter(article => isSafeHref(article.url))
        .slice()
        .sort((a, b) => parsePostedAtMs(b.posted_at) - parsePostedAtMs(a.posted_at));
    const sortedX = params.xArticles
        .filter(article => isSafeHref(article.url))
        .slice()
        .sort((a, b) => parsePostedAtMs(b.posted_at) - parsePostedAtMs(a.posted_at));

    if (params.source === 'news') return sortedNews.slice(0, params.limit);
    if (params.source === 'tweets') return sortedX.slice(0, params.limit);

    const xItems = sortedX.slice(0, Math.min(params.tweetReserve, params.limit));
    const newsItems = sortedNews.slice(0, params.limit - xItems.length);
    return [...xItems, ...newsItems].slice(0, params.limit);
}
