import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import {
    collectPaginatedFeedPages,
    getCoinGeckoNewsPageCount,
    getEffectiveTweetReserve,
    parseFeedSource,
    selectFeedArticles,
    type FeedArticle,
} from './_feed-helpers';

function article(overrides: Partial<FeedArticle> & Pick<FeedArticle, 'title' | 'feed_source' | 'posted_at'>): FeedArticle {
    return {
        title: overrides.title,
        url: overrides.url ?? `https://example.com/${encodeURIComponent(overrides.title)}`,
        image: '',
        author: overrides.author ?? 'author',
        posted_at: overrides.posted_at,
        type: 'news',
        source_name: overrides.source_name ?? (overrides.feed_source === 'x' ? '@tokens' : 'CoinGecko'),
        related_coin_ids: overrides.related_coin_ids ?? [],
        feed_source: overrides.feed_source,
    };
}

describe('news feed source parsing', () => {
    it('defaults to all for empty or invalid values', () => {
        expect(parseFeedSource(null)).toBe('all');
        expect(parseFeedSource('')).toBe('all');
        expect(parseFeedSource('unknown')).toBe('all');
    });

    it('accepts supported sources', () => {
        expect(parseFeedSource('all')).toBe('all');
        expect(parseFeedSource('news')).toBe('news');
        expect(parseFeedSource('tweets')).toBe('tweets');
        expect(parseFeedSource(' NEWS ')).toBe('news');
    });
});

describe('news feed tweet reserve', () => {
    it('uses source-specific effective reserves', () => {
        expect(getEffectiveTweetReserve({ source: 'all', limit: 50, requestedTweetReserve: 3 })).toBe(3);
        expect(getEffectiveTweetReserve({ source: 'news', limit: 50, requestedTweetReserve: 3 })).toBe(0);
        expect(getEffectiveTweetReserve({ source: 'tweets', limit: 50, requestedTweetReserve: 3 })).toBe(50);
    });
});

describe('CoinGecko news pagination', () => {
    it('calculates page counts for 15, 25, and 50 item pulls', () => {
        expect(getCoinGeckoNewsPageCount({ requestedCount: 15, perPage: 20, maxPages: 20 })).toBe(1);
        expect(getCoinGeckoNewsPageCount({ requestedCount: 25, perPage: 20, maxPages: 20 })).toBe(2);
        expect(getCoinGeckoNewsPageCount({ requestedCount: 50, perPage: 20, maxPages: 20 })).toBe(3);
    });

    it('keeps earlier pages when a later page fails', async () => {
        const errors: Array<{ page: number; collectedCount: number }> = [];
        const collected = await Effect.runPromise(
            collectPaginatedFeedPages({
                pageCount: 3,
                requestedCount: 50,
                fetchPage: page =>
                    page === 2 ? Effect.fail(new Error('rate limited')) : Effect.succeed([`page-${page}-item`]),
                mapPageItems: items => items,
                onPageError: (_error, context) => errors.push(context),
            }),
        );

        expect(collected.length).toBe(1);
        expect(collected[0]).toBe('page-1-item');
        expect(errors.length).toBe(1);
        expect(errors[0]?.page).toBe(2);
        expect(errors[0]?.collectedCount).toBe(1);
    });
});

describe('selectFeedArticles', () => {
    const newsArticles = Array.from({ length: 60 }, (_, index) =>
        article({
            title: `news-${index}`,
            feed_source: 'coingecko',
            posted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }),
    );
    const xArticles = Array.from({ length: 60 }, (_, index) =>
        article({
            title: `tweet-${index}`,
            feed_source: 'x',
            posted_at: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
        }),
    );

    it('returns only news for source=news', () => {
        const selected = selectFeedArticles({
            newsArticles,
            xArticles,
            limit: 50,
            source: 'news',
            tweetReserve: 0,
        });

        expect(selected.length).toBe(50);
        expect(selected.every(item => item.feed_source === 'coingecko')).toBe(true);
    });

    it('returns only tweets for source=tweets', () => {
        const selected = selectFeedArticles({
            newsArticles,
            xArticles,
            limit: 50,
            source: 'tweets',
            tweetReserve: 50,
        });

        expect(selected.length).toBe(50);
        expect(selected.every(item => item.feed_source === 'x')).toBe(true);
    });

    it('reserves tweets and fills the rest with news for source=all', () => {
        const selected = selectFeedArticles({
            newsArticles,
            xArticles,
            limit: 10,
            source: 'all',
            tweetReserve: 3,
        });

        expect(selected.length).toBe(10);
        expect(selected.slice(0, 3).every(item => item.feed_source === 'x')).toBe(true);
        expect(selected.slice(3).every(item => item.feed_source === 'coingecko')).toBe(true);
    });

    it('retains X results when CoinGecko has no candidates', () => {
        const selected = selectFeedArticles({
            newsArticles: [],
            xArticles,
            limit: 10,
            source: 'all',
            tweetReserve: 3,
        });

        expect(selected.length).toBe(3);
        expect(selected.every(item => item.feed_source === 'x')).toBe(true);
    });

    it('removes unsafe URLs and never exceeds the limit', () => {
        const selected = selectFeedArticles({
            newsArticles: [
                article({
                    title: 'unsafe',
                    feed_source: 'coingecko',
                    posted_at: '2026-01-01T00:00:00.000Z',
                    url: 'javascript:bad',
                }),
                ...newsArticles,
            ],
            xArticles: [],
            limit: 50,
            source: 'news',
            tweetReserve: 0,
        });

        expect(selected.length).toBe(50);
        expect(selected.some(item => item.title === 'unsafe')).toBe(false);
    });
});
