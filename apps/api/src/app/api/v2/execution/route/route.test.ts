import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { getAsset } = await import('@tokens/asset-registry');
const { GET: routeGet } = await import('./route');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;
const ENV_KEYS = [
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_USAGE_LOG_MODE',
    'TOKENS_REDIS_TARGET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BITCOIN_MINTS = getAsset('bitcoin')!.variants.map(variant => variant.mint);

/** Mints the market stub reports as liquid; everything else gets a null market row. */
let liquidMints: string[] = [];
let quoteCallMints: string[] = [];
let metadataCallMints: string[] = [];
/** Mints Jupiter token metadata can resolve when the market row is missing. */
let metadataFallbackMints: string[] = [];
/** Per-mint fanout responder; defaults to two clean rungs per requested amount. */
let quoteResponder: ((mint: string, amounts: string[]) => unknown) | null = null;

function marketRow(mint: string) {
    return {
        mint,
        source: 'birdeye',
        symbol: `SYM${mint.slice(0, 3)}`,
        name: `Name ${mint.slice(0, 6)}`,
        decimals: 8,
        price: 100_000,
        liquidity: 50_000_000,
        volume24hUSD: 10_000_000,
        trade24h: 5_000,
        lastFetchedAt: 1,
    };
}

function availableCandidate(provider: 'jupiter' | 'titan', inRaw: string, outRaw: string) {
    return {
        provider,
        status: 'available',
        inAmountRaw: inRaw,
        outAmountRaw: outRaw,
        priceImpactPct: provider === 'jupiter' ? 0.01 : null,
        route: [],
        contextSlot: provider === 'titan' ? 123 : null,
        router: provider === 'jupiter' ? 'metis' : null,
        mode: provider === 'jupiter' ? 'ultra' : null,
        fees: null,
        quotedAt: '2026-08-25T12:00:00.000Z',
    };
}

function defaultFanout(mint: string, amounts: string[]) {
    return {
        providers: ['jupiter', 'titan'],
        mint,
        side: 'buy',
        quoteMint: USDC,
        entries: amounts.map(amount => {
            const inRaw = `${amount}000000`;
            // Jupiter slightly better so tie-breaks are deterministic in tests.
            const jupiter = availableCandidate('jupiter', inRaw, `${Number(amount) * 100}0`);
            const titan = availableCandidate('titan', inRaw, `${Number(amount) * 100}`);
            return {
                request: { unit: 'usd', amount, rawAmount: inRaw },
                status: 'available',
                provider: 'jupiter',
                inAmountRaw: jupiter.inAmountRaw,
                outAmountRaw: jupiter.outAmountRaw,
                priceImpactPct: jupiter.priceImpactPct,
                route: [],
                contextSlot: null,
                router: jupiter.router,
                mode: jupiter.mode,
                fees: null,
                quotedAt: jupiter.quotedAt,
                candidates: [jupiter, titan],
            };
        }),
    };
}

function stubCloudRun(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
        const body = rawBody ? (JSON.parse(String(rawBody)) as Record<string, unknown>) : {};
        if (url.includes('/query/listDeletedRefs')) return Response.json([]);
        if (url.includes('/query/variantMarketsGetLatestByMints')) {
            const mints = (body.mints as string[]) ?? [];
            return Response.json(
                mints.map(mint => ({ mint, market: liquidMints.includes(mint) ? marketRow(mint) : null })),
            );
        }
        if (url.includes('/query/variantFillQualityGetLatestByMints')) {
            const mints = (body.mints as string[]) ?? [];
            return Response.json(mints.map(mint => ({ mint, fillQuality: null })));
        }
        if (url.includes('/query/executionQuoteTokenMetadata')) {
            const mint = body.mint as string;
            metadataCallMints.push(mint);
            return Response.json(
                metadataFallbackMints.includes(mint)
                    ? { mint, symbol: `META${mint.slice(0, 3)}`, name: `Meta ${mint.slice(0, 6)}`, decimals: 8 }
                    : null,
            );
        }
        if (url.includes('/query/executionQuotesLive')) {
            const mint = body.mint as string;
            const amounts = body.amounts as string[];
            quoteCallMints.push(mint);
            return Response.json(quoteResponder ? quoteResponder(mint, amounts) : defaultFanout(mint, amounts));
        }
        throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) savedEnv[key] = value;
        else delete savedEnv[key];
        delete process.env[key];
    }
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'cloudrun-token';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    liquidMints = [...BITCOIN_MINTS];
    quoteCallMints = [];
    metadataCallMints = [];
    metadataFallbackMints = [];
    quoteResponder = null;
    stubCloudRun();
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    console.warn = ORIGINAL_WARN;
    console.error = ORIGINAL_ERROR;
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
});

async function request(path: string, scopes: string[] = ['execution:read']): Promise<Response> {
    const now = Date.now();
    const header = await signPlaygroundProxyAuthPayload({
        apiKeyId: 'test-key',
        keyPrefix: 'tk_test',
        projectId: 'test-project',
        ownerClerkUserId: 'test-user',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
    return routeGet(
        new Request(`https://api.example.test${path}`, { headers: { 'x-tokens-playground-auth': header } }),
        {} as never,
    );
}

describe('GET /api/v2/execution/route', () => {
    it('quotes the top variants of a canonical asset across the scaled ladder', async () => {
        const response = await request('/api/v2/execution/route?assetId=bitcoin&amountUsd=5000000');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        const body = await response.json();
        expect(body.assetId).toBe('bitcoin');
        expect((body.variants).length).toBe(4);
        expect(body.meta.probeLadderUsd).toEqual([40_000, 200_000, 1_000_000, 5_000_000]);
        // One probe fanout per selected variant plus one verification call per
        // allocation leg (asserted precisely below once the plan is in hand).
        expect(quoteCallMints.length).toBeGreaterThanOrEqual(4);
        for (const variant of body.variants as Record<string, unknown>[]) {
            expect((variant.quotes as unknown[]).length).toBe(4);
            expect(variant.parityBasis).toBe('kind');
            expect(variant.allocationEligible).toBe(true);
            const curve = variant.curve as { rungs: unknown[]; maxProvenSizeUsd: number };
            expect((curve.rungs).length).toBe(4);
            expect(curve.maxProvenSizeUsd).toBe(5_000_000);
        }
        expect(body.variants.map((variant: { rank: number }) => variant.rank)).toEqual([1, 2, 3, 4]);
        expect(body.meta.selectedVariants).toBe(4);
        // The other bitcoin variants surface as excluded, never silently dropped.
        const excludedMints = (body.meta.excludedVariants as { mint: string }[]).map(entry => entry.mint);
        expect(excludedMints.length).toBe(BITCOIN_MINTS.length - 4);

        // Allocation defaults on: a plan whose legs sum to the target exactly.
        expect(body.allocationStatus).toBe('ok');
        const allocation = body.allocation as {
            targetUsd: string;
            allocatedUsd: string;
            unallocatedUsd: string;
            legs: { amountUsd: string; verification: { status: string } }[];
            totalExpectedOut: { rawAmount: string } | null;
            edge: { vsBestSingleVariant: { bps: number } | null };
        };
        expect(allocation.targetUsd).toBe('5000000');
        const legSum = allocation.legs.reduce((sum, leg) => sum + Number(leg.amountUsd), 0);
        expect(legSum + Number(allocation.unallocatedUsd)).toBe(5_000_000);
        expect(Number(allocation.allocatedUsd)).toBe(legSum);
        expect(allocation.totalExpectedOut).not.toBeNull();
        // Every leg was re-verified with an exact quote (the stub always answers).
        for (const leg of allocation.legs) expect(leg.verification.status).toBe('verified');
        // Single-variant is a feasible allocation, so the plan never loses to it.
        if (allocation.edge.vsBestSingleVariant) {
            expect(allocation.edge.vsBestSingleVariant.bps).toBeGreaterThanOrEqual(0);
        }
        // Honest cost echo includes the verification wave.
        expect(body.meta.upstreamQuotes).toBe(4 * 4 * 2 + allocation.legs.length * 2);
        expect(quoteCallMints.length).toBe(4 + allocation.legs.length);
    });

    it('skips allocation when allocate=false', async () => {
        const response = await request('/api/v2/execution/route?assetId=bitcoin&allocate=false');
        const body = await response.json();
        expect(body.allocationStatus).toBe('not_requested');
        expect(body.allocation).toBeNull();
        expect(body.meta.upstreamQuotes).toBe(body.variants.length * 4 * 2);
    });

    it('defaults the target to $1M with the matching ladder', async () => {
        const response = await request('/api/v2/execution/route?assetId=bitcoin');
        const body = await response.json();
        expect(body.meta.targetUsd).toBe('1000000');
        expect(body.meta.probeLadderUsd).toEqual([8_000, 40_000, 200_000, 1_000_000]);
    });

    it('resolves aliases to the canonical assetId', async () => {
        const response = await request('/api/v2/execution/route?assetId=btc');
        expect(response.status).toBe(200);
        expect((await response.json()).assetId).toBe('bitcoin');
    });

    it('404s an unknown asset and 400s bad params', async () => {
        expect((await request('/api/v2/execution/route?assetId=not-an-asset')).status).toBe(404);
        expect((await request('/api/v2/execution/route')).status).toBe(400);
        expect((await request('/api/v2/execution/route?assetId=bitcoin&amountUsd=0')).status).toBe(400);
        expect((await request('/api/v2/execution/route?assetId=bitcoin&amountUsd=50000001')).status).toBe(400);
        expect((await request('/api/v2/execution/route?assetId=bitcoin&maxVariants=7')).status).toBe(400);
        expect((await request('/api/v2/execution/route?assetId=bitcoin&providers=uniswap')).status).toBe(400);
    });

    it('rejects sell side with a pointer to evaluate', async () => {
        const response = await request('/api/v2/execution/route?assetId=bitcoin&side=sell');
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error.message).toContain('evaluate');
    });

    it('carries the equity disclosures for issuer-asserted parity', async () => {
        const skHynix = getAsset('sk-hynix')!;
        liquidMints = skHynix.variants.map(variant => variant.mint);
        const response = await request('/api/v2/execution/route?assetId=sk-hynix&amountUsd=100000');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.meta.warnings).toContain('equity_unit_parity_assumed');
        expect(body.meta.warnings).toContain('issuer_primary_market_not_quoted');
        for (const variant of body.variants as { parityBasis: string }[]) {
            expect(variant.parityBasis).toBe('issuer_assertion');
        }
    });

    it('degrades a failed variant fanout instead of failing the request', async () => {
        const failMint = BITCOIN_MINTS.find(mint => liquidMints.includes(mint))!;
        quoteResponder = (mint, amounts) => {
            if (mint === failMint) return { boom: true };
            return defaultFanout(mint, amounts);
        };
        const response = await request('/api/v2/execution/route?assetId=bitcoin&amountUsd=1000000');
        expect(response.status).toBe(200);
        const body = await response.json();
        const failed = (body.variants as { mint: string; quotes: unknown[]; allocationEligible: boolean }[]).find(
            variant => variant.mint === failMint,
        );
        if (failed) {
            expect((failed.quotes).length).toBe(0);
            expect(failed.allocationEligible).toBe(false);
            expect(body.meta.warnings).toContain(`variant_fanout_failed:${failMint}`);
        } else {
            // The failing mint may not rank into the top 4; the request must still succeed.
            expect(body.variants.length).toBeGreaterThan(0);
        }
    });

    it('ejects a price-divergent spot sibling from the allocation pool', async () => {
        const gold = getAsset('gold')!;
        const spotMints = gold.variants.filter(variant => variant.kind === 'spot').map(variant => variant.mint);
        liquidMints = gold.variants.map(variant => variant.mint);
        // One spot variant quotes 10x fewer tokens per dollar — a different
        // unit or a broken book; either way not summable with the siblings.
        const divergent = spotMints[0]!;
        quoteResponder = (mint, amounts) => {
            const fanout = defaultFanout(mint, amounts) as { entries: { candidates: { outAmountRaw: string }[] }[] };
            if (mint === divergent) {
                for (const entry of fanout.entries) {
                    for (const candidate of entry.candidates) {
                        candidate.outAmountRaw = String(BigInt(candidate.outAmountRaw) / 10n);
                    }
                }
            }
            return fanout;
        };
        const response = await request('/api/v2/execution/route?assetId=gold&amountUsd=1000000');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.allocationStatus).toBe('ok');
        expect(body.meta.warnings).toContain(`price_divergence_excluded:${divergent}`);
        const ejectedVariant = (body.variants as Record<string, unknown>[]).find(v => v.mint === divergent);
        if (ejectedVariant) {
            expect(ejectedVariant.allocationEligible).toBe(false);
            const curve = ejectedVariant.curve as { parityDivergenceBps: number };
            expect(curve.parityDivergenceBps).toBeGreaterThan(500);
        }
        const legs = (body.allocation as { legs: { mint: string }[] }).legs;
        expect(legs.some(leg => leg.mint === divergent)).toBe(false);
        // Surviving peg spread reflects the pool, not the handled outlier.
        expect((body.allocation as { pegSpreadBps: number | null }).pegSpreadBps ?? 0).toBeLessThan(500);
    });

    it('falls back to Jupiter metadata for decimals when market rows are missing', async () => {
        const skHynix = getAsset('sk-hynix')!;
        const mints = skHynix.variants.map(variant => variant.mint);
        // No market rows at all — the equity coverage gap — but Jupiter's
        // token search knows the mints.
        liquidMints = [];
        metadataFallbackMints = mints;
        const response = await request('/api/v2/execution/route?assetId=sk-hynix&amountUsd=100000');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(metadataCallMints.length).toBeGreaterThan(0);
        expect((body.variants as unknown[]).length).toBeGreaterThan(0);
        expect(
            (body.meta.excludedVariants as { reason: string }[]).filter(e => e.reason === 'missing_decimals').length,
        ).toBe(0);
    });

    it('reports null edges for a single-leg plan on the baseline variant (D)', async () => {
        const ethereum = getAsset('ethereum')!;
        liquidMints = ethereum.variants.map(variant => variant.mint);
        const response = await request('/api/v2/execution/route?assetId=ethereum&amountUsd=1000000');
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.allocationStatus).toBe('ok');
        const allocation = body.allocation as {
            legs: unknown[];
            edge: { vsBestSingleVariant: unknown; vsPrimaryVariant: unknown };
        };
        expect(allocation.legs.length).toBe(1);
        // A one-leg plan on the baseline variant compares two quotes of the
        // same thing minutes apart — that is noise, not an edge.
        expect(allocation.edge.vsBestSingleVariant).toBeNull();
        expect(allocation.edge.vsPrimaryVariant).toBeNull();
    });

    it('requires the execution:read scope', async () => {
        const response = await request('/api/v2/execution/route?assetId=bitcoin', ['assets:read']);
        expect(response.status).toBe(403);
    });
});
