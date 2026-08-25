/**
 * The public response contract for GET /v2/execution/route — the asset-level
 * execution product: quote every variant of one canonical asset, then (where
 * unit parity holds) split the order across variants for the best total fill.
 *
 * Import-free apart from the evaluate contract (itself import-free) so
 * consumers outside this app can `import type` it by path, exactly like the
 * evaluate contract. The route annotates its return value with
 * `ExecutionRouteResponse`, so drift here is a compile error.
 */

import type { ExecutionQuoteAmount, ExecutionQuoteRow, ProviderStat, QuoteProvider } from '../evaluate/contract';

export const ROUTING_VERSION = 'variant-route-v1';
export const ALLOCATION_VERSION = 'allocation-v1';

/**
 * Why a variant is (or is not) allowed into the allocation pool.
 * - `kind`: provable 1:1 exposure to the underlying (native/wrapped/bridged).
 * - `issuer_assertion`: tokenized equity where 1 token = 1 share is the
 *   issuer's claim (redeemable tiers only), not something our data proves.
 * - `none`: compared but never allocated (derivative kinds, non-redeemable
 *   claims, unknown units).
 */
export type ParityBasis = 'kind' | 'issuer_assertion' | 'none';

/** Why a registry variant was not quoted at all. */
export type VariantExclusionReason =
    | 'non_spot_like'
    | 'excluded_by_activity_filter'
    | 'below_liquidity_floor'
    | 'beyond_max_variants'
    | 'not_redeemable'
    | 'missing_decimals';

export interface ExcludedVariant {
    variantId: string;
    mint: string;
    symbol: string | null;
    kind: string;
    issuer: string | null;
    reason: VariantExclusionReason;
}

export interface VariantCurveRung {
    sizeUsd: number;
    /**
     * Derived against this variant's own smallest successful rung — the
     * source-agnostic impact that makes Titan (no impact field) and Jupiter
     * comparable. Null when the rung failed.
     */
    impactBps: number | null;
    /** Provider whose quote won this rung; null when the rung failed. */
    provider: QuoteProvider | null;
}

export interface RoutedVariantMarket {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
}

export interface RoutedVariant {
    variantId: string;
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    kind: string;
    issuer: string | null;
    stockVariantTier: string | null;
    /** Pre-filter recommendation rank (1-based) from the registry ranking. */
    rank: number;
    parityBasis: ParityBasis;
    /** In the allocation pool: parityBasis !== 'none' and the curve is usable. */
    allocationEligible: boolean;
    market: RoutedVariantMarket | null;
    /** Same row shape as /v2/execution/evaluate — one row per probe rung. */
    quotes: ExecutionQuoteRow[];
    curve: {
        /**
         * Output tokens per input USDC at the smallest successful rung — the
         * peg signal. Variants that look cheap here are cheap for a reason.
         */
        baseEffectivePrice: string | null;
        rungs: VariantCurveRung[];
        /** Largest successfully quoted size; allocation never exceeds it. */
        maxProvenSizeUsd: number | null;
        /**
         * Base-price divergence vs the allocation pool's median, bps
         * (directionless). Above the parity gate (500bps) the variant is
         * ejected from the pool — `allocationEligible: false` plus a
         * `price_divergence_excluded:<mint>` warning — because a sibling at a
         * different unit price is a different unit, a broken book, or both.
         * Null when the variant never entered the pool.
         */
        parityDivergenceBps: number | null;
    };
}

export interface AllocationLegVerification {
    status: 'verified' | 'interpolated';
    /**
     * Verified output vs the curve's interpolated expectation, bps. The
     * interpolation error made visible. Null when verification failed and the
     * leg keeps its interpolated numbers.
     */
    deltaBps: number | null;
    quotedAt: string;
}

export interface AllocationLeg {
    variantId: string;
    mint: string;
    symbol: string;
    /** Whole dollars; legs sum to targetUsd exactly. */
    amountUsd: string;
    /** Raw USDC (6dp). */
    amountUsdRaw: string;
    /** 0..1, rounded to 4dp. */
    shareOfTarget: number;
    provider: QuoteProvider | null;
    expectedOut: ExecutionQuoteAmount | null;
    effectivePrice: string | null;
    /** Vs this variant's own base price, bps. */
    impactBps: number | null;
    /** Provider-internal router that filled the verification quote (e.g. Jupiter's jupiterz RFQ). */
    router: string | null;
    verification: AllocationLegVerification;
}

export interface AllocationEdge {
    baselineVariantId: string;
    baselineMint: string;
    baselineSymbol: string;
    /** In outputUnit decimals. */
    outAmountDiffRaw: string;
    outAmountDiff: string;
    bps: number;
    usd: number;
}

export interface AllocationPlan {
    version: typeof ALLOCATION_VERSION;
    targetUsd: string;
    allocatedUsd: string;
    /** '0' unless probed depth ran out before the target was filled. */
    unallocatedUsd: string;
    chunkUsd: number;
    /**
     * Dust floor: legs below this (two chunks) are folded into siblings with
     * room — a single-chunk win is within quote noise and costs a whole extra
     * transaction. A below-floor leg can still appear when no sibling had
     * capacity, because dust beats under-filling the target.
     */
    minLegUsd: number;
    /**
     * True when a collapsed verification (re-quote > 500bps below the curve's
     * expectation) triggered the one-shot repair: the collapsed variant is
     * distrusted for this request — its own re-quote contradicted its probe
     * curve — ejected from the pool, and the allocation re-derived with only
     * the changed legs re-verified. Accompanied by plan_repaired:<mint>
     * warnings. Exactly one repair per request — a second collapse ships with
     * its honest delta instead of starting a loop.
     */
    repaired: boolean;
    legs: AllocationLeg[];
    /** All leg outputs are normalized to this unit before summing. */
    outputUnit: { symbol: string; decimals: number };
    totalExpectedOut: { amount: string; rawAmount: string } | null;
    edge: {
        /** Plan vs the single best variant's exact quote at the full target. */
        vsBestSingleVariant: AllocationEdge | null;
        /** Plan vs what a naive caller would trade: the rank-1 variant. */
        vsPrimaryVariant: AllocationEdge | null;
    };
    /** Max pairwise divergence of baseEffectivePrice among pool variants, bps. */
    pegSpreadBps: number | null;
}

export type AllocationStatus = 'ok' | 'not_requested' | 'no_eligible_variants' | 'insufficient_quotes';

export interface ExecutionRouteMeta {
    assetId: string;
    category: string;
    side: 'buy';
    targetUsd: string;
    probeLadderUsd: number[];
    maxVariants: number;
    selectedVariants: number;
    excludedVariants: ExcludedVariant[];
    /** Honest cost echo: probe quotes plus verification quotes actually spent. */
    upstreamQuotes: number;
    providerStats: Record<QuoteProvider, ProviderStat>;
    tieBreak: QuoteProvider;
    routingVersion: typeof ROUTING_VERSION;
    comparisonVersion: string;
    warnings: string[];
}

export interface ExecutionRouteResponse {
    assetId: string;
    providers: readonly QuoteProvider[];
    /** Pre-filter rank order; index 0 is the primary variant. */
    variants: RoutedVariant[];
    allocationStatus: AllocationStatus;
    /** Non-null iff allocationStatus === 'ok'. */
    allocation: AllocationPlan | null;
    meta: ExecutionRouteMeta;
}
