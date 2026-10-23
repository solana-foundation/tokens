import { describe, expect, test } from 'bun:test';

import { assessMarkets, weightedMedian, type MarketQualityInput } from './_market-quality';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(key: string, overrides: Partial<MarketQualityInput> = {}): MarketQualityInput {
    return {
        key,
        chain: 'solana',
        price: 100,
        liquidity: 50_000,
        volume24hUSD: 20_000,
        lastFetchedAt: NOW - 5 * 60 * 1000,
        ...overrides,
    };
}

describe('assessMarkets', () => {
    test('a healthy row is included with no reasons', () => {
        const out = assessMarkets([row('a')], { priceUsd: 100 }, NOW);
        expect(out.get('a')).toEqual({ included: true, reasons: [] });
    });

    test('a 114-day-old row is stale; EVM gets a longer threshold than Solana', () => {
        const out = assessMarkets(
            [
                row('old', { lastFetchedAt: NOW - 114 * DAY }),
                row('sol', { lastFetchedAt: NOW - 2.5 * HOUR }),
                row('eth', { chain: 'ethereum', lastFetchedAt: NOW - 2.5 * HOUR }),
                row('fresh'),
            ],
            null,
            NOW,
        );
        expect(out.get('old')?.reasons).toEqual(['stale']);
        expect(out.get('sol')?.reasons).toEqual(['stale']);
        expect(out.get('eth')?.included).toBe(true);
        expect(out.get('fresh')?.included).toBe(true);
    });

    test('an $11-liquidity, no-volume row is dust and its $15,192 price never enters the pool', () => {
        const out = assessMarkets(
            [row('tesla-arb', { chain: 'arbitrum', price: 15_192, liquidity: 11, volume24hUSD: 40 }), row('tesla-sol', { price: 386 })],
            { priceUsd: 386 },
            NOW,
        );
        expect(out.get('tesla-arb')?.included).toBe(false);
        expect(out.get('tesla-arb')?.reasons).toContain('dust');
        expect(out.get('tesla-sol')?.included).toBe(true);
    });

    test('with a reference, a priced row more than 25% off it is an outlier even with liquidity (CRWDx)', () => {
        const out = assessMarkets(
            [row('crwdx', { price: 13_513, liquidity: 92_000, volume24hUSD: 0 }), row('other', { price: 240 })],
            { priceUsd: 238 },
            NOW,
        );
        expect(out.get('crwdx')).toEqual({ included: false, reasons: ['price_outlier'] });
        expect(out.get('other')?.included).toBe(true);
    });

    test('without a reference the liquidity-weighted median anchors: 21BTC at half price is dropped', () => {
        const out = assessMarkets(
            [
                row('wbtc', { price: 81_600, liquidity: 9_000_000 }),
                row('cbbtc', { price: 81_400, liquidity: 4_000_000 }),
                row('21btc', { price: 41_767, liquidity: 60_000 }),
            ],
            null,
            NOW,
        );
        expect(out.get('wbtc')?.included).toBe(true);
        expect(out.get('cbbtc')?.included).toBe(true);
        expect(out.get('21btc')?.reasons).toEqual(['price_outlier']);
    });

    test('a lone priced row passes without a reference; a lone dust row is kept when nothing else survives', () => {
        expect(assessMarkets([row('only', { price: 5 })], null, NOW).get('only')?.included).toBe(true);
        const thin = assessMarkets([row('thin', { liquidity: 400, volume24hUSD: 10 })], null, NOW);
        expect(thin.get('thin')).toEqual({ included: true, reasons: [] });
        // …but not when a real row exists.
        const mixed = assessMarkets([row('thin', { liquidity: 400, volume24hUSD: 10 }), row('real')], null, NOW);
        expect(mixed.get('thin')?.reasons).toEqual(['dust']);
        // …and never when it is also stale.
        const dead = assessMarkets([row('dead', { liquidity: 1, volume24hUSD: 0, lastFetchedAt: NOW - DAY })], null, NOW);
        expect(dead.get('dead')?.included).toBe(false);
    });

    test('rows without a price are never outliers, and a null fetch time is never stale', () => {
        const out = assessMarkets([row('nop', { price: null, lastFetchedAt: null }), row('ref', { price: 100 })], { priceUsd: 100 }, NOW);
        expect(out.get('nop')?.included).toBe(true);
    });

    test('a zero or missing reference falls back to the median rule', () => {
        const out = assessMarkets([row('a', { price: 100, liquidity: 10 ** 6 }), row('b', { price: 300, liquidity: 10 })], { priceUsd: 0 }, NOW);
        expect(out.get('b')?.reasons).toEqual(['price_outlier']);
    });
});

describe('weightedMedian', () => {
    test('picks the value at half the cumulative weight, lower value on ties', () => {
        expect(weightedMedian([{ value: 1, weight: 1 }, { value: 100, weight: 1 }])).toBe(1);
        expect(weightedMedian([{ value: 1, weight: 1 }, { value: 100, weight: 10 }])).toBe(100);
        expect(weightedMedian([{ value: 5, weight: 0 }])).toBeNull();
        expect(weightedMedian([])).toBeNull();
    });
});
