import { describe, expect, it } from 'bun:test';
import {
    computeSizeAwareScore,
    gradeImpactBps,
    IMPACT_GRADES,
    IMPACT_GRADE_MAX_BPS,
    interpolateImpactBps,
    isSpotLikeVariantKind,
    pickPrimaryVariantWithRanking,
    rankVariantsWithReasons,
    SIZE_AWARE_IMPACT_FLOOR_BPS,
    type PrimaryVariantStrategy,
    type VariantFillQualityRankingSnapshot,
    type VariantMarketRankingSnapshot,
} from './primary-variant-ranking';
import type { AssetVariant, CanonicalAsset } from './types';

const NOW = 1_700_000_000;
const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const MINT_C = 'KeGvyv1D8E7MRcE6x3tmEKkzuZg5c2e4FivF3bKpump';
const MINT_D = '7vfCXTUXxCGDfbA4HgimTXKyt7KS5pJGw1zfKedpump';

function variant(
    mint: string,
    variantId: string,
    trustTier: AssetVariant['trustTier'] = 'tier2',
    stockVariantTier?: AssetVariant['stockVariantTier'],
): AssetVariant {
    return {
        variantId,
        mint,
        kind: 'tokenized_equity',
        trustTier,
        tags: [],
        ...(stockVariantTier ? { stockVariantTier } : {}),
    };
}

function asset(variants: AssetVariant[]): CanonicalAsset {
    return {
        assetId: 'tesla',
        category: 'equity',
        aliases: [],
        variants,
    };
}

function fill(overrides: Partial<VariantFillQualityRankingSnapshot> = {}): VariantFillQualityRankingSnapshot {
    return {
        volume24hUSD: 100_000,
        trade24h: 100,
        flowSourceCount: 2,
        botVolumeRatio: 0.1,
        feeBps: 1,
        executionScore: 50,
        isEligibleForPrimary: true,
        asOf: NOW,
        ...overrides,
    };
}

function market(overrides: Partial<VariantMarketRankingSnapshot> = {}): VariantMarketRankingSnapshot {
    return {
        liquidity: 1_000_000,
        volume24hUSD: 100_000,
        trade24h: 100,
        ...overrides,
    };
}

function pick(params: {
    variants?: AssetVariant[];
    marketByMint: Map<string, VariantMarketRankingSnapshot>;
    fillQualityByMint?: Map<string, VariantFillQualityRankingSnapshot>;
    strategy?: PrimaryVariantStrategy;
    mintRank?: Map<string, number>;
}) {
    return pickPrimaryVariantWithRanking({
        asset: asset(params.variants ?? [variant(MINT_A, 'tesla:ondo'), variant(MINT_B, 'tesla:xstock')]),
        mintRank:
            params.mintRank ??
            new Map([
                [MINT_A, 0],
                [MINT_B, 1],
                [MINT_C, 2],
                [MINT_D, 3],
            ]),
        marketByMint: params.marketByMint,
        fillQualityByMint: params.fillQualityByMint,
        options: { nowSeconds: NOW, strategy: params.strategy },
    }).variant;
}

describe('pickPrimaryVariantWithRanking', () => {
    it('defaults to liquidity strategy', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000 })],
                [MINT_B, market({ liquidity: 900_000 })],
            ]),
            fillQualityByMint: new Map([
                [MINT_A, fill({ executionScore: 40 })],
                [MINT_B, fill({ executionScore: 90 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('liquidity strategy ignores higher execution score', () => {
        const selected = pick({
            strategy: 'liquidity',
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000 })],
                [MINT_B, market({ liquidity: 800_000 })],
            ]),
            fillQualityByMint: new Map([
                [MINT_A, fill({ executionScore: 35 })],
                [MINT_B, fill({ executionScore: 95 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('execution-quality strategy preserves hybrid override within the liquidity-ratio cap', () => {
        const selected = pick({
            strategy: 'execution_quality',
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000 })],
                [MINT_B, market({ liquidity: 800_000 })],
            ]),
            fillQualityByMint: new Map([
                [MINT_A, fill({ executionScore: 35 })],
                [MINT_B, fill({ executionScore: 80 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('execution-quality strategy does not override when the liquidity gap exceeds the cap', () => {
        const selected = pick({
            strategy: 'execution_quality',
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 10_000_000 })],
                [MINT_B, market({ liquidity: 1_000_000 })],
            ]),
            fillQualityByMint: new Map([
                [MINT_A, fill({ executionScore: 35 })],
                [MINT_B, fill({ executionScore: 90 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('execution-quality strategy does not override when score gap is below threshold', () => {
        const selected = pick({
            strategy: 'execution_quality',
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000 })],
                [MINT_B, market({ liquidity: 900_000 })],
            ]),
            fillQualityByMint: new Map([
                [MINT_A, fill({ executionScore: 70 })],
                [MINT_B, fill({ executionScore: 79 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('filters candidates with low known trade count', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000, trade24h: 3 })],
                [MINT_B, market({ liquidity: 1_000_000, trade24h: 50 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('filters candidates with low known volume', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000, volume24hUSD: 50 })],
                [MINT_B, market({ liquidity: 1_000_000, volume24hUSD: 10_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('does not filter candidates solely because activity metrics are missing', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, { liquidity: 2_000_000 }],
                [MINT_B, market({ liquidity: 1_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('falls back when filters would remove every candidate', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000, volume24hUSD: 50, trade24h: 3 })],
                [MINT_B, market({ liquidity: 1_000_000, volume24hUSD: 25, trade24h: 2 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('filters a robust volume outlier when there are enough samples', () => {
        const selected = pick({
            variants: [variant(MINT_A, 'tesla:a'), variant(MINT_B, 'tesla:b'), variant(MINT_C, 'tesla:c')],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 10_000_000, volume24hUSD: 100_000 })],
                [MINT_B, market({ liquidity: 2_000_000, volume24hUSD: 110_000 })],
                [MINT_C, market({ liquidity: 1_000_000, volume24hUSD: 100_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('filters a robust trade outlier when there are enough samples', () => {
        const selected = pick({
            variants: [variant(MINT_A, 'tesla:a'), variant(MINT_B, 'tesla:b'), variant(MINT_C, 'tesla:c')],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 10_000_000, trade24h: 100 })],
                [MINT_B, market({ liquidity: 2_000_000, trade24h: 105 })],
                [MINT_C, market({ liquidity: 1_000_000, trade24h: 1_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('does not run robust outlier filtering for fewer than three samples', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000, volume24hUSD: 100_000 })],
                [MINT_B, market({ liquidity: 2_000_000, volume24hUSD: 100_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('uses fill-quality activity as fallback when market activity metrics are missing', () => {
        const selected = pick({
            marketByMint: new Map([
                [MINT_A, { liquidity: 2_000_000 }],
                [MINT_B, market({ liquidity: 1_000_000 })],
            ]),
            fillQualityByMint: new Map([[MINT_A, fill({ volume24hUSD: 50, trade24h: 2 })]]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('uses lexical tie-break when requested', () => {
        const result = pickPrimaryVariantWithRanking({
            asset: asset([variant(MINT_C, 'tesla:c'), variant(MINT_B, 'tesla:b')]),
            mintRank: new Map(),
            marketByMint: new Map(),
            options: { nowSeconds: NOW, lexicalTieBreak: true },
        });

        expect(result.variant?.mint).toBe(MINT_C < MINT_B ? MINT_C : MINT_B);
    });

    it('stock-redeemability strategy picks a share-redeemable variant within the liquidity cap', () => {
        const selected = pick({
            strategy: 'stock_redeemability',
            variants: [
                variant(MINT_A, 'spacex:ondo', 'tier2', 'cash_redeemable'),
                variant(MINT_B, 'spacex:backpack', 'tier2', 'share_redeemable'),
            ],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 2_000_000 })],
                [MINT_B, market({ liquidity: 600_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('stock-redeemability strategy lets liquidity win beyond the override cap', () => {
        const selected = pick({
            strategy: 'stock_redeemability',
            variants: [
                variant(MINT_A, 'spacex:ondo', 'tier2', 'cash_redeemable'),
                variant(MINT_B, 'spacex:backpack', 'tier2', 'share_redeemable'),
            ],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 6_000_000 })],
                [MINT_B, market({ liquidity: 1_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });

    it('stock-redeemability strategy treats missing stock tier as not redeemable', () => {
        const selected = pick({
            strategy: 'stock_redeemability',
            variants: [variant(MINT_A, 'spacex:unknown'), variant(MINT_B, 'spacex:xstock', 'tier2', 'cash_redeemable')],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000 })],
                [MINT_B, market({ liquidity: 900_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_B);
    });

    it('treats spot as spot-like and etf as not', () => {
        expect(isSpotLikeVariantKind('spot')).toBe(true);
        expect(isSpotLikeVariantKind('etf')).toBe(false);
    });

    it('prefers spot variants over higher-liquidity etf variants for primary selection', () => {
        const spot: AssetVariant = { ...variant(MINT_A, 'gold:pax-gold'), kind: 'spot' };
        const etf: AssetVariant = { ...variant(MINT_B, 'gold:gold-token'), kind: 'etf' };

        const selected = pick({
            variants: [spot, etf],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 100_000 })],
                [MINT_B, market({ liquidity: 5_000_000 })],
            ]),
        });

        expect(selected?.mint).toBe(MINT_A);
    });
});

describe('rankVariantsWithReasons', () => {
    function rank(params: {
        variants: AssetVariant[];
        marketByMint?: Map<string, VariantMarketRankingSnapshot>;
        fillQualityByMint?: Map<string, VariantFillQualityRankingSnapshot>;
        strategy?: PrimaryVariantStrategy;
    }) {
        return rankVariantsWithReasons({
            asset: asset(params.variants),
            mintRank: new Map([
                [MINT_A, 0],
                [MINT_B, 1],
                [MINT_C, 2],
                [MINT_D, 3],
            ]),
            ...(params.marketByMint ? { marketByMint: params.marketByMint } : {}),
            ...(params.fillQualityByMint ? { fillQualityByMint: params.fillQualityByMint } : {}),
            options: { nowSeconds: NOW, ...(params.strategy ? { strategy: params.strategy } : {}) },
        });
    }

    it('matches the pickPrimaryVariantWithRanking winner across strategies and data shapes', () => {
        const configs: Array<{
            variants: AssetVariant[];
            marketByMint: Map<string, VariantMarketRankingSnapshot>;
            fillQualityByMint?: Map<string, VariantFillQualityRankingSnapshot>;
            strategy?: PrimaryVariantStrategy;
        }> = [
            {
                variants: [variant(MINT_A, 'tesla:ondo'), variant(MINT_B, 'tesla:xstock')],
                marketByMint: new Map([
                    [MINT_A, market({ liquidity: 100_000 })],
                    [MINT_B, market({ liquidity: 5_000_000 })],
                ]),
            },
            {
                variants: [
                    variant(MINT_A, 'tesla:ondo'),
                    variant(MINT_B, 'tesla:xstock'),
                    variant(MINT_C, 'tesla:c'),
                ],
                marketByMint: new Map([
                    [MINT_A, market({ liquidity: 2_000_000 })],
                    [MINT_B, market({ liquidity: 1_900_000 })],
                    [MINT_C, market({ liquidity: 40, volume24hUSD: 10, trade24h: 1 })],
                ]),
            },
            {
                variants: [variant(MINT_A, 'tesla:ondo'), variant(MINT_B, 'tesla:xstock')],
                marketByMint: new Map([
                    [MINT_A, market({ liquidity: 1_000_000 })],
                    [MINT_B, market({ liquidity: 900_000 })],
                ]),
                fillQualityByMint: new Map([
                    [MINT_A, fill({ executionScore: 30 })],
                    [MINT_B, fill({ executionScore: 80 })],
                ]),
                strategy: 'execution_quality' as PrimaryVariantStrategy,
            },
        ];

        for (const config of configs) {
            const ranked = rankVariantsWithReasons({
                asset: asset(config.variants),
                mintRank: new Map([
                    [MINT_A, 0],
                    [MINT_B, 1],
                    [MINT_C, 2],
                ]),
                marketByMint: config.marketByMint,
                ...(config.fillQualityByMint ? { fillQualityByMint: config.fillQualityByMint } : {}),
                options: { nowSeconds: NOW, ...(config.strategy ? { strategy: config.strategy } : {}) },
            });
            const picked = pickPrimaryVariantWithRanking({
                asset: asset(config.variants),
                mintRank: new Map([
                    [MINT_A, 0],
                    [MINT_B, 1],
                    [MINT_C, 2],
                ]),
                marketByMint: config.marketByMint,
                ...(config.fillQualityByMint ? { fillQualityByMint: config.fillQualityByMint } : {}),
                options: { nowSeconds: NOW, ...(config.strategy ? { strategy: config.strategy } : {}) },
            });
            expect(ranked[0]?.variant.mint).toBe(picked.variant!.mint);
            expect(ranked[0]?.reason).toBe(picked.reason!);
        }
    });

    it('orders candidates by liquidity and covers every variant exactly once with 1-based ranks', () => {
        const ranked = rank({
            variants: [variant(MINT_A, 'tesla:a'), variant(MINT_B, 'tesla:b'), variant(MINT_C, 'tesla:c')],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000 })],
                [MINT_B, market({ liquidity: 3_000_000 })],
                [MINT_C, market({ liquidity: 2_000_000 })],
            ]),
        });

        expect(ranked.map(entry => entry.variant.mint)).toEqual([MINT_B, MINT_C, MINT_A]);
        expect(ranked.map(entry => entry.rank)).toEqual([1, 2, 3]);
        expect(ranked[0]?.reason).toBe('liquidity');
        expect(ranked.every(entry => entry.isPrimaryCandidate)).toBe(true);
    });

    it('trails activity-filtered variants with an exclusion reason', () => {
        const ranked = rank({
            variants: [variant(MINT_A, 'tesla:a'), variant(MINT_B, 'tesla:b'), variant(MINT_C, 'tesla:c')],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 1_000_000 })],
                [MINT_B, market({ liquidity: 3_000_000 })],
                [MINT_C, market({ liquidity: 2_000_000, volume24hUSD: 10, trade24h: 1 })],
            ]),
        });

        const last = ranked[ranked.length - 1]!;
        expect(last.variant.mint).toBe(MINT_C);
        expect(last.reason).toBe('excluded_by_activity_filter');
        expect(last.isPrimaryCandidate).toBe(false);
        expect(ranked.filter(entry => entry.isPrimaryCandidate).length).toBe(2);
    });

    it('trails non-spot-like variants when spot-like variants exist', () => {
        const spot: AssetVariant = { ...variant(MINT_A, 'gold:spot'), kind: 'spot' };
        const etf: AssetVariant = { ...variant(MINT_B, 'gold:etf'), kind: 'etf' };
        const ranked = rank({
            variants: [spot, etf],
            marketByMint: new Map([
                [MINT_A, market({ liquidity: 100_000 })],
                [MINT_B, market({ liquidity: 5_000_000 })],
            ]),
        });

        expect(ranked.map(entry => entry.variant.mint)).toEqual([MINT_A, MINT_B]);
        expect(ranked[0]?.reason).toBe('only_candidate');
        expect(ranked[1]?.reason).toBe('non_spot_like');
        expect(ranked[1]?.isPrimaryCandidate).toBe(false);
    });

    it('reports only_candidate for a single-variant asset', () => {
        const ranked = rank({
            variants: [variant(MINT_A, 'tesla:a')],
            marketByMint: new Map([[MINT_A, market()]]),
        });
        expect(ranked).toHaveLength(1);
        expect(ranked[0]?.reason).toBe('only_candidate');
    });

    it('returns an empty list for an asset with no variants', () => {
        expect(rank({ variants: [] })).toEqual([]);
    });
});

describe('interpolateImpactBps', () => {
    const LADDER = [
        { sizeUsd: 10_000, priceImpactBps: 0 },
        { sizeUsd: 100_000, priceImpactBps: 10 },
        { sizeUsd: 1_000_000, priceImpactBps: 40 },
        { sizeUsd: 5_000_000, priceImpactBps: 120 },
    ];

    it('returns exact rung values', () => {
        expect(interpolateImpactBps(LADDER, 100_000)).toEqual({ impactBps: 10, extrapolated: false });
        expect(interpolateImpactBps(LADDER, 5_000_000)).toEqual({ impactBps: 120, extrapolated: false });
    });

    it('interpolates log-linearly between rungs', () => {
        // Halfway between 100k and 1M in log space is ~316k.
        const mid = interpolateImpactBps(LADDER, Math.sqrt(100_000 * 1_000_000));
        expect(mid?.extrapolated).toBe(false);
        expect(mid?.impactBps).toBe(25);
    });

    it('clamps below the smallest rung without flagging extrapolation', () => {
        expect(interpolateImpactBps(LADDER, 1_000)).toEqual({ impactBps: 0, extrapolated: false });
    });

    it('clamps above the largest rung and flags extrapolation', () => {
        expect(interpolateImpactBps(LADDER, 20_000_000)).toEqual({ impactBps: 120, extrapolated: true });
    });

    it('ignores rungs without usable impact and handles unsorted input', () => {
        const sparse = [
            { sizeUsd: 1_000_000, priceImpactBps: 40 },
            { sizeUsd: 10_000, priceImpactBps: null },
            { sizeUsd: 100_000, priceImpactBps: 10 },
        ];
        expect(interpolateImpactBps(sparse, 1_000_000)).toEqual({ impactBps: 40, extrapolated: false });
        expect(interpolateImpactBps(sparse, 50_000)).toEqual({ impactBps: 10, extrapolated: false });
    });

    it('returns null for unusable ladders and invalid amounts', () => {
        expect(interpolateImpactBps([], 1_000_000)).toBeNull();
        expect(interpolateImpactBps([{ sizeUsd: 10_000, priceImpactBps: null }], 1_000_000)).toBeNull();
        expect(interpolateImpactBps(LADDER, 0)).toBeNull();
        expect(interpolateImpactBps(LADDER, Number.NaN)).toBeNull();
    });
});

describe('computeSizeAwareScore', () => {
    it('is monotone: higher impact never raises the score', () => {
        let previous = Number.POSITIVE_INFINITY;
        for (const impactBps of [0, 10, 50, 100, 250, 500, 1_000]) {
            const score = computeSizeAwareScore({ executionScore: 80, impactBps });
            expect(score).toBeLessThanOrEqual(previous);
            previous = score;
        }
    });

    it('blends 60/40 with the impact floor', () => {
        expect(computeSizeAwareScore({ executionScore: 100, impactBps: 0 })).toBe(100);
        expect(computeSizeAwareScore({ executionScore: 100, impactBps: SIZE_AWARE_IMPACT_FLOOR_BPS })).toBe(60);
        expect(computeSizeAwareScore({ executionScore: 0, impactBps: 0 })).toBe(40);
        expect(computeSizeAwareScore({ executionScore: 50, impactBps: 250 })).toBe(50);
    });

    it('clamps out-of-range inputs', () => {
        expect(computeSizeAwareScore({ executionScore: 150, impactBps: -10 })).toBe(100);
        expect(computeSizeAwareScore({ executionScore: -5, impactBps: 10_000 })).toBe(0);
    });
});

describe('gradeImpactBps', () => {
    it('grades inclusive upper bounds', () => {
        expect(gradeImpactBps(IMPACT_GRADE_MAX_BPS.excellent)).toBe('excellent');
        expect(gradeImpactBps(IMPACT_GRADE_MAX_BPS.good)).toBe('good');
        expect(gradeImpactBps(IMPACT_GRADE_MAX_BPS.fair)).toBe('fair');
        expect(gradeImpactBps(IMPACT_GRADE_MAX_BPS.poor)).toBe('poor');
    });

    it('steps to the next grade just past each bound', () => {
        expect(gradeImpactBps(10.01)).toBe('good');
        expect(gradeImpactBps(50.01)).toBe('fair');
        expect(gradeImpactBps(150.01)).toBe('poor');
        expect(gradeImpactBps(501)).toBe('avoid');
    });

    it('treats zero and price improvement as excellent', () => {
        expect(gradeImpactBps(0)).toBe('excellent');
        expect(gradeImpactBps(-25)).toBe('excellent');
    });

    it('fails closed to avoid on non-finite input', () => {
        expect(gradeImpactBps(Number.NaN)).toBe('avoid');
        expect(gradeImpactBps(Number.POSITIVE_INFINITY)).toBe('avoid');
    });

    it('matches the observed sampled-depth anchors', () => {
        // HYPE @$1M, wETH @$5M, HYPE @$5M from local jupiter_lite sampling.
        expect(gradeImpactBps(140)).toBe('fair');
        expect(gradeImpactBps(158)).toBe('poor');
        expect(gradeImpactBps(7040)).toBe('avoid');
    });

    it('pins the avoid cutoff to the size-aware impact floor', () => {
        expect(IMPACT_GRADE_MAX_BPS.poor).toBe(SIZE_AWARE_IMPACT_FLOOR_BPS);
        expect(IMPACT_GRADES).toEqual(['excellent', 'good', 'fair', 'poor', 'avoid']);
    });
});
