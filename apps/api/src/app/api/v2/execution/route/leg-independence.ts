/**
 * Leg-independence analysis: are the plan's legs actually additive?
 *
 * The allocator prices legs with independent quotes, but live routes showed
 * bitcoin's wBTC/xBTC legs hopping *through* cbBTC pools — executing the
 * split means later legs consume liquidity earlier legs already used, so the
 * headline edge is an upper bound whenever legs overlap. Every quote row
 * carries its per-hop route, so overlap is detectable for free; this module
 * is the pure detector.
 */

import type { ExecutionRouteStep } from '../evaluate/contract';

/**
 * Demo-Titan masks pool addresses as the System Program id. A masked key is
 * *unknown*, never a match — otherwise every demo Titan hop would "share" a
 * pool with every other.
 */
export const UNKNOWN_AMM_KEY = '11111111111111111111111111111111';

export interface LegRouteFacts {
    /** The leg's variant mint. */
    mint: string;
    steps: readonly ExecutionRouteStep[];
}

export interface LegPassThrough {
    legMint: string;
    /** Another leg's variant mint appearing as a hop in this leg's route. */
    viaVariantMint: string;
}

export interface SharedPool {
    ammKey: string;
    label: string | null;
    /** The legs whose routes touch this pool. */
    legMints: string[];
}

export interface LegIndependence {
    independent: boolean;
    passThrough: LegPassThrough[];
    sharedPools: SharedPool[];
}

function isRealAmmKey(ammKey: string | null): ammKey is string {
    return ammKey !== null && ammKey !== '' && ammKey !== UNKNOWN_AMM_KEY;
}

/**
 * Two overlap signals, both from hop data already in hand:
 * - pass-through: a hop's input/output mint is ANOTHER leg's variant mint
 *   (works everywhere — mints are real even when pool ids are masked);
 * - shared pools: the same real ammKey appears in two legs' routes.
 * A leg's own variant mint in its own route is not pass-through.
 */
export function analyzeLegIndependence(args: { legs: LegRouteFacts[] }): LegIndependence {
    const legMints = new Set(args.legs.map(leg => leg.mint));

    const passThrough: LegPassThrough[] = [];
    for (const leg of args.legs) {
        const seenVia = new Set<string>();
        for (const step of leg.steps) {
            for (const hopMint of [step.inputMint, step.outputMint]) {
                if (!hopMint || hopMint === leg.mint) continue;
                if (!legMints.has(hopMint) || seenVia.has(hopMint)) continue;
                seenVia.add(hopMint);
                passThrough.push({ legMint: leg.mint, viaVariantMint: hopMint });
            }
        }
    }

    const legsByPool = new Map<string, { label: string | null; legMints: Set<string> }>();
    for (const leg of args.legs) {
        for (const step of leg.steps) {
            if (!isRealAmmKey(step.ammKey)) continue;
            const entry = legsByPool.get(step.ammKey) ?? { label: step.label, legMints: new Set<string>() };
            entry.legMints.add(leg.mint);
            legsByPool.set(step.ammKey, entry);
        }
    }
    const sharedPools: SharedPool[] = [...legsByPool.entries()]
        .filter(([, entry]) => entry.legMints.size >= 2)
        .map(([ammKey, entry]) => ({ ammKey, label: entry.label, legMints: [...entry.legMints] }));

    return {
        independent: passThrough.length === 0 && sharedPools.length === 0,
        passThrough,
        sharedPools,
    };
}
