import { describe, expect, it } from 'bun:test';

import {
    computeLadderImpacts,
    DEPTH_SIZE_LADDER_USD,
    DEPTH_USDC_QUOTE_MINT,
    listDepthUniverseMints,
    refreshDepthCurves,
    type DepthCronDeps,
    type DepthCronRepo,
    type DepthQuote,
    type DepthQuoteClient,
    type VariantDepthCurveUpsert,
} from './crons.depth';

const MINT_A = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const MINT_B = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';

function fakeRepo() {
    const upserts: VariantDepthCurveUpsert[] = [];
    const repo: DepthCronRepo = {
        async selectStalestDepthMints(args) {
            return args.mints.slice(0, args.limit);
        },
        async upsertVariantDepthCurve(row) {
            upserts.push(row);
        },
    };
    return { repo, upserts };
}

function fakeQuoteSource(
    handler: (args: { outputMint: string; amount: number }) => Promise<DepthQuote | null>,
): DepthQuoteClient & { closed: { count: number } } {
    const closed = { count: 0 };
    return {
        id: 'titan',
        closed,
        async fetchQuote(args) {
            return handler({ outputMint: args.outputMint, amount: args.amount });
        },
        async close() {
            closed.count += 1;
        },
    };
}

function deps(overrides: {
    quoteSource: DepthQuoteClient;
    repo: DepthCronRepo;
    enabled?: boolean;
}): DepthCronDeps {
    return {
        quoteSource: overrides.quoteSource,
        repo: overrides.repo,
        now: () => 1_700_000_000_000,
        env: () => ({ DEPTH_REFRESH_ENABLED: overrides.enabled === false ? 'false' : 'true' }) as NodeJS.ProcessEnv,
    };
}

// Linear-impact quote: each doubling of size loses a bit of output per unit in.
function syntheticQuote(amount: number, penaltyPerUsd: number): DepthQuote {
    const sizeUsd = amount / 1_000_000;
    const effective = 1 - penaltyPerUsd * sizeUsd;
    return { inAmount: amount, outAmount: Math.floor(amount * effective), routeVenues: ['Fake'] };
}

describe('computeLadderImpacts', () => {
    it('derives impact vs the smallest rung, clamped at zero', () => {
        const ladder = computeLadderImpacts([
            { sizeUsd: 10_000, inAmount: 1, outAmount: 1, effectivePrice: 1.0, routeVenues: [] },
            { sizeUsd: 1_000_000, inAmount: 1, outAmount: 1, effectivePrice: 0.996, routeVenues: [] },
            { sizeUsd: 100_000, inAmount: 1, outAmount: 1, effectivePrice: 1.001, routeVenues: [] },
        ]);
        const bySize = new Map(ladder.map(point => [point.sizeUsd, point.priceImpactBps]));
        expect(bySize.get(10_000)).toBe(0);
        expect(bySize.get(100_000)).toBe(0); // better-than-baseline clamps to 0
        expect(bySize.get(1_000_000)).toBe(40);
    });

    it('returns null impacts when no usable baseline exists', () => {
        const ladder = computeLadderImpacts([
            { sizeUsd: 10_000, inAmount: 1, outAmount: 0, effectivePrice: 0, routeVenues: [] },
        ]);
        expect(ladder[0]?.priceImpactBps).toBeNull();
    });

    it('handles an empty ladder', () => {
        expect(computeLadderImpacts([])).toEqual([]);
    });
});

describe('listDepthUniverseMints', () => {
    it('covers every spot-like registry mint, excludes stablecoin aggregates, dedupes', () => {
        const mints = listDepthUniverseMints();
        expect(mints.length).toBeGreaterThan(150);
        expect(new Set(mints).size).toBe(mints.length);
        expect(mints).toContain(MINT_A); // cbBTC (bitcoin group)
        // Single-variant assets are in the universe too.
        expect(mints).toContain('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'); // HYPE
    });
});

describe('refreshDepthCurves', () => {
    it('no-ops when the refresh flag is off', async () => {
        const { repo, upserts } = fakeRepo();
        const source = fakeQuoteSource(async () => syntheticQuote(0, 0));
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo, enabled: false }), {});
        expect(result.disabled).toBe(true);
        expect(upserts).toHaveLength(0);
    });

    it('samples the full ladder and persists derived impacts', async () => {
        const { repo, upserts } = fakeRepo();
        const source = fakeQuoteSource(async ({ amount }) => syntheticQuote(amount, 0.0000000004));
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            mints: [MINT_A],
            delayMs: 0,
        });

        expect(result.ok).toBe(true);
        expect(result.refreshed).toBe(1);
        expect(upserts).toHaveLength(1);
        const row = upserts[0]!;
        expect(row.mint).toBe(MINT_A);
        expect(row.quoteMint).toBe(DEPTH_USDC_QUOTE_MINT);
        expect(row.side).toBe('buy');
        expect(row.source).toBe('titan');
        expect(row.points).toBe(DEPTH_SIZE_LADDER_USD.length);
        expect(row.failedPoints).toBe(0);
        const impacts = row.ladder.map(point => point.priceImpactBps ?? 0);
        // Impact grows with size and the smallest rung is the baseline.
        expect(row.ladder[0]?.priceImpactBps).toBe(0);
        expect([...impacts].sort((a, b) => a - b)).toEqual(impacts);
        expect(source.closed.count).toBe(1);
    });

    it('drops failed rungs but keeps the rest of the ladder', async () => {
        const { repo, upserts } = fakeRepo();
        const source = fakeQuoteSource(async ({ amount }) =>
            amount === 100_000 * 1_000_000 ? null : syntheticQuote(amount, 0.0000000004),
        );
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            mints: [MINT_A],
            delayMs: 0,
        });
        expect(result.refreshed).toBe(1);
        expect(upserts[0]?.points).toBe(DEPTH_SIZE_LADDER_USD.length - 1);
        expect(upserts[0]?.failedPoints).toBe(1);
    });

    it('records an empty ladder when every rung reports no route', async () => {
        const { repo, upserts } = fakeRepo();
        const source = fakeQuoteSource(async ({ outputMint, amount }) =>
            outputMint === MINT_A ? null : syntheticQuote(amount, 0.0000000004),
        );
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            mints: [MINT_A, MINT_B],
            delayMs: 0,
        });
        expect(result.refreshed).toBe(1);
        expect(result.noRoute).toBe(1);
        expect(upserts).toHaveLength(2);
        const noRouteRow = upserts.find(row => row.mint === MINT_A);
        expect(noRouteRow?.ladder).toEqual([]);
        expect(noRouteRow?.points).toBe(0);
        expect(noRouteRow?.failedPoints).toBe(DEPTH_SIZE_LADDER_USD.length);
    });

    it('counts transport failures per mint and stays ok on partial failure', async () => {
        const { repo, upserts } = fakeRepo();
        const source = fakeQuoteSource(async ({ outputMint, amount }) => {
            if (outputMint === MINT_A) throw new Error('connection reset');
            return syntheticQuote(amount, 0.0000000004);
        });
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            mints: [MINT_A, MINT_B],
            delayMs: 0,
        });
        expect(result.ok).toBe(true);
        expect(result.failed).toBe(1);
        expect(result.refreshed).toBe(1);
        expect(upserts).toHaveLength(1);
    });

    it('reports ok: false when every mint fails', async () => {
        const { repo } = fakeRepo();
        const source = fakeQuoteSource(async () => {
            throw new Error('connection reset');
        });
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            mints: [MINT_A],
            delayMs: 0,
        });
        expect(result.ok).toBe(false);
        expect(result.failed).toBe(1);
        expect(source.closed.count).toBe(1);
    });

    it('uses the stalest-first shard when no explicit mints are given', async () => {
        const seen: string[] = [];
        const repo: DepthCronRepo = {
            async selectStalestDepthMints(args) {
                expect(args.limit).toBe(2);
                expect(args.source).toBe('titan');
                return args.mints.slice(0, args.limit);
            },
            async upsertVariantDepthCurve(row) {
                seen.push(row.mint);
            },
        };
        const source = fakeQuoteSource(async ({ amount }) => syntheticQuote(amount, 0.0000000004));
        const result = await refreshDepthCurves(deps({ quoteSource: source, repo }), {
            maxMints: 2,
            delayMs: 0,
        });
        expect(result.requested).toBe(2);
        expect(seen).toHaveLength(2);
    });
});
