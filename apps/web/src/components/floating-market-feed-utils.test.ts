import { describe, expect, it } from 'bun:test';

import {
    DEFAULT_FLOATING_MARKET_FEED_SETTINGS,
    getFloatingMarketFeedSource,
    getNextFloatingMarketFeedSize,
    getNextHeatmapSector,
    isFloatingMarketFeedSize,
    resolveNextFloatingMarketFeedSettings,
    sanitizeFloatingMarketFeedSettings,
} from './floating-market-feed-utils';

describe('floating market feed settings', () => {
    it('sanitizes invalid persisted settings to defaults', () => {
        expect(JSON.stringify(sanitizeFloatingMarketFeedSettings(null))).toBe(
            JSON.stringify(DEFAULT_FLOATING_MARKET_FEED_SETTINGS),
        );
        expect(
            JSON.stringify(sanitizeFloatingMarketFeedSettings({ feedSize: 100, showNews: false, showTweets: false })),
        ).toBe(JSON.stringify(DEFAULT_FLOATING_MARKET_FEED_SETTINGS));
    });

    it('defaults to 25 pulled items', () => {
        expect(DEFAULT_FLOATING_MARKET_FEED_SETTINGS.feedSize).toBe(25);
    });

    it('defaults to the @tokens feed only', () => {
        expect(DEFAULT_FLOATING_MARKET_FEED_SETTINGS.showNews).toBe(false);
        expect(DEFAULT_FLOATING_MARKET_FEED_SETTINGS.showTweets).toBe(true);
        expect(getFloatingMarketFeedSource(DEFAULT_FLOATING_MARKET_FEED_SETTINGS)).toBe('tweets');
    });

    it('accepts only 15, 25, and 50 as feed sizes', () => {
        expect(isFloatingMarketFeedSize(15)).toBe(true);
        expect(isFloatingMarketFeedSize(25)).toBe(true);
        expect(isFloatingMarketFeedSize(50)).toBe(true);
        expect(isFloatingMarketFeedSize(10)).toBe(false);
        expect(isFloatingMarketFeedSize(20)).toBe(false);
    });

    it('cycles feed sizes in display order', () => {
        expect(getNextFloatingMarketFeedSize(15)).toBe(25);
        expect(getNextFloatingMarketFeedSize(25)).toBe(50);
        expect(getNextFloatingMarketFeedSize(50)).toBe(15);
    });

    it('turning off the last enabled source flips to the other source', () => {
        expect(
            JSON.stringify(
                resolveNextFloatingMarketFeedSettings(
                    {
                        feedSize: 25,
                        showNews: true,
                        showTweets: false,
                        heatmapSector: 'stocks',
                    },
                    { showNews: false },
                ),
            ),
        ).toBe(
            JSON.stringify({
                feedSize: 25,
                showNews: false,
                showTweets: true,
                heatmapSector: 'stocks',
            }),
        );

        expect(
            JSON.stringify(
                resolveNextFloatingMarketFeedSettings(
                    {
                        feedSize: 25,
                        showNews: false,
                        showTweets: true,
                        heatmapSector: 'stocks',
                    },
                    { showTweets: false },
                ),
            ),
        ).toBe(
            JSON.stringify({
                feedSize: 25,
                showNews: true,
                showTweets: false,
                heatmapSector: 'stocks',
            }),
        );
    });

    it('maps settings to API source values', () => {
        expect(
            getFloatingMarketFeedSource({ feedSize: 25, showNews: true, showTweets: true, heatmapSector: 'stocks' }),
        ).toBe('all');
        expect(
            getFloatingMarketFeedSource({ feedSize: 25, showNews: true, showTweets: false, heatmapSector: 'stocks' }),
        ).toBe('news');
        expect(
            getFloatingMarketFeedSource({ feedSize: 25, showNews: false, showTweets: true, heatmapSector: 'stocks' }),
        ).toBe('tweets');
    });
});

describe('floating market feed heat map category', () => {
    it('defaults to Stocks and keeps a valid persisted category', () => {
        expect(DEFAULT_FLOATING_MARKET_FEED_SETTINGS.heatmapSector).toBe('stocks');
        expect(sanitizeFloatingMarketFeedSettings({ showTweets: true, heatmapSector: 'majors' }).heatmapSector).toBe(
            'majors',
        );
    });

    it('rejects malformed categories', () => {
        for (const heatmapSector of [42, '', 'Stocks', '../etc', 'x'.repeat(41)]) {
            expect(sanitizeFloatingMarketFeedSettings({ showTweets: true, heatmapSector }).heatmapSector).toBe(
                'stocks',
            );
        }
    });

    it('keeps the category when the sources fall back to defaults', () => {
        expect(
            sanitizeFloatingMarketFeedSettings({ showNews: false, showTweets: false, heatmapSector: 'etfs' })
                .heatmapSector,
        ).toBe('etfs');
    });

    it('cycles through the available categories and wraps', () => {
        const available = ['majors', 'currencies', 'stocks'];
        expect(getNextHeatmapSector('majors', available)).toBe('currencies');
        expect(getNextHeatmapSector('stocks', available)).toBe('majors');
        // A category that disappeared restarts the cycle.
        expect(getNextHeatmapSector('rwas', available)).toBe('majors');
        expect(getNextHeatmapSector('stocks', [])).toBe('stocks');
    });
});
