import { Effect } from 'effect';

import { fetchJsonWithRetry, tapErrorAndDefault } from '@tokens/effect';
import { route } from '@/effect/next-route';
import { createCoinGeckoNewsNotFoundRecovery, validateCoinGeckoNewsCoinId } from '@/lib/coingecko-news';
import { resolveXBearerToken, runXRequest } from '@/lib/x-auth';
import { restoreXCashtagsInTexts } from '@/lib/x-cashtags';
import { buildMediaByKey, getPostImage, type XMedia, type XPostMediaAttachment } from '@/lib/x-media';
import {
    articleMatchesTerms,
    collectPaginatedFeedPages,
    getCoinGeckoNewsPageCount,
    getEffectiveTweetReserve,
    parseBoundedInt,
    parseFeedSource,
    selectFeedArticles,
    type FeedArticle,
} from './_feed-helpers';

interface CoinGeckoNewsArticle {
    title: string;
    url: string;
    image: string;
    author: string;
    posted_at: string;
    type: 'news' | 'guide';
    source_name: string;
    related_coin_ids: string[];
}

type CoinGeckoNewsResponse = CoinGeckoNewsArticle[];

interface XUser {
    id: string;
    name: string;
    username: string;
    profile_image_url?: string;
}

interface XUserLookupResponse {
    data?: XUser;
}

interface XPost {
    id: string;
    text: string;
    created_at?: string;
    attachments?: XPostMediaAttachment;
    in_reply_to_user_id?: string;
    referenced_tweets?: { type: string; id: string }[];
}

// The X API's `exclude=replies` param is not always honored, so filter defensively:
// replies don't read as cleanly as standalone posts in the feed.
function isReplyPost(post: XPost): boolean {
    if (post.in_reply_to_user_id) return true;
    return post.referenced_tweets?.some(reference => reference.type === 'replied_to') ?? false;
}

interface XUserPostsResponse {
    data?: XPost[];
    includes?: {
        media?: XMedia[];
    };
}

const X_USERNAME = 'tokens';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_TWEET_RESERVE = 3;
const MAX_X_RESULTS = 100;
const MAX_COINGECKO_NEWS_PER_PAGE = 20;
const MAX_COINGECKO_NEWS_PAGES = 20;

function parseTerms(url: URL): string[] {
    const values = [
        ...url.searchParams.getAll('term'),
        ...(url.searchParams.get('terms') ?? '').split(','),
        url.searchParams.get('name') ?? '',
        url.searchParams.get('symbol') ?? '',
        url.searchParams.get('asset_id') ?? '',
        url.searchParams.get('coin_id') ?? '',
    ];

    const seen = new Set<string>();
    const terms: string[] = [];
    for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(value);
    }
    return terms;
}

function parsePostedAtMs(value: string): number {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
}

function cleanPostText(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function buildXPostUrl(username: string, postId: string): string {
    return `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(postId)}`;
}

function mapCoinGeckoNewsArticle(article: CoinGeckoNewsArticle): FeedArticle {
    return {
        title: article.title,
        url: article.url,
        image: article.image,
        author: article.author,
        posted_at: article.posted_at,
        type: 'news' as const,
        source_name: article.source_name,
        related_coin_ids: article.related_coin_ids,
        feed_source: 'coingecko' as const,
    };
}

async function fetchCoinGeckoNews(coinId: string, requestedCount: number): Promise<FeedArticle[]> {
    if (requestedCount <= 0) return [];

    const validation = await Effect.runPromise(validateCoinGeckoNewsCoinId(coinId));
    if (!validation.shouldFetch) return [];

    const apiKey = process.env.COINGECKO_API_KEY?.trim();
    if (!apiKey) return [];

    const recoverCoinNotFound = createCoinGeckoNewsNotFoundRecovery<CoinGeckoNewsResponse>([]);

    const pageCount = getCoinGeckoNewsPageCount({
        requestedCount,
        perPage: MAX_COINGECKO_NEWS_PER_PAGE,
        maxPages: MAX_COINGECKO_NEWS_PAGES,
    });
    const allArticles = await collectPaginatedFeedPages<CoinGeckoNewsArticle, FeedArticle>({
        pageCount,
        requestedCount,
        fetchPage: async page => {
            const upstreamUrl = new URL('https://pro-api.coingecko.com/api/v3/news');
            upstreamUrl.searchParams.set('page', String(page));
            upstreamUrl.searchParams.set('per_page', String(MAX_COINGECKO_NEWS_PER_PAGE));
            upstreamUrl.searchParams.set('language', 'en');
            upstreamUrl.searchParams.set('type', 'news');
            if (coinId) upstreamUrl.searchParams.set('coin_id', coinId);

            return Effect.runPromise(
                fetchJsonWithRetry<CoinGeckoNewsResponse>({
                    url: upstreamUrl.toString(),
                    service: 'coingecko',
                    init: {
                        headers: {
                            Accept: 'application/json',
                            'x-cg-pro-api-key': apiKey,
                        },
                        next: { revalidate: 60 },
                    },
                    maxRetries: 2,
                    recoverHttpError: recoverCoinNotFound,
                }),
            );
        },
        mapPageItems: articles => articles.filter(item => item && item.type === 'news').map(mapCoinGeckoNewsArticle),
        onPageError: (error, context) => {
            console.warn('CoinGecko news page failed; returning partial news feed', {
                coinId: coinId || undefined,
                page: context.page,
                collected: context.collectedCount,
                requestedCount,
                error,
            });
        },
    });

    return allArticles
        .sort((a, b) => parsePostedAtMs(b.posted_at) - parsePostedAtMs(a.posted_at))
        .slice(0, requestedCount);
}

function emptyFeedArticlesEffect() {
    return Effect.succeed([] as FeedArticle[]);
}

function fetchCoinGeckoNewsEffect(coinId: string, requestedCount: number) {
    return Effect.tryPromise(() => fetchCoinGeckoNews(coinId, requestedCount)).pipe(
        tapErrorAndDefault('v1.newsFeed.coingecko', [] as FeedArticle[], { coinId }),
    );
}

function fetchTokensFeedEffect(limit: number) {
    return Effect.tryPromise(() => fetchTokensFeed(limit)).pipe(
        tapErrorAndDefault('v1.newsFeed.x', [] as FeedArticle[]),
    );
}

function getCandidateFetchCounts(params: { limit: number; tweetReserve: number; source: 'all' | 'news' | 'tweets' }) {
    return {
        coingecko: params.source === 'tweets' ? 0 : params.limit,
        x: params.source === 'news' ? 0 : Math.max(params.limit, params.tweetReserve, DEFAULT_LIMIT),
    };
}

async function fetchTokensFeed(limit: number): Promise<FeedArticle[]> {
    const bearerToken = await Effect.runPromise(resolveXBearerToken());
    if (!bearerToken) return [];

    const authHeaders = {
        Accept: 'application/json',
        Authorization: `Bearer ${bearerToken}`,
    };

    const userUrl = new URL(`https://api.x.com/2/users/by/username/${X_USERNAME}`);
    userUrl.searchParams.set('user.fields', 'id,name,username,profile_image_url');

    const userResponse = await Effect.runPromise(runXRequest(fetchJsonWithRetry<XUserLookupResponse>({
        url: userUrl.toString(),
        service: 'x',
        init: {
            headers: authHeaders,
            next: { revalidate: 60 },
        },
        maxRetries: 2,
    })));

    const user = userResponse.data;
    if (!user?.id) return [];

    const postsUrl = new URL(`https://api.x.com/2/users/${user.id}/tweets`);
    postsUrl.searchParams.set('max_results', String(Math.min(Math.max(limit, 5), MAX_X_RESULTS)));
    postsUrl.searchParams.set('exclude', 'retweets,replies');
    postsUrl.searchParams.set('tweet.fields', 'attachments,created_at,text,in_reply_to_user_id,referenced_tweets');
    postsUrl.searchParams.set('expansions', 'attachments.media_keys');
    postsUrl.searchParams.set('media.fields', 'media_key,preview_image_url,type,url');

    const postsResponse = await Effect.runPromise(runXRequest(fetchJsonWithRetry<XUserPostsResponse>({
        url: postsUrl.toString(),
        service: 'x',
        init: {
            headers: authHeaders,
            next: { revalidate: 60 },
        },
        maxRetries: 2,
    })));
    const mediaByKey = buildMediaByKey(postsResponse.includes?.media);

    const posts = (postsResponse.data ?? []).filter(
        post => post.id && post.text && post.created_at && !isReplyPost(post),
    );
    // X's token tags arrive as `solana:<mint>` in the API text; restore them to `$SYMBOL` so
    // posts read like they do on x.com (and so `$SYMBOL` term matching sees them).
    const titles = await Effect.runPromise(restoreXCashtagsInTexts(posts.map(post => cleanPostText(post.text))));

    return posts
        .map((post, index) => ({
            title: titles[index] ?? cleanPostText(post.text),
            url: buildXPostUrl(user.username, post.id),
            image: getPostImage(post, mediaByKey, user.profile_image_url),
            author: user.username,
            posted_at: post.created_at ?? '',
            type: 'news' as const,
            source_name: `@${user.username}`,
            related_coin_ids: [],
            feed_source: 'x' as const,
        }))
        .sort((a, b) => parsePostedAtMs(b.posted_at) - parsePostedAtMs(a.posted_at));
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const limit = parseBoundedInt(url.searchParams.get('limit'), {
                defaultValue: DEFAULT_LIMIT,
                min: 1,
                max: MAX_LIMIT,
            });
            const requestedTweetReserve = parseBoundedInt(url.searchParams.get('tweet_reserve'), {
                defaultValue: DEFAULT_TWEET_RESERVE,
                min: 0,
                max: limit,
            });
            const source = parseFeedSource(url.searchParams.get('source'));
            const tweetReserve = getEffectiveTweetReserve({ source, limit, requestedTweetReserve });
            const coinId = (url.searchParams.get('coin_id') ?? '').trim();
            const terms = parseTerms(url);
            const mode = coinId || terms.length > 0 ? 'token' : 'global';
            const candidateFetchCounts = getCandidateFetchCounts({ limit, tweetReserve, source });

            const [newsArticles, rawXArticles] = yield* Effect.all(
                [
                    candidateFetchCounts.coingecko > 0
                        ? fetchCoinGeckoNewsEffect(coinId, candidateFetchCounts.coingecko)
                        : emptyFeedArticlesEffect(),
                    candidateFetchCounts.x > 0 ? fetchTokensFeedEffect(candidateFetchCounts.x) : emptyFeedArticlesEffect(),
                ],
                { concurrency: 'unbounded' },
            );

            const xArticles = mode === 'token' ? rawXArticles.filter(article => articleMatchesTerms(article, terms)) : rawXArticles;
            const items = selectFeedArticles({ newsArticles, xArticles, limit, source, tweetReserve });

            return {
                items,
                meta: {
                    mode,
                    source,
                    coin_id: coinId || null,
                    terms,
                    limit,
                    tweet_reserve: tweetReserve,
                    counts: {
                        items: items.length,
                        coingecko_candidates: newsArticles.length,
                        x_candidates: xArticles.length,
                    },
                },
            };
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
