import { afterEach, describe, expect, it } from 'bun:test';
import type { CanonicalAsset } from '@tokens/asset-registry';

import { __setAdvisoriesForTests } from '@/lib/advisories';

import {
    aggregateTokenStats,
    computeCompanyMarketCapUsd,
    computePreStocksDerived,
    isCanonicalPublicEquityAsset,
    parsePrimaryVariantStrategy,
    parseStockVariantTier,
    parseVariantSortBy,
    pickPrimaryVariant,
    selectCanonicalAssetStats,
    type TokenMarketSnapshot,
    variantMatchesFilters,
    withDerivedVariantTier,
} from './_asset-helpers';

function makeToken(address: string, overrides: Partial<TokenMarketSnapshot>): TokenMarketSnapshot {
    return {
        address,
        source: 'birdeye',
        metricsSource: 'birdeye',
        symbol: null,
        name: null,
        decimals: 6,
        logoURI: null,
        liquidity: null,
        volume24hUSD: null,
        trade1h: null,
        trade24h: null,
        uniqueWallet1h: null,
        uniqueWallet24h: null,
        price: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        marketCap: null,
        fdv: null,
        holder: null,
        totalSupply: null,
        circulatingSupply: null,
        ...overrides,
    };
}

function makeAsset(mints: string[]): CanonicalAsset {
    return {
        assetId: 'example-stock',
        name: 'Example Stock',
        symbol: 'EXM',
        category: 'equity',
        variants: mints.map(mint => ({
            mint,
            kind: 'tokenized_equity' as const,
        })),
    } as CanonicalAsset;
}

describe('primary variant strategy parsing', () => {
    it('defaults to liquidity', () => {
        expect(parsePrimaryVariantStrategy(null)).toBe('liquidity');
        expect(parsePrimaryVariantStrategy('')).toBe('liquidity');
        expect(parsePrimaryVariantStrategy('liquidity')).toBe('liquidity');
        expect(parsePrimaryVariantStrategy('unknown')).toBe('liquidity');
    });

    it('accepts execution_quality', () => {
        expect(parsePrimaryVariantStrategy('execution_quality')).toBe('execution_quality');
    });

    it('accepts stock_redeemability', () => {
        expect(parsePrimaryVariantStrategy('stock_redeemability')).toBe('stock_redeemability');
    });
});

describe('variant sort parsing', () => {
    it('defaults to liquidity', () => {
        expect(parseVariantSortBy(null)).toBe('liquidity');
        expect(parseVariantSortBy('')).toBe('liquidity');
        expect(parseVariantSortBy('liquidity')).toBe('liquidity');
        expect(parseVariantSortBy('unknown')).toBe('liquidity');
    });

    it('accepts execution_quality', () => {
        expect(parseVariantSortBy('execution_quality')).toBe('execution_quality');
    });

    it('accepts stock_redeemability', () => {
        expect(parseVariantSortBy('stock_redeemability')).toBe('stock_redeemability');
    });
});

describe('stock variant tier parsing', () => {
    it('accepts supported stock tiers', () => {
        expect(parseStockVariantTier('share_redeemable')).toBe('share_redeemable');
        expect(parseStockVariantTier('cash_redeemable')).toBe('cash_redeemable');
        expect(parseStockVariantTier('not_redeemable')).toBe('not_redeemable');
    });

    it('rejects unsupported or empty stock tiers', () => {
        expect(parseStockVariantTier(null)).toBe(null);
        expect(parseStockVariantTier('')).toBe(null);
        expect(parseStockVariantTier('unknown')).toBe(null);
    });
});

describe('canonical public equity detection', () => {
    it('classifies public equity assets with stock symbols', () => {
        expect(
            isCanonicalPublicEquityAsset({
                assetId: 'micron',
                name: 'Micron Technology',
                symbol: 'MU',
                category: 'equity',
                aliases: ['xstock-micron', 'micron-xstock', 'Backpack Securities'],
            }),
        ).toBe(true);
    });

    it('rejects private and pre-stock equity assets', () => {
        expect(
            isCanonicalPublicEquityAsset({
                assetId: 'pre-abcdef12',
                name: 'Example PreStocks',
                symbol: 'EXAMPLE.PRE',
                category: 'equity',
                aliases: ['pre-ipo'],
            }),
        ).toBe(false);
    });
});

describe('variant filter matching', () => {
    it('filters by stock variant tier', () => {
        const shareRedeemable = {
            kind: 'tokenized_equity' as const,
            liquidityTier: 'tier2' as const,
            stockVariantTier: 'share_redeemable' as const,
        };
        const cashRedeemable = {
            kind: 'tokenized_equity' as const,
            liquidityTier: 'tier1' as const,
            stockVariantTier: 'cash_redeemable' as const,
        };

        expect(
            variantMatchesFilters(shareRedeemable, {
                stockVariantTier: 'share_redeemable',
            }),
        ).toBe(true);
        expect(
            variantMatchesFilters(cashRedeemable, {
                stockVariantTier: 'share_redeemable',
            }),
        ).toBe(false);
    });

    it('combines kind, liquidity tier, and stock tier filters', () => {
        const variant = {
            kind: 'tokenized_equity' as const,
            liquidityTier: 'tier2' as const,
            stockVariantTier: 'share_redeemable' as const,
        };

        expect(
            variantMatchesFilters(variant, {
                kind: 'tokenized_equity',
                liquidityTier: 'tier2',
                stockVariantTier: 'share_redeemable',
            }),
        ).toBe(true);
        expect(
            variantMatchesFilters(variant, {
                kind: 'tokenized_equity',
                liquidityTier: 'tier1',
                stockVariantTier: 'share_redeemable',
            }),
        ).toBe(false);
    });
});

describe('aggregate token stats', () => {
    it('liquidity-weights price and price changes across variants', () => {
        const primary = makeToken('primary', {
            price: 100,
            liquidity: 10,
            volume24hUSD: 100,
            priceChange24hPercent: 10,
            priceChange1hPercent: 1,
            marketCap: 1000,
            fdv: 1100,
            totalSupply: 10,
            circulatingSupply: 9,
        });
        const secondary = makeToken('secondary', {
            price: 200,
            liquidity: 30,
            volume24hUSD: 100,
            priceChange24hPercent: -10,
            priceChange1hPercent: 3,
            marketCap: 2000,
            fdv: 2100,
            totalSupply: 20,
            circulatingSupply: 18,
        });
        const stats = aggregateTokenStats(
            makeAsset(['primary', 'secondary']),
            new Map([
                ['primary', primary],
                ['secondary', secondary],
            ]),
            primary,
        );

        expect(stats?.price).toBe(175);
        expect(stats?.priceChange24hPercent).toBe(-5);
        expect(stats?.priceChange1hPercent).toBe(2.5);
        expect(stats?.marketCap).toBe(3000);
        expect(stats?.fdv).toBe(3200);
        expect(stats?.totalSupply).toBe(30);
        expect(stats?.circulatingSupply).toBe(27);
    });

    it('ignores zero-liquidity price outliers when liquidity weights are available', () => {
        const primary = makeToken('primary', {
            price: 100,
            liquidity: 100,
            volume24hUSD: 100,
            priceChange24hPercent: 5,
        });
        const outlier = makeToken('outlier', {
            price: 10000,
            liquidity: 0,
            volume24hUSD: 1_000_000,
            priceChange24hPercent: 500,
        });
        const stats = aggregateTokenStats(
            makeAsset(['primary', 'outlier']),
            new Map([
                ['primary', primary],
                ['outlier', outlier],
            ]),
            primary,
        );

        expect(stats?.price).toBe(100);
        expect(stats?.priceChange24hPercent).toBe(5);
    });

    it('falls back to volume-weighted price when no variants have liquidity', () => {
        const primary = makeToken('primary', {
            price: 100,
            liquidity: 0,
            volume24hUSD: 100,
        });
        const secondary = makeToken('secondary', {
            price: 200,
            liquidity: 0,
            volume24hUSD: 300,
        });
        const stats = aggregateTokenStats(
            makeAsset(['primary', 'secondary']),
            new Map([
                ['primary', primary],
                ['secondary', secondary],
            ]),
            primary,
        );

        expect(stats?.price).toBe(175);
    });
});

describe('canonical asset stat selection', () => {
    it('uses CoinGecko fields over stock and aggregate fields when present', () => {
        const selected = selectCanonicalAssetStats({
            coingecko: {
                priceUsd: 100,
                marketCapUsd: 1000,
                volume24hUsd: 250,
                priceChange24hPercent: 5,
            },
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 800,
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
        });

        expect(selected?.price).toBe(100);
        expect(selected?.volume24hUSD).toBe(250);
        expect(selected?.marketCap).toBe(1000);
        expect(selected?.priceChange24hPercent).toBe(5);
        expect(selected?.liquidity).toBe(700);
        expect(selected?.fdv).toBe(900);
    });

    it('falls back field by field when CoinGecko is missing values', () => {
        const selected = selectCanonicalAssetStats({
            coingecko: {
                priceUsd: 100,
                marketCapUsd: null,
                volume24hUsd: null,
                priceChange24hPercent: null,
            },
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 800,
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
        });

        expect(selected?.price).toBe(100);
        expect(selected?.volume24hUSD).toBe(200);
        expect(selected?.marketCap).toBe(800);
        expect(selected?.priceChange24hPercent).toBe(4);
    });

    it('can prefer aggregate 24h volume while keeping canonical price fields', () => {
        const selected = selectCanonicalAssetStats({
            coingecko: {
                priceUsd: 100,
                marketCapUsd: 1000,
                volume24hUsd: 250,
                priceChange24hPercent: 5,
            },
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 800,
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
            preferAggregateVolume24h: true,
        });

        expect(selected?.price).toBe(100);
        expect(selected?.volume24hUSD).toBe(150);
        expect(selected?.marketCap).toBe(1000);
        expect(selected?.priceChange24hPercent).toBe(5);
    });

    it('uses aggregate stats for stock-canonical assets', () => {
        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 800,
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
            preferStockMarket: true,
        });

        expect(selected?.price).toBe(80);
        expect(selected?.volume24hUSD).toBe(150);
        expect(selected?.priceChange24hPercent).toBe(3);
        expect(selected?.priceChange1hPercent).toBe(1);
        expect(selected?.marketCap).toBe(800);
        expect(selected?.fdv).toBe(900);
        expect(selected?.totalSupply).toBe(10000);
        expect(selected?.circulatingSupply).toBe(9000);
        expect(selected?.liquidity).toBe(700);
    });

    it('falls back to the stock benchmark when the on-chain market is dust', () => {
        // Mirrors galaxy-digital: a single ~$10 trade on an empty pool printed
        // ~3x the real GLXY price and a +360% 24h change.
        const dustAggregate = {
            price: 68.98,
            liquidity: 0.52,
            volume24hUSD: 8.38,
            volume30dUSD: null,
            marketCap: 6_608_913,
            fdv: 40_008_995,
            priceChange24hPercent: 359.9,
            priceChange1hPercent: 359.9,
            totalSupply: 580_000,
            circulatingSupply: 95_807,
        };

        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 21.62,
                volume24hUsd: 0,
                priceChange24hPercent: 2.22,
            },
            aggregate: dustAggregate,
            preferStockMarket: true,
            stockPriceMatchesTokenUnits: true,
        });

        expect(selected?.price).toBe(21.62);
        expect(selected?.priceChange24hPercent).toBe(2.22);
        expect(selected?.priceChange1hPercent).toBeNull();
        // On-chain activity figures stay truthful.
        expect(selected?.volume24hUSD).toBe(8.38);
        expect(selected?.liquidity).toBe(0.52);
    });

    it('only falls back percent change for dust markets when stock units differ from token units', () => {
        const dustAggregate = {
            price: 2600,
            liquidity: 5,
            volume24hUSD: 3,
            volume30dUSD: null,
            marketCap: 1_000_000,
            fdv: 1_000_000,
            priceChange24hPercent: 120,
            priceChange1hPercent: 120,
            totalSupply: 400,
            circulatingSupply: 400,
        };

        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 240, // e.g. GLD share price — different units than the per-oz token
                volume24hUsd: 0,
                priceChange24hPercent: 0.8,
            },
            aggregate: dustAggregate,
            preferStockMarket: true,
        });

        expect(selected?.price).toBe(2600);
        expect(selected?.priceChange24hPercent).toBe(0.8);
        expect(selected?.priceChange1hPercent).toBeNull();
    });

    it('keeps on-chain stats for stock-canonical assets with real activity', () => {
        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 21.62,
                volume24hUsd: 0,
                priceChange24hPercent: 2.22,
            },
            aggregate: {
                price: 21.8,
                liquidity: 250_000,
                volume24hUSD: 90_000,
                volume30dUSD: null,
                marketCap: 6_608_913,
                fdv: 40_008_995,
                priceChange24hPercent: 3.1,
                priceChange1hPercent: 0.4,
                totalSupply: 580_000,
                circulatingSupply: 95_807,
            },
            preferStockMarket: true,
            stockPriceMatchesTokenUnits: true,
        });

        expect(selected?.price).toBe(21.8);
        expect(selected?.priceChange24hPercent).toBe(3.1);
        expect(selected?.priceChange1hPercent).toBe(0.4);
    });

    it('prefers the underlying company market cap for stock-canonical assets', () => {
        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
                marketCapUsd: 101_645_383_590, // company mcap: price × shares outstanding
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 18_180_000, // tokenized-supply aggregate
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
            preferStockMarket: true,
        });

        expect(selected?.marketCap).toBe(101_645_383_590);
        // Everything else still comes from the on-chain aggregate.
        expect(selected?.price).toBe(80);
        expect(selected?.volume24hUSD).toBe(150);
    });

    it('falls back to the tokenized aggregate when company market cap is unavailable', () => {
        const selected = selectCanonicalAssetStats({
            stock: {
                priceUsd: 90,
                volume24hUsd: 200,
                priceChange24hPercent: 4,
                marketCapUsd: null,
            },
            aggregate: {
                price: 80,
                liquidity: 700,
                volume24hUSD: 150,
                volume30dUSD: null,
                marketCap: 18_180_000,
                fdv: 900,
                priceChange24hPercent: 3,
                priceChange1hPercent: 1,
                totalSupply: 10000,
                circulatingSupply: 9000,
            },
            preferStockMarket: true,
        });

        expect(selected?.marketCap).toBe(18_180_000);
    });
});

describe('company market cap computation', () => {
    const NOW = 1_785_300_000_000;
    const FRESH = NOW - 60_000;
    const STALE = NOW - 8 * 24 * 60 * 60_000;

    it('multiplies price by shares outstanding for equities', () => {
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: 90, sharesOutstanding: 1_129_393_151, sharesLastFetchedAt: FRESH },
                NOW,
            ),
        ).toBe(90 * 1_129_393_151);
    });

    it('returns null for commodities (ETF proxy share counts are not asset mcap)', () => {
        expect(
            computeCompanyMarketCapUsd(
                { category: 'commodity' },
                { priceUsd: 200, sharesOutstanding: 1_000_000, sharesLastFetchedAt: FRESH },
                NOW,
            ),
        ).toBeNull();
    });

    it('returns null when the stored share count is stale or has no fetch timestamp', () => {
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: 90, sharesOutstanding: 1_129_393_151, sharesLastFetchedAt: STALE },
                NOW,
            ),
        ).toBeNull();
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: 90, sharesOutstanding: 1_129_393_151 },
                NOW,
            ),
        ).toBeNull();
    });

    it('returns null when price or shares are missing or non-positive', () => {
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: 90, sharesOutstanding: null, sharesLastFetchedAt: FRESH },
                NOW,
            ),
        ).toBeNull();
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: null, sharesOutstanding: 100, sharesLastFetchedAt: FRESH },
                NOW,
            ),
        ).toBeNull();
        expect(
            computeCompanyMarketCapUsd(
                { category: 'equity' },
                { priceUsd: 90, sharesOutstanding: 0, sharesLastFetchedAt: FRESH },
                NOW,
            ),
        ).toBeNull();
        expect(computeCompanyMarketCapUsd({ category: 'equity' }, null, NOW)).toBeNull();
    });
});

describe('prestocks derived fields', () => {
    const SNAPSHOT = {
        markPriceUsd: 132.76,
        markValuationUsd: 107_906_188_229,
        tokenPriceUsd: 136.35,
    };

    it('derives premium and implied valuation from the on-chain price', () => {
        const derived = computePreStocksDerived(SNAPSHOT, 174.01);
        expect(derived.basisPriceUsd).toBe(174.01);
        expect(derived.premiumToMarkPercent).toBeCloseTo((174.01 / 132.76 - 1) * 100, 6);
        expect(derived.impliedValuationUsd).toBeCloseTo((107_906_188_229 * 174.01) / 132.76, 0);
    });

    it('reports a discount as a negative premium', () => {
        const derived = computePreStocksDerived(SNAPSHOT, 99.57);
        expect(derived.premiumToMarkPercent).toBeLessThan(0);
    });

    it('falls back to the provider token price when the on-chain price is missing', () => {
        for (const onChain of [null, undefined, 0, -1, Number.NaN]) {
            const derived = computePreStocksDerived(SNAPSHOT, onChain as number | null | undefined);
            expect(derived.basisPriceUsd).toBe(136.35);
            expect(derived.premiumToMarkPercent).toBeCloseTo((136.35 / 132.76 - 1) * 100, 6);
        }
    });

    it('returns nulls when the mark price is missing or non-positive', () => {
        for (const markPriceUsd of [null, 0, -5]) {
            const derived = computePreStocksDerived({ ...SNAPSHOT, markPriceUsd }, 174.01);
            expect(derived.premiumToMarkPercent).toBeNull();
            expect(derived.impliedValuationUsd).toBeNull();
        }
    });

    it('returns a premium but no valuation when the mark valuation is missing', () => {
        const derived = computePreStocksDerived({ ...SNAPSHOT, markValuationUsd: null }, 174.01);
        expect(derived.premiumToMarkPercent).not.toBeNull();
        expect(derived.impliedValuationUsd).toBeNull();
    });

    it('returns all nulls when no usable price exists', () => {
        const derived = computePreStocksDerived({ ...SNAPSHOT, tokenPriceUsd: null }, null);
        expect(derived.basisPriceUsd).toBeNull();
        expect(derived.premiumToMarkPercent).toBeNull();
        expect(derived.impliedValuationUsd).toBeNull();
    });
});

describe('withDerivedVariantTier advisory key', () => {
    it('always emits advisory (null when the input has none)', () => {
        const out = withDerivedVariantTier({ mint: 'm', kind: 'native' as const }, 1_000);
        expect('advisory' in out).toBe(true);
        expect(out.advisory).toBeNull();
        expect(out.liquidityTier).toBeDefined();
    });

    it('passes an existing advisory through', () => {
        const advisory = { status: 'caution' as const, reason: 'Migration', url: null, since: 1 };
        const out = withDerivedVariantTier({ mint: 'm', advisory }, null);
        expect(out.advisory).toEqual(advisory);
    });
});

describe('pickPrimaryVariant advisory exclusion', () => {
    const SILV = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
    const ONDO = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';

    afterEach(() => {
        __setAdvisoriesForTests(null);
    });

    function silver(): CanonicalAsset {
        return {
            assetId: 'silver',
            name: 'Silver',
            symbol: 'XAG',
            category: 'commodity',
            aliases: [],
            variants: [
                { variantId: 'silver:silv', mint: SILV, kind: 'wrapped', trustTier: 'tier2', tags: [] },
                { variantId: 'silver:ondo', mint: ONDO, kind: 'wrapped', trustTier: 'tier2', tags: [] },
            ],
        };
    }

    const tokenByMint = new Map<string, TokenMarketSnapshot>([
        [SILV, makeToken(SILV, { liquidity: 1_070_000, volume24hUSD: 500_000, price: 13.7 })],
        [ONDO, makeToken(ONDO, { liquidity: 6_600, volume24hUSD: 1_000, price: 57.35 })],
    ]);

    it('picks the deepest market when nothing is flagged', () => {
        __setAdvisoriesForTests([]);
        expect(pickPrimaryVariant(silver(), new Map(), tokenByMint)?.mint).toBe(SILV);
    });

    it('honors the sync advisory cache: a compromised mint loses primary despite top liquidity', () => {
        __setAdvisoriesForTests([{ mint: SILV, status: 'compromised', reason: 'Issuer exploited', url: null, since: 1 }]);
        expect(pickPrimaryVariant(silver(), new Map(), tokenByMint)?.mint).toBe(ONDO);
    });

    it('caution does not affect primary selection', () => {
        __setAdvisoriesForTests([{ mint: SILV, status: 'caution', reason: 'Notice', url: null, since: 1 }]);
        expect(pickPrimaryVariant(silver(), new Map(), tokenByMint)?.mint).toBe(SILV);
    });

    it('falls back to the full pool when every variant is flagged (never null)', () => {
        __setAdvisoriesForTests([
            { mint: SILV, status: 'compromised', reason: 'a', url: null, since: 1 },
            { mint: ONDO, status: 'blocked', reason: 'b', url: null, since: 1 },
        ]);
        expect(pickPrimaryVariant(silver(), new Map(), tokenByMint)?.mint).toBe(SILV);
    });
});
