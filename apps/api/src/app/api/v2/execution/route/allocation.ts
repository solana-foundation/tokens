/**
 * The split-order allocator: given each variant's probed execution curve,
 * decide how to divide a USD target across variants for the greatest total
 * output.
 *
 * Pure and BigInt-only, tested like comparison.ts — this file produces the
 * product's headline claim ("this split beats the best single variant by X
 * bps"), so the arithmetic must be checkable without an HTTP layer.
 *
 * Method: each variant's output-vs-size function is built from its probe
 * points (impact log-linearly interpolated between rungs, exactly the depth
 * pipeline's idiom), clamped to concavity so marginal output per dollar never
 * increases with size. On concave curves greedy chunk assignment is provably
 * optimal, so the allocator is a greedy loop: give each chunk of the target
 * to whichever variant currently offers the most output for it. Allocation
 * never exceeds a variant's largest successfully probed size — a plan built
 * on extrapolation is speculation dressed as advice.
 */

import type { QuoteProvider } from '../evaluate/comparison';
import type { CurvePoint } from './curve';

/** 1e6 fixed-point ratio scale: 2dp of bps resolution without floats. */
const RATIO_SCALE = 1_000_000n;
const USDC_RAW_PER_DOLLAR = 1_000_000n;

export interface AllocatableVariant {
    variantId: string;
    mint: string;
    symbol: string;
    decimals: number;
    /** Pre-filter recommendation rank; the deterministic tie-break. */
    rank: number;
    /** Successful probe rungs, ascending by size (from buildVariantCurve). */
    points: CurvePoint[];
}

export interface AllocationEngineLeg {
    variantId: string;
    mint: string;
    symbol: string;
    decimals: number;
    amountUsd: number;
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

export interface AllocationEngineResult {
    chunkUsd: number;
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
 * Log-linear impact interpolation between probe rungs (the
 * `interpolateImpactBps` math, kept local so this module stays pure and
 * dependency-free). At or below the smallest rung the impact is that rung's;
 * sizes above the cap are never asked for.
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
    const impactMicro = BigInt(Math.min(999_999, Math.max(0, Math.round(impactAt(variant.impactPoints, sizeUsd) * 100))));
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
}): AllocationEngineResult | null {
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

    const chunkUsd = Math.max(10_000, Math.ceil(args.targetUsd / 50));
    let remaining = args.targetUsd;

    while (remaining > 0) {
        let best: PreparedVariant | null = null;
        let bestStep = 0;
        let bestMarginal = 0n;
        for (const variant of prepared) {
            const capacity = variant.capUsd - variant.allocatedUsd;
            if (capacity <= 0) continue;
            const step = Math.min(chunkUsd, remaining, capacity);
            let marginal = outputAt(variant, variant.allocatedUsd + step) - variant.outAtAllocated;
            if (marginal <= 0n) continue;
            // Concavity clamp: a marginal that beats this variant's own
            // previous per-dollar marginal is a convex kink in the probe data
            // (quote noise, a route unlock). Clamp it so greedy stays optimal;
            // the clamp is surfaced as a warning.
            if (
                variant.lastMarginalPerDollarNum !== null &&
                ratioGreater(marginal, BigInt(step), variant.lastMarginalPerDollarNum, variant.lastMarginalPerDollarDen!)
            ) {
                marginal = (variant.lastMarginalPerDollarNum * BigInt(step)) / variant.lastMarginalPerDollarDen!;
                variant.clamped = true;
            }
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
        if (best === null) break; // every variant capped: probed depth ran out
        best.allocatedUsd += bestStep;
        best.outAtAllocated += bestMarginal;
        best.lastMarginalPerDollarNum = bestMarginal;
        best.lastMarginalPerDollarDen = BigInt(bestStep);
        remaining -= bestStep;
    }

    const legs: AllocationEngineLeg[] = prepared
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
                expectedOutRaw: expectedOutUnitsRaw / scale,
                expectedOutUnitsRaw,
                impactBps: Math.round(impactAt(variant.impactPoints, variant.allocatedUsd) * 100) / 100,
                provider: rungAtOrBelow?.provider ?? variant.source.points[0]!.provider,
            };
        });

    const allocatedUsd = legs.reduce((sum, leg) => sum + leg.amountUsd, 0);
    const totalOutUnitsRaw = legs.reduce((sum, leg) => sum + leg.expectedOutUnitsRaw, 0n);

    // Baselines use exact probe quotes at the full target — the ladder includes
    // T precisely so these are never interpolations.
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
    for (const variant of prepared) {
        const baseline = baselineOf(variant);
        if (baseline && (bestSingleAtTarget === null || baseline.outUnitsRaw > bestSingleAtTarget.outUnitsRaw)) {
            bestSingleAtTarget = baseline;
        }
    }
    const primaryAtTarget = baselineOf(prepared.find(variant => variant.source.rank === 1));

    // Peg spread: max pairwise divergence of base effective prices.
    let pegSpreadBps: number | null = null;
    if (prepared.length >= 2) {
        let maxVariant = prepared[0]!;
        let minVariant = prepared[0]!;
        for (const variant of prepared.slice(1)) {
            if (ratioGreater(variant.effNum, variant.effDen, maxVariant.effNum, maxVariant.effDen)) maxVariant = variant;
            if (ratioGreater(minVariant.effNum, minVariant.effDen, variant.effNum, variant.effDen)) minVariant = variant;
        }
        const ratio = (maxVariant.effNum * minVariant.effDen * RATIO_SCALE) / (maxVariant.effDen * minVariant.effNum);
        pegSpreadBps = Math.round(Number(ratio - RATIO_SCALE)) / 100;
    }

    return {
        chunkUsd,
        allocatedUsd,
        unallocatedUsd: args.targetUsd - allocatedUsd,
        outputUnitDecimals,
        legs,
        totalOutUnitsRaw,
        bestSingleAtTarget,
        primaryAtTarget,
        pegSpreadBps,
        clampedMints: prepared.filter(variant => variant.clamped).map(variant => variant.source.mint),
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
