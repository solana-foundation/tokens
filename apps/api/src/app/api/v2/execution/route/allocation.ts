/**
 * The split-order allocator: given each variant's probed execution curve,
 * decide how to divide a USD target across variants for the greatest total
 * output.
 *
 * Pure and BigInt-only. Each curve is log-linearly interpolated between probe
 * rungs and clamped to concavity, so greedy chunk assignment is optimal;
 * allocation never exceeds a variant's largest successfully probed size.
 */

import type { QuoteProvider } from '../evaluate/comparison';
import type { CurvePoint } from './curve';

/** 1e6 fixed-point ratio scale: 2dp of bps resolution without floats. */
const RATIO_SCALE = 1_000_000n;
const USDC_RAW_PER_DOLLAR = 1_000_000n;

/**
 * Judgment thresholds, per asset category.
 *
 * - `parityDivergenceMaxBps`: the runtime unit-parity gate. Variants of one
 *   asset must trade near one unit price; a base price further than this from
 *   the pool median is a different unit, a broken book, or pricing chaos —
 *   never something to sum with the siblings.
 * - `collapseThresholdBps`: a verification re-quote this far below the
 *   curve's expectation is a collapse (vanished RFQ fill, drained book), and
 *   the repair pass distrusts the whole variant for the request.
 * - `pegWarnBps`: surviving pool spread above this adds a peg_divergence
 *   warning.
 *
 * Hand-set calibration targets (see scripts/route-sweep-baseline.md); never
 * self-adjusting from live data.
 */
export interface TuningProfile {
    profile: string;
    parityDivergenceMaxBps: number;
    collapseThresholdBps: number;
    pegWarnBps: number;
}

export const ALLOCATOR_TUNING: Record<string, TuningProfile> = {
    stablecoin: { profile: 'stablecoin', parityDivergenceMaxBps: 50, collapseThresholdBps: -300, pegWarnBps: 10 },
    crypto: { profile: 'crypto', parityDivergenceMaxBps: 300, collapseThresholdBps: -500, pegWarnBps: 50 },
    commodity: { profile: 'commodity', parityDivergenceMaxBps: 500, collapseThresholdBps: -500, pegWarnBps: 75 },
    equity: { profile: 'equity', parityDivergenceMaxBps: 500, collapseThresholdBps: -750, pegWarnBps: 100 },
    default: { profile: 'default', parityDivergenceMaxBps: 500, collapseThresholdBps: -500, pegWarnBps: 50 },
};

/** Equity parity gates loosen by this factor while the underlying market is closed. */
export const MARKET_CLOSED_PARITY_MULTIPLIER = 2;

/**
 * Above this interpolated impact, the marginal dollar's fate is decided in a
 * region where quotes move fast, so the leg's exact SIZE is guidance rather
 * than a firm number.
 */
export const SHARE_SOFT_IMPACT_BPS = 60;

/**
 * How close two legs' next-dollar marginals must be for the boundary between
 * them to count as a near-tie (fraction of the larger marginal). Structural:
 * greedy equalizes marginals at the optimum, so interior splits are near-tied
 * by construction and quote noise moves the boundary.
 */
export const SHARE_MARGINAL_TIE_TOLERANCE = 0.02;

export type ShareConfidence = 'firm' | 'soft';

/**
 * Is the marginal decision that sized this leg resting on a volatile part of
 * the curve? Evaluates the variant's own interpolated impact at the leg size:
 * deep in a steep region, a small change in the next probe moves the split a
 * lot, so the share is soft. The plan TOTAL stays firm regardless, because
 * verification re-quotes every leg at its final size.
 */
export function shareConfidenceOf(args: {
    points: ReadonlyArray<{ sizeUsd: number; impactBps: number }>;
    legUsd: number;
    /** Any rung lost to a quote error/rate limit rather than a real no-route. */
    depthUncertain?: boolean;
    /** This leg's next-dollar marginal is within a hair of a rival leg's. */
    marginalNearTie?: boolean;
}): ShareConfidence {
    if (args.marginalNearTie || args.depthUncertain) return 'soft';
    if (args.points.length === 0) return 'firm';
    return impactAt(args.points, args.legUsd) > SHARE_SOFT_IMPACT_BPS ? 'soft' : 'firm';
}

export const BLENDED_IMPACT_GRADES = ['excellent', 'good', 'fair', 'poor', 'avoid'] as const;
export type BlendedImpactGrade = (typeof BLENDED_IMPACT_GRADES)[number];

/** Same bands the variant ranking uses, applied to whole-plan impact. */
export function gradeBlendedImpact(blendedImpactBps: number): BlendedImpactGrade {
    if (!Number.isFinite(blendedImpactBps)) return 'avoid';
    if (blendedImpactBps <= 10) return 'excellent';
    if (blendedImpactBps <= 50) return 'good';
    if (blendedImpactBps <= 150) return 'fair';
    if (blendedImpactBps <= 500) return 'poor';
    return 'avoid';
}

/** NYSE regular session, 9:30–16:00 ET, Mon–Fri. Holidays deliberately ignored (conservative: treated as open). */
export function isUsMarketOpen(now: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    const weekday = get('weekday');
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Category-selected profile, with the off-hours multiplier applied for equities. */
export function resolveTuningProfile(args: { category: string; now: Date }): {
    tuning: TuningProfile;
    marketClosedMultiplierApplied: boolean;
} {
    const base = ALLOCATOR_TUNING[args.category] ?? ALLOCATOR_TUNING.default!;
    if (args.category === 'equity' && !isUsMarketOpen(args.now)) {
        return {
            tuning: {
                ...base,
                parityDivergenceMaxBps: base.parityDivergenceMaxBps * MARKET_CLOSED_PARITY_MULTIPLIER,
            },
            marketClosedMultiplierApplied: true,
        };
    }
    return { tuning: base, marketClosedMultiplierApplied: false };
}

export interface AllocatableVariant {
    variantId: string;
    mint: string;
    symbol: string;
    decimals: number;
    /** Pre-filter recommendation rank; the deterministic tie-break. */
    rank: number;
    /** Successful probe rungs, ascending by size (from buildVariantCurve). */
    points: CurvePoint[];
    /**
     * True when a rung failed for a reason other than 'no_route' (a quote
     * error or rate limit), so this variant's proven depth is an artifact of
     * coverage rather than the market.
     */
    depthUncertain?: boolean;
}

export interface AllocationEngineLeg {
    variantId: string;
    mint: string;
    symbol: string;
    decimals: number;
    amountUsd: number;
    /** Whether the marginal decision that sized this leg is on stable curve. */
    shareConfidence: ShareConfidence;
    /** Interpolated expected output in the variant's own decimals. */
    expectedOutRaw: bigint;
    /** The same output normalized to outputUnitDecimals. */
    expectedOutUnitsRaw: bigint;
    /** Interpolated impact at the leg's full size, vs the variant's own base. */
    impactBps: number;
    /** Provider of the largest probe rung at or below the leg size. */
    provider: QuoteProvider | null;
}

export interface AllocationBaseline {
    variantId: string;
    mint: string;
    symbol: string;
    /** Exact probe output at the full target, normalized to the output unit. */
    outUnitsRaw: bigint;
}

export interface EjectedVariant {
    mint: string;
    symbol: string;
    /** |basePrice / poolMedian − 1| in bps. */
    divergenceBps: number;
}

export interface AllocationEngineResult {
    chunkUsd: number;
    /** Legs below this were folded into siblings (unless nothing had room). */
    minLegUsd: number;
    allocatedUsd: number;
    unallocatedUsd: number;
    outputUnitDecimals: number;
    legs: AllocationEngineLeg[];
    totalOutUnitsRaw: bigint;
    /** Best single variant's exact quote at the full target (ladder includes T). */
    bestSingleAtTarget: AllocationBaseline | null;
    /** The rank-1 variant's exact quote at the full target. */
    primaryAtTarget: AllocationBaseline | null;
    /** Max pairwise divergence of base effective prices, bps (2dp). */
    pegSpreadBps: number | null;
    /** Mints whose curves needed a concavity clamp. */
    clampedMints: string[];
    /** Pool variants ejected by the parity-divergence gate (never allocated). */
    ejected: EjectedVariant[];
    /** Base-price divergence vs the pool median for every surviving variant. */
    divergenceBpsByMint: Record<string, number>;
}

interface PreparedVariant {
    source: AllocatableVariant;
    /** Base effective price as a rational: outUnits per USDC raw. */
    effNum: bigint;
    effDen: bigint;
    capUsd: number;
    /** (sizeUsd, impactBps) pairs ascending, for interpolation. */
    impactPoints: Array<{ sizeUsd: number; impactBps: number }>;
    allocatedUsd: number;
    /** Output at the current allocation, memoized for marginal computation. */
    outAtAllocated: bigint;
    lastMarginalPerDollarNum: bigint | null;
    lastMarginalPerDollarDen: bigint | null;
    clamped: boolean;
}

/**
 * Log-linear impact interpolation between probe rungs. At or below the
 * smallest rung the impact is that rung's; sizes above the cap are never
 * asked for.
 */
function impactAt(points: ReadonlyArray<{ sizeUsd: number; impactBps: number }>, sizeUsd: number): number {
    const first = points[0]!;
    if (sizeUsd <= first.sizeUsd) return first.impactBps;
    for (let i = 0; i < points.length - 1; i += 1) {
        const lo = points[i]!;
        const hi = points[i + 1]!;
        if (sizeUsd <= hi.sizeUsd) {
            const span = Math.log(hi.sizeUsd) - Math.log(lo.sizeUsd);
            if (span <= 0) return hi.impactBps;
            const t = (Math.log(sizeUsd) - Math.log(lo.sizeUsd)) / span;
            return lo.impactBps + (hi.impactBps - lo.impactBps) * t;
        }
    }
    return points[points.length - 1]!.impactBps;
}

/** Expected output (in output-unit raw) of putting `sizeUsd` into a variant. */
function outputAt(variant: PreparedVariant, sizeUsd: number): bigint {
    if (sizeUsd <= 0) return 0n;
    const impactMicro = BigInt(
        Math.min(999_999, Math.max(0, Math.round(impactAt(variant.impactPoints, sizeUsd) * 100))),
    );
    const usdcRaw = BigInt(sizeUsd) * USDC_RAW_PER_DOLLAR;
    return (usdcRaw * variant.effNum * (RATIO_SCALE - impactMicro)) / (variant.effDen * RATIO_SCALE);
}

/** a/b > c/d without division. */
function ratioGreater(aNum: bigint, aDen: bigint, bNum: bigint, bDen: bigint): boolean {
    return aNum * bDen > bNum * aDen;
}

export function computeAllocation(args: {
    targetUsd: number;
    variants: AllocatableVariant[];
    tuning?: TuningProfile;
}): AllocationEngineResult | null {
    const tuning = args.tuning ?? ALLOCATOR_TUNING.default!;
    const usable = args.variants.filter(variant => variant.points.length > 0);
    if (usable.length === 0) return null;

    const outputUnitDecimals = Math.max(...usable.map(variant => variant.decimals));

    const prepared: PreparedVariant[] = usable.map(variant => {
        const scale = 10n ** BigInt(outputUnitDecimals - variant.decimals);
        const base = variant.points[0]!;
        return {
            source: variant,
            effNum: base.outRaw * scale,
            effDen: base.inRaw,
            capUsd: variant.points[variant.points.length - 1]!.sizeUsd,
            impactPoints: variant.points.map(point => ({ sizeUsd: point.sizeUsd, impactBps: point.impactBps })),
            allocatedUsd: 0,
            outAtAllocated: 0n,
            lastMarginalPerDollarNum: null,
            lastMarginalPerDollarDen: null,
            clamped: false,
        };
    });

    // Runtime unit-parity gate. Divergence is directionless: always the larger
    // price over the smaller.
    const divergenceBps = (a: PreparedVariant, b: PreparedVariant): number => {
        const aOverB = a.effNum * b.effDen;
        const bOverA = b.effNum * a.effDen;
        const [hi, lo] = aOverB >= bOverA ? [aOverB, bOverA] : [bOverA, aOverB];
        if (lo === 0n) return Number.POSITIVE_INFINITY;
        const ratio = (hi * RATIO_SCALE) / lo;
        return Math.round(Number(ratio - RATIO_SCALE)) / 100;
    };
    const ejected: EjectedVariant[] = [];
    const divergenceBpsByMint: Record<string, number> = {};
    let pool: PreparedVariant[] = prepared;
    if (prepared.length === 2) {
        // Two variants cannot tell us which one is the outlier: gate loosens
        // to 2x, tie-break prefers an exact target-rung quote, then rank.
        const [first, second] = prepared;
        const mutual = divergenceBps(first!, second!);
        divergenceBpsByMint[first!.source.mint] = mutual;
        divergenceBpsByMint[second!.source.mint] = mutual;
        if (mutual > 2 * tuning.parityDivergenceMaxBps) {
            const hasTarget = (variant: PreparedVariant) =>
                variant.source.points.some(point => point.sizeUsd === args.targetUsd);
            const keepFirst =
                hasTarget(first!) !== hasTarget(second!)
                    ? hasTarget(first!)
                    : first!.source.rank <= second!.source.rank;
            const loser = keepFirst ? second! : first!;
            ejected.push({ mint: loser.source.mint, symbol: loser.source.symbol, divergenceBps: mutual });
            pool = prepared.filter(variant => variant !== loser);
            delete divergenceBpsByMint[loser.source.mint];
        }
    } else if (prepared.length >= 3) {
        const byPrice = [...prepared].sort((a, b) => (ratioGreater(a.effNum, a.effDen, b.effNum, b.effDen) ? 1 : -1));
        // The median element is its own reference (divergence 0), so at least
        // one variant always survives the gate.
        const median = byPrice[Math.floor(byPrice.length / 2)]!;
        pool = [];
        for (const variant of prepared) {
            const deviation = divergenceBps(variant, median);
            if (deviation > tuning.parityDivergenceMaxBps) {
                ejected.push({ mint: variant.source.mint, symbol: variant.source.symbol, divergenceBps: deviation });
            } else {
                divergenceBpsByMint[variant.source.mint] = deviation;
                pool.push(variant);
            }
        }
    } else {
        divergenceBpsByMint[prepared[0]!.source.mint] = 0;
    }

    const chunkUsd = Math.max(10_000, Math.ceil(args.targetUsd / 50));
    let remaining = args.targetUsd;

    while (remaining > 0) {
        let best: PreparedVariant | null = null;
        let bestStep = 0;
        let bestMarginal = 0n;
        for (const variant of pool) {
            const capacity = variant.capUsd - variant.allocatedUsd;
            if (capacity <= 0) continue;
            const step = Math.min(chunkUsd, remaining, capacity);
            let marginal = outputAt(variant, variant.allocatedUsd + step) - variant.outAtAllocated;
            if (marginal <= 0n) continue;
            // Concavity clamp: a convex kink in the probe data would break
            // greedy optimality, so cap at the previous per-dollar marginal.
            if (
                variant.lastMarginalPerDollarNum !== null &&
                ratioGreater(
                    marginal,
                    BigInt(step),
                    variant.lastMarginalPerDollarNum,
                    variant.lastMarginalPerDollarDen!,
                )
            ) {
                marginal = (variant.lastMarginalPerDollarNum * BigInt(step)) / variant.lastMarginalPerDollarDen!;
                variant.clamped = true;
            }
            const better =
                best === null ||
                ratioGreater(marginal, BigInt(step), bestMarginal, BigInt(bestStep)) ||
                (marginal * BigInt(bestStep) === bestMarginal * BigInt(step) && variant.source.rank < best.source.rank);
            if (better) {
                best = variant;
                bestStep = step;
                bestMarginal = marginal;
            }
        }
        if (best === null) break; // every variant capped: probed depth ran out
        best.allocatedUsd += bestStep;
        best.outAtAllocated += bestMarginal;
        best.lastMarginalPerDollarNum = bestMarginal;
        best.lastMarginalPerDollarDen = BigInt(bestStep);
        remaining -= bestStep;
    }

    // Dust-leg suppression: fold sub-2-chunk legs into the best sibling with
    // room; keep them only when nothing has room (dust beats under-filling).
    const minLegUsd = Math.min(chunkUsd * 2, args.targetUsd);
    const dustVariants = pool
        .filter(variant => variant.allocatedUsd > 0 && variant.allocatedUsd < minLegUsd)
        .sort((a, b) => a.allocatedUsd - b.allocatedUsd);
    for (const dust of dustVariants) {
        const receivers = pool.filter(variant => variant !== dust && variant.allocatedUsd > 0);
        const roomElsewhere = receivers.reduce(
            (sum, variant) => sum + Math.max(0, variant.capUsd - variant.allocatedUsd),
            0,
        );
        if (roomElsewhere < dust.allocatedUsd) continue;
        let toMove = dust.allocatedUsd;
        while (toMove > 0) {
            let best: PreparedVariant | null = null;
            let bestStep = 0;
            let bestMarginal = 0n;
            for (const variant of receivers) {
                const capacity = variant.capUsd - variant.allocatedUsd;
                if (capacity <= 0) continue;
                const step = Math.min(chunkUsd, toMove, capacity);
                const marginal = outputAt(variant, variant.allocatedUsd + step) - variant.outAtAllocated;
                // Zero-marginal moves are deliberate: concentration beats dust.
                const better =
                    best === null ||
                    ratioGreater(marginal, BigInt(step), bestMarginal, BigInt(bestStep)) ||
                    (marginal * BigInt(bestStep) === bestMarginal * BigInt(step) &&
                        variant.source.rank < best.source.rank);
                if (better) {
                    best = variant;
                    bestStep = step;
                    bestMarginal = marginal;
                }
            }
            if (best === null) break;
            best.allocatedUsd += bestStep;
            best.outAtAllocated += bestMarginal;
            toMove -= bestStep;
        }
        if (toMove === 0) {
            dust.allocatedUsd = 0;
            dust.outAtAllocated = 0n;
        }
        // A partial move cannot happen (roomElsewhere was checked), but if a
        // future edit breaks that, the invariant Σ legs == allocated still
        // holds because the moved chunks were added to receivers.
    }

    // Legs whose next-dollar marginals near-tie share an arbitrary boundary.
    const marginalPerDollar = (variant: PreparedVariant): number => {
        const capacity = variant.capUsd - variant.allocatedUsd;
        const step = Math.min(chunkUsd, Math.max(1, capacity));
        if (capacity <= 0) return 0;
        const delta = outputAt(variant, variant.allocatedUsd + step) - variant.outAtAllocated;
        return delta <= 0n ? 0 : Number(delta) / step;
    };
    const allocated = pool.filter(variant => variant.allocatedUsd > 0);
    const marginalByMint = new Map(allocated.map(variant => [variant.source.mint, marginalPerDollar(variant)]));
    const nearTieMints = new Set<string>();
    for (const variant of allocated) {
        const own = marginalByMint.get(variant.source.mint) ?? 0;
        if (own <= 0) continue;
        for (const other of allocated) {
            if (other === variant) continue;
            const rival = marginalByMint.get(other.source.mint) ?? 0;
            if (rival <= 0) continue;
            const larger = Math.max(own, rival);
            if (Math.abs(own - rival) / larger <= SHARE_MARGINAL_TIE_TOLERANCE) {
                nearTieMints.add(variant.source.mint);
                break;
            }
        }
    }

    const legs: AllocationEngineLeg[] = pool
        .filter(variant => variant.allocatedUsd > 0)
        .sort((a, b) => b.allocatedUsd - a.allocatedUsd || a.source.rank - b.source.rank)
        .map(variant => {
            const scale = 10n ** BigInt(outputUnitDecimals - variant.source.decimals);
            const expectedOutUnitsRaw = variant.outAtAllocated;
            const rungAtOrBelow = [...variant.source.points]
                .reverse()
                .find(point => point.sizeUsd <= variant.allocatedUsd);
            return {
                variantId: variant.source.variantId,
                mint: variant.source.mint,
                symbol: variant.source.symbol,
                decimals: variant.source.decimals,
                amountUsd: variant.allocatedUsd,
                shareConfidence: shareConfidenceOf({
                    points: variant.impactPoints,
                    legUsd: variant.allocatedUsd,
                    depthUncertain: variant.source.depthUncertain,
                    marginalNearTie: nearTieMints.has(variant.source.mint),
                }),
                expectedOutRaw: expectedOutUnitsRaw / scale,
                expectedOutUnitsRaw,
                impactBps: Math.round(impactAt(variant.impactPoints, variant.allocatedUsd) * 100) / 100,
                provider: rungAtOrBelow?.provider ?? variant.source.points[0]!.provider,
            };
        });

    const allocatedUsd = legs.reduce((sum, leg) => sum + leg.amountUsd, 0);
    const totalOutUnitsRaw = legs.reduce((sum, leg) => sum + leg.expectedOutUnitsRaw, 0n);

    // Baselines use exact probe quotes at the full target, never interpolations.
    const baselineOf = (variant: PreparedVariant | undefined): AllocationBaseline | null => {
        if (!variant) return null;
        const point = variant.source.points.find(p => p.sizeUsd === args.targetUsd);
        if (!point) return null;
        const scale = 10n ** BigInt(outputUnitDecimals - variant.source.decimals);
        return {
            variantId: variant.source.variantId,
            mint: variant.source.mint,
            symbol: variant.source.symbol,
            outUnitsRaw: point.outRaw * scale,
        };
    };
    let bestSingleAtTarget: AllocationBaseline | null = null;
    for (const variant of pool) {
        const baseline = baselineOf(variant);
        if (baseline && (bestSingleAtTarget === null || baseline.outUnitsRaw > bestSingleAtTarget.outUnitsRaw)) {
            bestSingleAtTarget = baseline;
        }
    }
    const primaryAtTarget = baselineOf(pool.find(variant => variant.source.rank === 1) ?? pool[0]);

    // Peg spread: max pairwise divergence of surviving base effective prices.
    let pegSpreadBps: number | null = null;
    if (pool.length >= 2) {
        let maxVariant = pool[0]!;
        let minVariant = pool[0]!;
        for (const variant of pool.slice(1)) {
            if (ratioGreater(variant.effNum, variant.effDen, maxVariant.effNum, maxVariant.effDen))
                maxVariant = variant;
            if (ratioGreater(minVariant.effNum, minVariant.effDen, variant.effNum, variant.effDen))
                minVariant = variant;
        }
        const ratio = (maxVariant.effNum * minVariant.effDen * RATIO_SCALE) / (maxVariant.effDen * minVariant.effNum);
        pegSpreadBps = Math.round(Number(ratio - RATIO_SCALE)) / 100;
    }

    return {
        chunkUsd,
        minLegUsd,
        allocatedUsd,
        unallocatedUsd: args.targetUsd - allocatedUsd,
        outputUnitDecimals,
        legs,
        totalOutUnitsRaw,
        bestSingleAtTarget,
        primaryAtTarget,
        pegSpreadBps,
        clampedMints: pool.filter(variant => variant.clamped).map(variant => variant.source.mint),
        ejected,
        divergenceBpsByMint,
    };
}

/** Edge of the plan over a baseline: bps and USD via the buy-side shortfall formula. */
export function computeAllocationEdge(args: {
    planOutUnitsRaw: bigint;
    baselineOutUnitsRaw: bigint;
    targetUsd: number;
}): { outAmountDiffRaw: bigint; bps: number; usd: number } | null {
    if (args.baselineOutUnitsRaw <= 0n || args.planOutUnitsRaw <= 0n) return null;
    const diff = args.planOutUnitsRaw - args.baselineOutUnitsRaw;
    const ratio = (args.planOutUnitsRaw * RATIO_SCALE) / args.baselineOutUnitsRaw - RATIO_SCALE;
    const bps = Number(ratio) / 100;
    const shortfall = 1 - Number((args.baselineOutUnitsRaw * RATIO_SCALE) / args.planOutUnitsRaw) / Number(RATIO_SCALE);
    return {
        outAmountDiffRaw: diff,
        bps,
        usd: Math.round(args.targetUsd * shortfall * 100) / 100,
    };
}
