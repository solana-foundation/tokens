import { describe, expect, test } from 'bun:test';

import {
    PYTH_FEED_BATCH_MAX_ITEMS,
    buildLiveQuoteKey,
    parsePythFeedBatchBody,
    pythFeedResolutionKey,
} from './pyth-feed-batch';

describe('parsePythFeedBatchBody', () => {
    test('normalizes, dedupes and drops malformed items', () => {
        const items = parsePythFeedBatchBody({
            items: [
                { symbol: ' sol ', category: 'Crypto' },
                { symbol: 'SOL', category: 'crypto', mode: 'canonical' },
                { symbol: 'TSLAx', category: 'equity', mode: 'variant' },
                { symbol: 'a b', category: 'crypto' },
                { symbol: 42 },
                null,
                'SOL',
            ],
        });
        expect(items).toEqual([
            { ticker: 'SOL', category: 'crypto', mode: 'canonical' },
            { ticker: 'TSLAX', category: 'equity', mode: 'variant' },
        ]);
    });

    test('caps the batch and tolerates junk bodies', () => {
        const many = { items: Array.from({ length: 500 }, (_, i) => ({ symbol: `T${i}`, category: 'crypto' })) };
        expect(parsePythFeedBatchBody(many)).toHaveLength(PYTH_FEED_BATCH_MAX_ITEMS);
        expect(parsePythFeedBatchBody(null)).toEqual([]);
        expect(parsePythFeedBatchBody({ items: 'SOL' })).toEqual([]);
    });
});

describe('keys', () => {
    test('resolution key is mode:category:TICKER', () => {
        expect(pythFeedResolutionKey({ ticker: 'sol', category: 'Crypto', mode: 'canonical' })).toBe(
            'canonical:crypto:SOL',
        );
        expect(pythFeedResolutionKey({ ticker: 'TSLAx', category: null, mode: 'variant' })).toBe('variant::TSLAX');
    });

    test('live quote key mirrors the asset page: coingeckoId, then assetId, then address', () => {
        expect(buildLiveQuoteKey({ coingeckoId: 'solana', assetId: 'solana', address: 'So11' })).toBe('solana');
        expect(buildLiveQuoteKey({ assetId: 'nvidia', address: 'Xsc9' })).toBe('nvidia');
        expect(buildLiveQuoteKey({ address: 'Xsc9' })).toBe('Xsc9');
        expect(buildLiveQuoteKey({})).toBe('');
    });
});

describe('resolveRetryDelayMs', () => {
    test('doubles from five seconds and caps at a minute', async () => {
        const { resolveRetryDelayMs } = await import('./pyth-feed-resolver');
        expect([0, 1, 2, 3, 4, 9].map(resolveRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    });
});
