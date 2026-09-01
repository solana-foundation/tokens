import { liquidityTierPriority, normalizeLegacyTier } from './liquidity-tier';
import type { AssetCategory, AssetVariant, CanonicalAsset, LiquidityTier, StockVariantTier } from './types';

export const FILL_QUALITY_SCORING_VERSION = 'fill-quality-24h-5s-v1';
export const SIZE_AWARE_SCORING_VERSION = 'size-aware-exec-v1';

/** Impact at/above this many bps zeroes the impact component of the size-aware blend. */
export const SIZE_AWARE_IMPACT_FLOOR_BPS = 500;
/** Size-aware reordering (once activated) requires at least this score delta. */
export const SIZE_AWARE_OVERRIDE_DELTA = 5;

const EXECUTION_SCORE_OVERRIDE_DELTA = 10;
const MAX_LIQUIDITY_OVERRIDE_RATIO = 3;
const MAX_STOCK_REDEEMABILITY_OVERRIDE_RATIO = 5;
const MIN_FILL_QUALITY_VOLUME_USD = 10_000;
const MIN_FILL_QUALITY_TRADES = 10;
const MIN_FILL_QUALITY_FLOW_SOURCES = 1;
const MAX_FILL_QUALITY_AGE_SECONDS = 48 * 60 * 60;
const MIN_ACTIVITY_VOLUME_24H_USD = 100;
const MIN_ACTIVITY_TRADES_24H = 5;
const ROBUST_ACTIVITY_Z_THRESHOLD = 2.5;
const MIN_ROBUST_ACTIVITY_SAMPLE_SIZE = 3;
const MAD_EPSILON = 1e-9;

export type PrimaryVariantStrategy = 'liquidity' | 'execution_quality' | 'stock_redeemability';

export interface VariantMarketRankingSnapshot {
    liquidity?: number | null;
    volume24hUSD?: number | null;
    trade24h?: number | null;
}

export interface VariantFillQualityRankingSnapshot {
    volume24hUSD?: number | null;
    trade24h?: number | null;
    flowSourceCount?: number | null;
    botVolumeRatio?: number | null;
    feeBps?: number | null;
    executionScore?: number | null;
    isEligibleForPrimary?: boolean | null;
    asOf?: number | null;
}

export interface PrimaryVariantRankingOptions {
    nowSeconds?: number;
    lexicalTieBreak?: boolean;
    strategy?: PrimaryVariantStrategy;
}

export type PrimaryVariantSelectionReason =
    | 'only_candidate'
    | 'activity_filter'
    | 'execution_quality_zero_liquidity'
    | 'execution_quality_override'
    | 'stock_redeemability_zero_liquidity'
    | 'stock_redeemability_override'
    | 'liquidity'
    | 'trust_tier'
    | 'volume24h'
    | 'curated_rank'
    | 'mint_lexical'
    | 'first_candidate';

export interface PrimaryVariantSelectionResult {
    variant: AssetVariant | null;
    reason: PrimaryVariantSelectionReason | null;
}

export function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

export function logScore(value: number, scale: number): number {
    const normalizedValue = Math.max(0, Number.isFinite(value) ? value : 0);
    const normalizedScale = Math.max(1, Number.isFinite(scale) ? scale : 1);
    return clamp(Math.log1p(normalizedValue) / Math.log1p(normalizedScale), 0, 1);
}

export function computeVariantExecutionScore(input: {
    volume24hUSD: number;
    trade24h: number;
    flowSourceCount: number;
    botVolumeRatio: number;
    feeBps: number;
}): number {
    if (
        Math.max(0, Number.isFinite(input.volume24hUSD) ? input.volume24hUSD : 0) === 0 &&
        Math.max(0, Number.isFinite(input.trade24h) ? input.trade24h : 0) === 0 &&
        Math.max(0, Number.isFinite(input.flowSourceCount) ? input.flowSourceCount : 0) === 0
    ) {
        return 0;
    }

    const botQuality = 1 - clamp(input.botVolumeRatio, 0, 1);
    const feeQuality = 1 - clamp(input.feeBps / 25, 0, 1);
    const score =
        100 *
        (0.35 * logScore(input.volume24hUSD, 50_000_000) +
            0.25 * logScore(input.trade24h, 10_000) +
            0.2 * logScore(input.flowSourceCount, 8) +
            0.1 * botQuality +
            0.1 * feeQuality);

    return Math.round(clamp(score, 0, 100) * 10_000) / 10_000;
}

export function isFillQualityEligibleForPrimary(
    fillQuality: VariantFillQualityRankingSnapshot | null | undefined,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
    if (!fillQuality) return false;
    if (fillQuality.isEligibleForPrimary === false) return false;

    const volume24hUSD = finiteNonNegative(fillQuality.volume24hUSD);
    const trade24h = finiteNonNegative(fillQuality.trade24h);
    const flowSourceCount = finiteNonNegative(fillQuality.flowSourceCount);
    const asOf = finitePositive(fillQuality.asOf);
    if (volume24hUSD < MIN_FILL_QUALITY_VOLUME_USD) return false;
    if (trade24h < MIN_FILL_QUALITY_TRADES) return false;
    if (flowSourceCount < MIN_FILL_QUALITY_FLOW_SOURCES) return false;
    if (asOf === null) return false;
    return nowSeconds - asOf <= MAX_FILL_QUALITY_AGE_SECONDS;
}

export function isSpotLikeVariantKind(kind: AssetVariant['kind']): boolean {
    return (
        kind === 'native' ||
        kind === 'wrapped' ||
        kind === 'bridged' ||
        kind === 'spot' ||
        kind === 'stablecoin' ||
        kind === 'lst' ||
        kind === 'tokenized_equity' ||
        kind === 'basket'
    );
}

export function pickPrimaryVariantWithRanking(params: {
    asset: CanonicalAsset;
    mintRank: ReadonlyMap<string, number>;
    marketByMint?: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>;
    fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
    options?: PrimaryVariantRankingOptions;
}): PrimaryVariantSelectionResult {
    if (params.asset.variants.length === 0) return { variant: null, reason: null };

    const spotLikeVariants = params.asset.variants.filter(v => isSpotLikeVariantKind(v.kind));
    const baseCandidates = spotLikeVariants.length > 0 ? spotLikeVariants : params.asset.variants;
    const candidates = filterPrimaryCandidatesByActivity({
        candidates: baseCandidates,
        marketByMint: params.marketByMint,
        fillQualityByMint: params.fillQualityByMint,
    });
    if (candidates.length === 1) return { variant: candidates[0]!, reason: 'only_candidate' };

    const nowSeconds = params.options?.nowSeconds ?? Math.floor(Date.now() / 1000);
    const lexicalTieBreak = params.options?.lexicalTieBreak ?? false;
    const strategy = params.options?.strategy ?? 'liquidity';
    let best = candidates[0]!;
    let reason: PrimaryVariantSelectionReason =
        candidates.length !== baseCandidates.length ? 'activity_filter' : 'first_candidate';

    for (let i = 1; i < candidates.length; i++) {
        const next = candidates[i]!;
        const comparison = comparePrimaryVariantCandidates({
            next,
            best,
            assetCategory: params.asset.category,
            mintRank: params.mintRank,
            marketByMint: params.marketByMint,
            fillQualityByMint: params.fillQualityByMint,
            nowSeconds,
            lexicalTieBreak,
            strategy,
        });
        if (comparison.isBetter) {
            best = next;
            reason = comparison.reason;
        }
    }

    return { variant: best, reason };
}

export interface DepthLadderRung {
    sizeUsd: number;
    priceImpactBps: number | null;
}

export interface InterpolatedImpact {
    impactBps: number;
    /** True when amountUsd fell outside the sampled ladder and was clamped. */
    extrapolated: boolean;
}

/**
 * Interpolate price impact at `amountUsd` from a sampled ladder. Log-linear in
 * size space (impact curves are near-power-law); clamps below the smallest and
 * above the largest usable rung (`extrapolated: true` above). Returns null
 * when no rung carries a usable impact.
 */
export function interpolateImpactBps(
    ladder: ReadonlyArray<DepthLadderRung>,
    amountUsd: number,
): InterpolatedImpact | null {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
    const rungs = ladder
        .filter(
            (rung): rung is { sizeUsd: number; priceImpactBps: number } =>
                Number.isFinite(rung.sizeUsd) &&
                rung.sizeUsd > 0 &&
                rung.priceImpactBps !== null &&
                Number.isFinite(rung.priceImpactBps),
        )
        .sort((a, b) => a.sizeUsd - b.sizeUsd);
    if (rungs.length === 0) return null;

    const first = rungs[0]!;
    const last = rungs[rungs.length - 1]!;
    if (amountUsd <= first.sizeUsd) return { impactBps: first.priceImpactBps, extrapolated: false };
    if (amountUsd >= last.sizeUsd) {
        return { impactBps: last.priceImpactBps, extrapolated: amountUsd > last.sizeUsd };
    }

    for (let i = 1; i < rungs.length; i++) {
        const lower = rungs[i - 1]!;
        const upper = rungs[i]!;
        if (amountUsd > upper.sizeUsd) continue;
        const span = Math.log(upper.sizeUsd) - Math.log(lower.sizeUsd);
        const t = span > 0 ? (Math.log(amountUsd) - Math.log(lower.sizeUsd)) / span : 0;
        const impactBps = lower.priceImpactBps + t * (upper.priceImpactBps - lower.priceImpactBps);
        return { impactBps: Math.round(impactBps * 100) / 100, extrapolated: false };
    }

    return { impactBps: last.priceImpactBps, extrapolated: false };
}

/**
 * Blend the fill-quality execution score with interpolated price impact.
 * Same clamp/blend idiom as `computeVariantExecutionScore`; bump
 * `SIZE_AWARE_SCORING_VERSION` when weights change.
 */
export function computeSizeAwareScore(input: { executionScore: number; impactBps: number }): number {
    const executionQuality = clamp(input.executionScore / 100, 0, 1);
    const impactQuality = 1 - clamp(input.impactBps / SIZE_AWARE_IMPACT_FLOOR_BPS, 0, 1);
    const score = 100 * (0.6 * executionQuality + 0.4 * impactQuality);
    return Math.round(clamp(score, 0, 100) * 10_000) / 10_000;
}

export const EXECUTION_GRADING_VERSION = 'impact-grade-v1';

/** Ordered best-to-worst; publish this order so consumers can rank. */
export const IMPACT_GRADES = ['excellent', 'good', 'fair', 'poor', 'avoid'] as const;
export type ImpactGrade = (typeof IMPACT_GRADES)[number];

/**
 * Inclusive upper bound (bps) per grade; anything above `poor` is `avoid`.
 * The `poor` bound intentionally equals SIZE_AWARE_IMPACT_FLOOR_BPS: `avoid`
 * is exactly where the size-aware blend's impact component floors to zero.
 */
export const IMPACT_GRADE_MAX_BPS = {
    excellent: 10,
    good: 50,
    fair: 150,
    poor: SIZE_AWARE_IMPACT_FLOOR_BPS,
} as const;

/**
 * Grade a price-impact reading. Zero or negative impact (price improvement)
 * is `excellent`; non-finite input fails closed to `avoid`. Bump
 * EXECUTION_GRADING_VERSION when thresholds or the enum change.
 */
export function gradeImpactBps(impactBps: number): ImpactGrade {
    if (!Number.isFinite(impactBps)) return 'avoid';
    if (impactBps <= IMPACT_GRADE_MAX_BPS.excellent) return 'excellent';
    if (impactBps <= IMPACT_GRADE_MAX_BPS.good) return 'good';
    if (impactBps <= IMPACT_GRADE_MAX_BPS.fair) return 'fair';
    if (impactBps <= IMPACT_GRADE_MAX_BPS.poor) return 'poor';
    return 'avoid';
}

export type VariantRankingExclusionReason = 'excluded_by_activity_filter' | 'non_spot_like';

export interface RankedVariantEntry {
    variant: AssetVariant;
    /** 1-based position in the ranked list. */
    rank: number;
    reason: PrimaryVariantSelectionReason | VariantRankingExclusionReason;
    /** True for variants that survived candidate filtering (spot-like preference + activity gate). */
    isPrimaryCandidate: boolean;
}

/**
 * List-producing counterpart of `pickPrimaryVariantWithRanking`: the full
 * variant set in recommendation order with a per-variant reason. Ordering is
 * derived by repeated selection with the exact pick-loop semantics, so the
 * first entry is always the variant `pickPrimaryVariantWithRanking` returns
 * for identical inputs (unit-tested invariant). Variants excluded from the
 * candidate set (activity-filtered, or non-spot-like when spot-like variants
 * exist) trail the candidates, ordered by liquidity.
 */
export function rankVariantsWithReasons(params: {
    asset: CanonicalAsset;
    mintRank: ReadonlyMap<string, number>;
    marketByMint?: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>;
    fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
    /**
     * Reserved for size-aware ranking: interpolated price impact (bps) per
     * mint. Informational-only until size-aware reordering is activated —
     * it never affects ordering today.
     */
    impactByMint?: ReadonlyMap<string, number | null>;
    options?: PrimaryVariantRankingOptions;
}): RankedVariantEntry[] {
    if (params.asset.variants.length === 0) return [];

    const spotLikeVariants = params.asset.variants.filter(v => isSpotLikeVariantKind(v.kind));
    const baseCandidates = spotLikeVariants.length > 0 ? spotLikeVariants : params.asset.variants;
    const candidates = filterPrimaryCandidatesByActivity({
        candidates: baseCandidates,
        marketByMint: params.marketByMint,
        fillQualityByMint: params.fillQualityByMint,
    });

    const nowSeconds = params.options?.nowSeconds ?? Math.floor(Date.now() / 1000);
    const lexicalTieBreak = params.options?.lexicalTieBreak ?? false;
    const strategy = params.options?.strategy ?? 'liquidity';
    const activityFiltered = candidates.length !== baseCandidates.length;

    const entries: RankedVariantEntry[] = [];
    const remaining = [...candidates];
    while (remaining.length > 0) {
        // Each round replicates the pick loop over the remaining candidates,
        // including its initial-reason semantics for the first round.
        let best = remaining[0]!;
        let reason: PrimaryVariantSelectionReason;
        if (entries.length === 0) {
            reason = candidates.length === 1 ? 'only_candidate' : activityFiltered ? 'activity_filter' : 'first_candidate';
        } else {
            reason = 'first_candidate';
        }
        for (let i = 1; i < remaining.length; i++) {
            const next = remaining[i]!;
            const comparison = comparePrimaryVariantCandidates({
                next,
                best,
                assetCategory: params.asset.category,
                mintRank: params.mintRank,
                marketByMint: params.marketByMint,
                fillQualityByMint: params.fillQualityByMint,
                nowSeconds,
                lexicalTieBreak,
                strategy,
            });
            if (comparison.isBetter) {
                best = next;
                reason = comparison.reason;
            }
        }
        entries.push({ variant: best, rank: entries.length + 1, reason, isPrimaryCandidate: true });
        remaining.splice(remaining.indexOf(best), 1);
    }

    const rankedMints = new Set(entries.map(entry => entry.variant.mint));
    const byLiquidityDesc = (a: AssetVariant, b: AssetVariant) =>
        getLiquidity(params.marketByMint, b.mint) - getLiquidity(params.marketByMint, a.mint);

    const activityExcluded = baseCandidates.filter(v => !rankedMints.has(v.mint)).sort(byLiquidityDesc);
    for (const variant of activityExcluded) {
        entries.push({
            variant,
            rank: entries.length + 1,
            reason: 'excluded_by_activity_filter',
            isPrimaryCandidate: false,
        });
        rankedMints.add(variant.mint);
    }

    const nonSpotLike = params.asset.variants.filter(v => !rankedMints.has(v.mint)).sort(byLiquidityDesc);
    for (const variant of nonSpotLike) {
        entries.push({ variant, rank: entries.length + 1, reason: 'non_spot_like', isPrimaryCandidate: false });
    }

    return entries;
}

function comparePrimaryVariantCandidates(params: {
    next: AssetVariant;
    best: AssetVariant;
    assetCategory: AssetCategory;
    mintRank: ReadonlyMap<string, number>;
    marketByMint?: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>;
    fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
    nowSeconds: number;
    lexicalTieBreak: boolean;
    strategy: PrimaryVariantStrategy;
}): { isBetter: boolean; reason: PrimaryVariantSelectionReason } {
    const nextLiquidity = getLiquidity(params.marketByMint, params.next.mint);
    const bestLiquidity = getLiquidity(params.marketByMint, params.best.mint);
    if (params.strategy === 'stock_redeemability') {
        const stockRedeemabilityDecision = compareByStockRedeemability(params, nextLiquidity, bestLiquidity);
        if (stockRedeemabilityDecision) return stockRedeemabilityDecision;
    }

    if (params.strategy === 'execution_quality') {
        const executionDecision = compareByExecutionQuality(params, nextLiquidity, bestLiquidity);
        if (executionDecision) return executionDecision;
    }

    const liquidityDelta = nextLiquidity - bestLiquidity;
    if (liquidityDelta !== 0) return { isBetter: liquidityDelta > 0, reason: 'liquidity' };

    const nextTier = normalizeTier(params.next.trustTier);
    const bestTier = normalizeTier(params.best.trustTier);
    const trustDelta = liquidityTierPriority(nextTier) - liquidityTierPriority(bestTier);
    if (trustDelta !== 0) return { isBetter: trustDelta > 0, reason: 'trust_tier' };

    const volumeDelta = getVolume(params.marketByMint, params.next.mint) - getVolume(params.marketByMint, params.best.mint);
    if (volumeDelta !== 0) return { isBetter: volumeDelta > 0, reason: 'volume24h' };

    const rankDelta = getMintRank(params.mintRank, params.next.mint) - getMintRank(params.mintRank, params.best.mint);
    if (rankDelta !== 0) return { isBetter: rankDelta < 0, reason: 'curated_rank' };

    if (params.lexicalTieBreak) {
        return {
            isBetter: params.next.mint.localeCompare(params.best.mint) < 0,
            reason: 'mint_lexical',
        };
    }

    return { isBetter: false, reason: 'first_candidate' };
}

function filterPrimaryCandidatesByActivity(params: {
    candidates: AssetVariant[];
    marketByMint?: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>;
    fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
}): AssetVariant[] {
    if (params.candidates.length <= 1) return params.candidates;

    const withActivity = params.candidates.map(variant => ({
        variant,
        activity: getActivitySnapshot(variant.mint, params.marketByMint, params.fillQualityByMint),
    }));

    const minimumFiltered = withActivity.filter(row => passesMinimumActivityGate(row.activity));
    const afterMinimum = minimumFiltered.length > 0 ? minimumFiltered : withActivity;
    const outlierMints = new Set<string>([
        ...computeRobustActivityOutliers(afterMinimum, 'volume24hUSD'),
        ...computeRobustActivityOutliers(afterMinimum, 'trade24h'),
    ]);

    const afterOutlierFilter = afterMinimum.filter(row => !outlierMints.has(row.variant.mint));
    if (afterOutlierFilter.length === 0) return params.candidates;
    return afterOutlierFilter.map(row => row.variant);
}

function getActivitySnapshot(
    mint: string,
    marketByMint?: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined>,
    fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>,
): { volume24hUSD: number | null; trade24h: number | null } {
    const market = marketByMint?.get(mint) ?? null;
    const fillQuality = fillQualityByMint?.get(mint) ?? null;
    return {
        volume24hUSD: finiteNonNegativeOrNull(market?.volume24hUSD) ?? finiteNonNegativeOrNull(fillQuality?.volume24hUSD),
        trade24h: finiteNonNegativeOrNull(market?.trade24h) ?? finiteNonNegativeOrNull(fillQuality?.trade24h),
    };
}

function passesMinimumActivityGate(activity: { volume24hUSD: number | null; trade24h: number | null }): boolean {
    if (activity.volume24hUSD !== null && activity.volume24hUSD < MIN_ACTIVITY_VOLUME_24H_USD) return false;
    if (activity.trade24h !== null && activity.trade24h < MIN_ACTIVITY_TRADES_24H) return false;
    return true;
}

function computeRobustActivityOutliers(
    rows: Array<{ variant: AssetVariant; activity: { volume24hUSD: number | null; trade24h: number | null } }>,
    metric: 'volume24hUSD' | 'trade24h',
): string[] {
    const values = rows
        .map(row => {
            const value = row.activity[metric];
            if (value === null || value <= 0) return null;
            return { mint: row.variant.mint, value: Math.log1p(value) };
        })
        .filter((row): row is { mint: string; value: number } => row !== null);

    if (values.length < MIN_ROBUST_ACTIVITY_SAMPLE_SIZE) return [];

    const center = median(values.map(row => row.value));
    const mad = median(values.map(row => Math.abs(row.value - center)));
    const denominator = Math.max(mad, MAD_EPSILON);

    return values
        .filter(row => (0.6745 * Math.abs(row.value - center)) / denominator > ROBUST_ACTIVITY_Z_THRESHOLD)
        .map(row => row.mint);
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle]!;
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function compareByExecutionQuality(
    params: {
        next: AssetVariant;
        best: AssetVariant;
        fillQualityByMint?: ReadonlyMap<string, VariantFillQualityRankingSnapshot | null | undefined>;
        nowSeconds: number;
    },
    nextLiquidity: number,
    bestLiquidity: number,
): { isBetter: boolean; reason: PrimaryVariantSelectionReason } | null {
    const nextFill = params.fillQualityByMint?.get(params.next.mint) ?? null;
    const bestFill = params.fillQualityByMint?.get(params.best.mint) ?? null;
    const nextEligible = isFillQualityEligibleForPrimary(nextFill, params.nowSeconds);
    const bestEligible = isFillQualityEligibleForPrimary(bestFill, params.nowSeconds);
    if (!nextEligible && !bestEligible) return null;

    const nextScore = nextEligible ? finiteNonNegative(nextFill?.executionScore) : 0;
    const bestScore = bestEligible ? finiteNonNegative(bestFill?.executionScore) : 0;
    const scoreDelta = nextScore - bestScore;
    if (Math.abs(scoreDelta) < EXECUTION_SCORE_OVERRIDE_DELTA) return null;

    if (nextLiquidity <= 0 && bestLiquidity <= 0) {
        return {
            isBetter: scoreDelta > 0,
            reason: 'execution_quality_zero_liquidity',
        };
    }

    const lowerLiquidity = Math.min(nextLiquidity, bestLiquidity);
    const higherLiquidity = Math.max(nextLiquidity, bestLiquidity);
    const liquidityRatio = higherLiquidity / Math.max(lowerLiquidity, 1);
    const lowerLiquidityMint = nextLiquidity <= bestLiquidity ? params.next.mint : params.best.mint;
    const lowerLiquidityFill = params.fillQualityByMint?.get(lowerLiquidityMint) ?? null;
    const lowerLiquidityVolume = finiteNonNegative(lowerLiquidityFill?.volume24hUSD);
    if (liquidityRatio > MAX_LIQUIDITY_OVERRIDE_RATIO) return null;
    if (lowerLiquidityVolume < MIN_FILL_QUALITY_VOLUME_USD) return null;

    return {
        isBetter: scoreDelta > 0,
        reason: 'execution_quality_override',
    };
}

function compareByStockRedeemability(
    params: {
        next: AssetVariant;
        best: AssetVariant;
        assetCategory: AssetCategory;
    },
    nextLiquidity: number,
    bestLiquidity: number,
): { isBetter: boolean; reason: PrimaryVariantSelectionReason } | null {
    if (!shouldCompareStockRedeemability(params.assetCategory, params.next, params.best)) return null;

    const nextScore = stockRedeemabilityScore(params.next.stockVariantTier);
    const bestScore = stockRedeemabilityScore(params.best.stockVariantTier);
    const scoreDelta = nextScore - bestScore;
    if (scoreDelta === 0) return null;

    if (nextLiquidity <= 0 && bestLiquidity <= 0) {
        return {
            isBetter: scoreDelta > 0,
            reason: 'stock_redeemability_zero_liquidity',
        };
    }

    const lowerLiquidity = Math.min(nextLiquidity, bestLiquidity);
    const higherLiquidity = Math.max(nextLiquidity, bestLiquidity);
    const liquidityRatio = higherLiquidity / Math.max(lowerLiquidity, 1);
    if (liquidityRatio > MAX_STOCK_REDEEMABILITY_OVERRIDE_RATIO) return null;

    return {
        isBetter: scoreDelta > 0,
        reason: 'stock_redeemability_override',
    };
}

function shouldCompareStockRedeemability(
    assetCategory: AssetCategory,
    next: AssetVariant,
    best: AssetVariant,
): boolean {
    return assetCategory === 'equity' || next.kind === 'tokenized_equity' || best.kind === 'tokenized_equity';
}

function stockRedeemabilityScore(value: StockVariantTier | null | undefined): number {
    switch (value) {
        case 'share_redeemable':
            return 100;
        case 'cash_redeemable':
            return 50;
        case 'not_redeemable':
        default:
            return 0;
    }
}

function finiteNonNegative(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

function finiteNonNegativeOrNull(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, value);
}

function finitePositive(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return value;
}

function getLiquidity(
    marketByMint: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined> | undefined,
    mint: string,
): number {
    return finiteNonNegative(marketByMint?.get(mint)?.liquidity);
}

function getVolume(
    marketByMint: ReadonlyMap<string, VariantMarketRankingSnapshot | null | undefined> | undefined,
    mint: string,
): number {
    return finiteNonNegative(marketByMint?.get(mint)?.volume24hUSD);
}

function getMintRank(mintRank: ReadonlyMap<string, number>, mint: string): number {
    return mintRank.get(mint) ?? Number.POSITIVE_INFINITY;
}

function normalizeTier(value: string | null | undefined): LiquidityTier {
    return normalizeLegacyTier(value) ?? 'tier3';
}
