import { describe, expect, it } from 'bun:test';

import type { CurvePoint } from './curve';

import { computeAllocation, computeAllocationEdge, type AllocatableVariant } from './allocation';

/** Probe points for a variant priced at `basePrice` out-per-dollar with linear-ish impact growth. */
function pointsFor(args: {
    sizes: number[];
    baseOutPerDollar: number;
    impactBpsAt: (sizeUsd: number) => number;
    decimals?: number;
    provider?: 'jupiter' | 'titan';
}): CurvePoint[] {
    const decimals = args.decimals ?? 8;
    return args.sizes.map(sizeUsd => {
        const inRaw = BigInt(sizeUsd) * 1_000_000n;
        const impact = args.impactBpsAt(sizeUsd);
        const gross = args.baseOutPerDollar * sizeUsd * 10 ** decimals;
        const outRaw = BigInt(Math.round(gross * (1 - impact / 10_000)));
        return { sizeUsd, inRaw, outRaw, provider: args.provider ?? 'jupiter', impactBps: impact };
    });
}

function variant(id: string, rank: number, points: CurvePoint[], decimals = 8): AllocatableVariant {
    return { variantId: `asset:${id}`, mint: `${id}Mint`, symbol: id, decimals, rank, points };
}

const LADDER = [8_000, 40_000, 200_000, 1_000_000];

describe('computeAllocation', () => {
    it('splits toward the flatter curve and beats the best single variant', () => {
        // A: cheap at small size, steep impact. B: slightly worse base, flat curve.
        const a = variant('cbBTC', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.00001, impactBpsAt: s => s / 2_000 }));
        const b = variant('wBTC', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.0000099, impactBpsAt: s => s / 20_000 }));
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [a, b] })!;

        expect(result.allocatedUsd).toBe(1_000_000);
        expect(result.unallocatedUsd).toBe(0);
        expect(result.legs.length).toBe(2);
        // Sum of legs is exact — the rounding invariant.
        expect(result.legs.reduce((sum, leg) => sum + leg.amountUsd, 0)).toBe(1_000_000);

        // The plan must beat the best single variant (single-variant is a
        // feasible allocation, so this is optimality's weakest corollary).
        expect(result.bestSingleAtTarget).not.toBeNull();
        expect(result.totalOutUnitsRaw >= result.bestSingleAtTarget!.outUnitsRaw).toBe(true);
        const edge = computeAllocationEdge({
            planOutUnitsRaw: result.totalOutUnitsRaw,
            baselineOutUnitsRaw: result.bestSingleAtTarget!.outUnitsRaw,
            targetUsd: 1_000_000,
        })!;
        expect(edge.bps).toBeGreaterThanOrEqual(0);
    });

    it('matches brute force on concave two-variant fixtures', () => {
        const a = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: s => s / 1_500 }));
        const b = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.00098, impactBpsAt: s => s / 9_000 }));
        const target = 1_000_000;
        const result = computeAllocation({ targetUsd: target, variants: [a, b] })!;

        // Brute force over every whole-chunk split, using the engine itself to
        // price each side (same curve model, so this isolates the greedy step).
        const chunk = result.chunkUsd;
        let bruteBest = -1n;
        for (let usdA = 0; usdA <= target; usdA += chunk) {
            const usdB = target - usdA;
            const outA = usdA > 0 ? computeAllocation({ targetUsd: usdA, variants: [a] })!.totalOutUnitsRaw : 0n;
            const outB = usdB > 0 ? computeAllocation({ targetUsd: usdB, variants: [b] })!.totalOutUnitsRaw : 0n;
            if (outA + outB > bruteBest) bruteBest = outA + outB;
        }
        // Greedy must be within one chunk's worth of brute force (identical in
        // the common case; the tolerance covers boundary rounding).
        const tolerance = (bruteBest * 5n) / 10_000n; // 5bps
        expect(result.totalOutUnitsRaw >= bruteBest - tolerance).toBe(true);
    });

    it('caps every variant at its largest probed size and reports the shortfall', () => {
        // Both variants only probed successfully to $200k; target is $1M.
        const shallow = [8_000, 40_000, 200_000];
        const a = variant('A', 1, pointsFor({ sizes: shallow, baseOutPerDollar: 0.001, impactBpsAt: s => s / 5_000 }));
        const b = variant('B', 2, pointsFor({ sizes: shallow, baseOutPerDollar: 0.001, impactBpsAt: s => s / 5_000 }));
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [a, b] })!;
        expect(result.allocatedUsd).toBe(400_000);
        expect(result.unallocatedUsd).toBe(600_000);
        for (const leg of result.legs) expect(leg.amountUsd).toBeLessThanOrEqual(200_000);
        // No exact $1M probe exists, so there is no single-variant baseline.
        expect(result.bestSingleAtTarget).toBeNull();
    });

    it('degenerates to a single leg when one variant dominates everywhere', () => {
        const strong = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const weak = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.0005, impactBpsAt: s => s / 1_000 }));
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [strong, weak] })!;
        expect(result.legs.length).toBe(1);
        expect(result.legs[0]!.symbol).toBe('A');
        expect(result.legs[0]!.amountUsd).toBe(1_000_000);
    });

    it('returns null when no variant has a usable curve', () => {
        expect(computeAllocation({ targetUsd: 1_000_000, variants: [variant('A', 1, [])] })).toBeNull();
    });

    it('normalizes mixed decimals into a shared output unit', () => {
        // Same economics, different decimals: legs must be comparable and summable.
        const a = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: s => s / 4_000, decimals: 6 }), 6);
        const b = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: s => s / 4_000, decimals: 9 }), 9);
        const result = computeAllocation({ targetUsd: 400_000, variants: [a, b] })!;
        expect(result.outputUnitDecimals).toBe(9);
        // Identical curves: the split should be roughly even.
        const [first, second] = result.legs;
        expect(Math.abs(first!.amountUsd - second!.amountUsd)).toBeLessThanOrEqual(result.chunkUsd);
        // Own-decimals output back-converts from the unit value exactly.
        for (const leg of result.legs) {
            const scale = 10n ** BigInt(9 - leg.decimals);
            expect(leg.expectedOutUnitsRaw / scale).toBe(leg.expectedOutRaw);
        }
    });

    it('clamps convex kinks and reports the clamp', () => {
        // A convex curve: impact IMPROVES at size (quote noise / a route
        // unlock). A single variant forces greedy to walk through the kink,
        // where the rising per-dollar marginal must be clamped, not believed.
        const kinked = variant(
            'A',
            1,
            pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: s => (s === 1_000_000 ? 0 : s / 2_000) }),
        );
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [kinked] })!;
        expect(result.clampedMints).toContain('AMint');
        expect(result.allocatedUsd).toBe(1_000_000);
        // The clamped plan's expected output must not exceed what the raw
        // convex curve would have promised at the same size.
        const rawCurvePromise = 1_000_000 * 0.001 * 10 ** 8; // impact 0 at T
        expect(result.totalOutUnitsRaw < BigInt(rawCurvePromise)).toBe(true);
    });

    it('reports peg spread across variants base prices', () => {
        const rich = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        // 1% cheaper base price: ~100bps spread.
        const cheap = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.00101, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 100_000, variants: [rich, cheap] })!;
        expect(result.pegSpreadBps).toBeGreaterThan(95);
        expect(result.pegSpreadBps).toBeLessThan(105);
    });
});

describe('computeAllocationEdge', () => {
    it('computes bps and usd from BigInt outputs', () => {
        const edge = computeAllocationEdge({
            planOutUnitsRaw: 10_050_000n,
            baselineOutUnitsRaw: 10_000_000n,
            targetUsd: 1_000_000,
        })!;
        expect(edge.bps).toBeCloseTo(50, 0);
        // usd = T * (1 - baseline/plan) ≈ $4,975
        expect(edge.usd).toBeGreaterThan(4_900);
        expect(edge.usd).toBeLessThan(5_050);
        expect(edge.outAmountDiffRaw).toBe(50_000n);
    });

    it('returns null when a baseline is missing or zero', () => {
        expect(
            computeAllocationEdge({ planOutUnitsRaw: 1n, baselineOutUnitsRaw: 0n, targetUsd: 1 }),
        ).toBeNull();
    });
});

describe('parity divergence ejection (A)', () => {
    it('ejects a 10x-priced sibling from the pool and reports it', () => {
        // Three 1-oz golds at ~0.0003 oz/$ and one 1/10-oz ETF wrapper whose
        // token is 10x the price (10x fewer tokens per dollar).
        const oneOz = (id: string, rank: number, base: number) =>
            variant(id, rank, pointsFor({ sizes: LADDER, baseOutPerDollar: base, impactBpsAt: s => s / 10_000 }));
        const result = computeAllocation({
            targetUsd: 1_000_000,
            variants: [
                oneOz('XAUT', 1, 0.0003),
                oneOz('PAXG', 2, 0.000299),
                oneOz('XAUM', 3, 0.000301),
                oneOz('GLDw', 4, 0.00003),
            ],
        })!;
        expect(result.ejected.map(entry => entry.mint)).toEqual(['GLDwMint']);
        expect(result.ejected[0]!.divergenceBps).toBeGreaterThan(80_000);
        expect(result.legs.some(leg => leg.mint === 'GLDwMint')).toBe(false);
        // Peg spread reports the surviving pool, not the handled outlier.
        expect(result.pegSpreadBps).not.toBeNull();
        expect(result.pegSpreadBps!).toBeLessThan(500);
        // Survivors carry their (small) divergence for disclosure.
        expect(result.divergenceBpsByMint['XAUTMint']).toBeLessThan(500);
    });

    it('keeps a two-variant pair inside the mutual tolerance', () => {
        const a = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const b = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.00095, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [a, b] })!;
        expect(result.ejected).toEqual([]);
    });

    it('with two variants far apart, ejects the lower-ranked one', () => {
        // 50% apart: cannot tell which is broken; rank breaks the tie.
        const a = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const b = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.0005, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 1_000_000, variants: [a, b] })!;
        expect(result.ejected.map(entry => entry.mint)).toEqual(['BMint']);
        expect(result.legs.every(leg => leg.mint === 'AMint')).toBe(true);
    });

    it('never ejects everything: the median element always survives', () => {
        const a = variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const b = variant('B', 2, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.1, impactBpsAt: () => 0 }));
        const c = variant('C', 3, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.00001, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 100_000, variants: [a, b, c] })!;
        expect(result.legs.length).toBeGreaterThan(0);
        expect(result.ejected.length).toBe(2);
    });
});

describe('dust-leg suppression (E)', () => {
    // B wins exactly the first $20k chunk (cheapest shallow region) and then
    // loses every later marginal — the bitcoin-sweep dust pattern.
    const dustPair = () => [
        variant('A', 1, pointsFor({ sizes: LADDER, baseOutPerDollar: 0.001, impactBpsAt: () => 250 })),
        variant(
            'B',
            2,
            pointsFor({
                sizes: LADDER,
                baseOutPerDollar: 0.001,
                impactBpsAt: s => (s <= 8_000 ? 0 : s <= 40_000 ? 400 : 9_900),
            }),
        ),
    ];

    it('folds a single-chunk leg into the best sibling with room', () => {
        const result = computeAllocation({ targetUsd: 1_000_000, variants: dustPair() })!;
        expect(result.minLegUsd).toBe(40_000);
        // Without folding this is A $980k + B $20k; the $20k leg is one chunk
        // of noise plus real per-leg execution overhead — folded into A.
        expect(result.legs.length).toBe(1);
        expect(result.legs[0]!.symbol).toBe('A');
        expect(result.legs[0]!.amountUsd).toBe(1_000_000);
        expect(result.allocatedUsd).toBe(1_000_000);
    });

    it('keeps the dust leg when no sibling has room', () => {
        // A can only prove $200k of depth; B holds the rest and its own dust
        // cannot move anywhere.
        const a = variant('A', 1, pointsFor({ sizes: [8_000, 40_000, 200_000], baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const b = variant('B', 2, pointsFor({ sizes: [8_000, 40_000], baseOutPerDollar: 0.00099, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 220_000, variants: [a, b] })!;
        const bLeg = result.legs.find(leg => leg.symbol === 'B');
        // B's $20k is below the floor but every other variant is cap-bound:
        // keeping the dust beats under-allocating the target.
        expect(bLeg).toBeDefined();
        expect(result.allocatedUsd).toBe(220_000);
    });

    it('never folds a full-target single-variant plan', () => {
        const only = variant('A', 1, pointsFor({ sizes: [1_000, 2_000, 10_000], baseOutPerDollar: 0.001, impactBpsAt: () => 0 }));
        const result = computeAllocation({ targetUsd: 10_000, variants: [only] })!;
        expect(result.legs.length).toBe(1);
        expect(result.legs[0]!.amountUsd).toBe(10_000);
    });
});

