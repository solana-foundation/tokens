import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
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

const MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let quoteArgs: Record<string, unknown> | null = null;
let tokenExists = true;
let tokenDecimals: number | null = 8;
let marketMetadataExists = false;
let marketDecimals: number | null = 8;
let jupiterMetadataExists = false;
let quoteResponder: (() => unknown) | null = null;

function availableEntry(amount: string, rawAmount: string) {
    const candidate = {
        provider: 'jupiter',
        status: 'available',
        inAmountRaw: rawAmount,
        outAmountRaw: '123456789012345678',
        priceImpactPct: 0.42,
        route: [
            {
                ammKey: 'amm',
                label: 'Meteora DLMM',
                percent: 100,
                inputMint: USDC,
                outputMint: MINT,
                inAmountRaw: rawAmount,
                outAmountRaw: '123456789012345678',
                feeAmountRaw: '10',
                feeMint: USDC,
            },
        ],
        contextSlot: null,
        router: 'metis',
        mode: 'ultra',
        fees: {
            feeBps: 10,
            feeMint: USDC,
            platformFee: { amountRaw: null, feeBps: 10, feeMint: USDC },
        },
        quotedAt: '2026-08-22T12:34:56.000Z',
    } as const;
    return {
        request: { unit: 'usd', amount, rawAmount },
        status: 'available',
        provider: 'jupiter',
        inAmountRaw: rawAmount,
        outAmountRaw: '123456789012345678',
        priceImpactPct: 0.42,
        route: [
            {
                ammKey: 'amm',
                label: 'Meteora DLMM',
                percent: 100,
                inputMint: USDC,
                outputMint: MINT,
                inAmountRaw: rawAmount,
                outAmountRaw: '123456789012345678',
                feeAmountRaw: '10',
                feeMint: USDC,
            },
        ],
        contextSlot: null,
        router: 'metis',
        mode: 'ultra',
        fees: {
            feeBps: 10,
            feeMint: USDC,
            platformFee: { amountRaw: null, feeBps: 10, feeMint: USDC },
        },
        quotedAt: '2026-08-22T12:34:56.000Z',
        candidates: [
            candidate,
            {
                provider: 'titan',
                status: 'unavailable',
                reason: 'no_route',
                inAmountRaw: null,
                outAmountRaw: null,
                priceImpactPct: null,
                route: [],
                contextSlot: null,
                router: null,
                mode: null,
                fees: null,
                quotedAt: '2026-08-22T12:34:56.000Z',
            },
        ],
    };
}

function defaultQuoteResponse() {
    return {
        providers: ['jupiter', 'titan'],
        mint: MINT,
        side: 'buy',
        quoteMint: USDC,
        entries: [availableEntry('10000', '10000000000')],
    };
}

function stubCloudRun(): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/query/listDeletedRefs')) return Response.json([]);
        if (url.includes('/query/tokensGetByAddress')) {
            return Response.json(
                tokenExists
                    ? {
                          _id: 'token',
                          _creationTime: 1,
                          address: MINT,
                          symbol: 'cbBTC',
                          name: 'Coinbase Wrapped BTC',
                          decimals: tokenDecimals,
                          lastFetchedAt: 1,
                      }
                    : null,
            );
        }
        if (url.includes('/query/variantMarketsGetLatestByMints')) {
            return Response.json([
                {
                    mint: MINT,
                    market: marketMetadataExists
                        ? {
                              mint: MINT,
                              source: 'birdeye',
                              symbol: 'cbBTC',
                              name: 'Coinbase Wrapped BTC',
                              decimals: marketDecimals,
                              lastFetchedAt: 1,
                          }
                        : null,
                },
            ]);
        }
        if (url.includes('/query/executionQuoteTokenMetadata')) {
            return Response.json(
                jupiterMetadataExists
                    ? { mint: MINT, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 }
                    : null,
            );
        }
        if (url.includes('/query/executionQuotesLive')) {
            const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
            quoteArgs = rawBody ? (JSON.parse(String(rawBody)) as Record<string, unknown>) : null;
            return Response.json(quoteResponder?.() ?? defaultQuoteResponse());
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
    quoteArgs = null;
    tokenExists = true;
    tokenDecimals = 8;
    marketMetadataExists = false;
    marketDecimals = 8;
    jupiterMetadataExists = false;
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

describe('GET /api/v2/execution/evaluate', () => {
    it('returns exact Jupiter data for the selected mint with no-store caching', async () => {
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(
            (({ mint, side, amounts, tokenDecimals }) => ({ mint, side, amounts, tokenDecimals }))(
                quoteArgs as {
                    mint: string;
                    side: string;
                    amounts: string[];
                    tokenDecimals: number;
                },
            ),
        ).toEqual({ mint: MINT, side: 'buy', amounts: ['10000'], tokenDecimals: 8 });
        // The fan-out budget is sent explicitly so the handler, not the
        // transport, is the layer that gives up first.
        expect((quoteArgs as { timeoutMs?: number }).timeoutMs).toBe(12_000);

        const body = await response.json();
        expect({ mint: body.mint, side: body.side, providers: body.providers, token: body.token }).toEqual({
            mint: MINT,
            side: 'buy',
            providers: ['jupiter', 'titan'],
            token: { mint: MINT, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, verified: true },
        });
        expect(body.meta.requested).toBe(1);
        expect(body.meta.available).toBe(1);
        expect(body.meta.unavailable).toBe(0);
        expect(body.meta.upstreamQuotes).toBe(2);
        expect(body.meta.limits).toEqual({ maxAmounts: 9, maxProviders: 2 });
        expect(body.meta.tieBreak).toBe('jupiter');
        expect(body.meta.comparisonVersion).toBe('quote-compare-v1');
        expect(body.meta.amountSource).toBe('request');
        expect(body.meta.defaultLadderUsd).toBeNull();
        // Uncontested: Jupiter was the only quote, so it is a sole quote and not a win.
        expect(body.meta.providerStats.jupiter).toEqual({
            quoted: 1,
            unavailable: 0,
            wins: 0,
            soleQuotes: 1,
            meanEdgeBps: null,
            medianEdgeBps: null,
        });
        expect(body.meta.summary.comparableEntries).toBe(0);
        expect(body.meta.summary.bestProvider).toBe('jupiter');
        expect(body.meta.summary.bestProviderReason).toBe('only_provider');

        const entry = body.quotes[0];
        expect(entry.request).toEqual({ unit: 'usd', amount: '10000', rawAmount: '10000000000' });
        // Only one provider quoted, so there is nothing to compare against.
        expect(entry.edge).toBeNull();
        expect({
            provider: entry.best.provider,
            rank: entry.best.rank,
            isBest: entry.best.isBest,
            input: entry.best.input,
            output: entry.best.output,
            priceImpactPct: entry.best.priceImpactPct,
            priceImpactSource: entry.best.priceImpactSource,
            contextSlot: entry.best.contextSlot,
            router: entry.best.router,
            mode: entry.best.mode,
            fees: entry.best.fees,
            quotedAt: entry.best.quotedAt,
        }).toEqual({
            provider: 'jupiter',
            rank: 1,
            isBest: true,
            input: { mint: USDC, symbol: 'USDC', decimals: 6, amount: '10000', rawAmount: '10000000000' },
            output: {
                mint: MINT,
                symbol: 'cbBTC',
                decimals: 8,
                amount: '1234567890.12345678',
                rawAmount: '123456789012345678',
            },
            priceImpactPct: 0.42,
            priceImpactSource: 'provider',
            contextSlot: null,
            router: 'metis',
            mode: 'ultra',
            fees: {
                feeBps: 10,
                feeMint: USDC,
                platformFee: { amountRaw: null, feeBps: 10, feeMint: USDC },
            },
            quotedAt: '2026-08-22T12:34:56.000Z',
        });
        expect(entry.best.transaction).toBe(undefined);
        expect(entry.best.requestId).toBe(undefined);
        // The hoisted winner is the same object as its providerQuotes entry.
        expect(entry.best).toEqual(entry.providerQuotes.find((quote: { isBest: boolean }) => quote.isBest));
        expect(
            entry.providerQuotes.map((quote: { provider: string; status: string; rank: number | null }) => ({
                provider: quote.provider,
                status: quote.status,
                rank: quote.rank,
            })),
        ).toEqual([
            { provider: 'jupiter', status: 'available', rank: 1 },
            { provider: 'titan', status: 'unavailable', rank: null },
        ]);
        // Titan reports no impact field at all, which is not the same as zero.
        const titanQuote = entry.providerQuotes.find((quote: { provider: string }) => quote.provider === 'titan');
        expect(titanQuote.priceImpactSource).toBe('unavailable');
        expect(titanQuote.priceImpactPct).toBeNull();
    });

    it('serializes a Titan winner and mixed-provider statistics', async () => {
        const entry = availableEntry('25000', '25000000000');
        const titan = {
            ...entry.candidates[0],
            provider: 'titan',
            outAmountRaw: '123456789012345679',
            priceImpactPct: null,
            quotedAt: '2026-08-22T12:34:56.100Z',
        } as const;
        quoteResponder = () => ({
            providers: ['jupiter', 'titan'],
            mint: MINT,
            side: 'buy',
            quoteMint: USDC,
            entries: [
                {
                    ...entry,
                    provider: 'titan',
                    outAmountRaw: titan.outAmountRaw,
                    priceImpactPct: null,
                    quotedAt: titan.quotedAt,
                    candidates: [entry.candidates[0], titan],
                },
            ],
        });

        const body = await (await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=25000`)).json();
        const quote = body.quotes[0];
        expect({ provider: quote.best.provider, priceImpactSource: quote.best.priceImpactSource }).toEqual({
            provider: 'titan',
            priceImpactSource: 'unavailable',
        });
        expect(quote.best.output.rawAmount).toBe('123456789012345679');
        // Ranked best-first, so providerQuotes[1] is the runner-up the edge is measured against.
        expect(quote.providerQuotes.map((quote: { provider: string }) => quote.provider)).toEqual([
            'titan',
            'jupiter',
        ]);
        expect(quote.providerQuotes.map((quote: { rank: number }) => quote.rank)).toEqual([1, 2]);
        // Titan beat Jupiter by exactly 1 raw unit out of ~1.2e17.
        expect(quote.edge.runnerUp).toBe('jupiter');
        expect(quote.edge.comparedProviders).toBe(2);
        expect(quote.edge.outAmountDiffRaw).toBe('1');
        expect(quote.edge.bps).toBe(0);

        // Contested: Titan's win counts, and neither provider is a sole quote.
        expect(body.meta.providerStats.titan).toEqual({
            quoted: 1,
            unavailable: 0,
            wins: 1,
            soleQuotes: 0,
            meanEdgeBps: 0,
            medianEdgeBps: 0,
        });
        expect(body.meta.providerStats.jupiter.wins).toBe(0);
        expect(body.meta.providerStats.jupiter.soleQuotes).toBe(0);
        expect(body.meta.summary.comparableEntries).toBe(1);
        expect(body.meta.summary.bestProvider).toBe('titan');
        expect(body.meta.summary.bestProviderReason).toBe('most_wins');
    });

    it('accepts repeated buy amounts, normalizes and dedupes them', async () => {
        const response = await request(
            `/api/v2/execution/evaluate?mint=${MINT}&side=buy&amountUsd=10000&amountUsd=25000&amountUsd=10000.0`,
        );
        expect(response.status).toBe(200);
        expect(quoteArgs?.amounts).toEqual(['10000', '25000']);
    });

    it('supports exact token sells and reverses the formatted pair', async () => {
        quoteResponder = () => ({
            providers: ['jupiter', 'titan'],
            mint: MINT,
            side: 'sell',
            quoteMint: USDC,
            entries: [
                (() => {
                    const base = availableEntry('12.5', '1250000000');
                    // The response is built from the candidate, so the sell
                    // amounts have to live there too.
                    const candidate = { ...base.candidates[0], outAmountRaw: '987654321' };
                    return {
                        ...base,
                        request: { unit: 'token', amount: '12.5', rawAmount: '1250000000' },
                        inAmountRaw: '1250000000',
                        outAmountRaw: '987654321',
                        candidates: [candidate, base.candidates[1]],
                    };
                })(),
            ],
        });
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&side=sell&tokenAmount=12.5`);
        expect(response.status).toBe(200);
        expect(
            (({ mint, side, amounts, tokenDecimals }) => ({ mint, side, amounts, tokenDecimals }))(
                quoteArgs as {
                    mint: string;
                    side: string;
                    amounts: string[];
                    tokenDecimals: number;
                },
            ),
        ).toEqual({ mint: MINT, side: 'sell', amounts: ['12.5'], tokenDecimals: 8 });
        const body = await response.json();
        const best = body.quotes[0].best;
        expect({ mint: best.input.mint, symbol: best.input.symbol, amount: best.input.amount }).toEqual({
            mint: MINT,
            symbol: 'cbBTC',
            amount: '12.5',
        });
        expect({ mint: best.output.mint, symbol: best.output.symbol, amount: best.output.amount }).toEqual({
            mint: USDC,
            symbol: 'USDC',
            amount: '987.654321',
        });
    });

    it('preserves unavailable rows without substituting a quote', async () => {
        quoteResponder = () => ({
            providers: ['jupiter', 'titan'],
            mint: MINT,
            side: 'buy',
            quoteMint: USDC,
            entries: [
                {
                    request: { unit: 'usd', amount: '5000000', rawAmount: '5000000000000' },
                    status: 'unavailable',
                    reason: 'no_route',
                    provider: null,
                    inAmountRaw: null,
                    outAmountRaw: null,
                    priceImpactPct: null,
                    route: [],
                    contextSlot: null,
                    router: null,
                    mode: null,
                    fees: null,
                    quotedAt: '2026-08-22T12:34:56.000Z',
                    candidates: [
                        {
                            provider: 'jupiter',
                            status: 'unavailable',
                            reason: 'no_route',
                            inAmountRaw: null,
                            outAmountRaw: null,
                            priceImpactPct: null,
                            route: [],
                            contextSlot: null,
                            router: null,
                            mode: null,
                            fees: null,
                            quotedAt: '2026-08-22T12:34:56.000Z',
                        },
                        {
                            provider: 'titan',
                            status: 'unavailable',
                            reason: 'auth',
                            inAmountRaw: null,
                            outAmountRaw: null,
                            priceImpactPct: null,
                            route: [],
                            contextSlot: null,
                            router: null,
                            mode: null,
                            fees: null,
                            quotedAt: '2026-08-22T12:34:56.000Z',
                        },
                    ],
                },
            ],
        });
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=5000000`);
        const body = await response.json();
        // Unavailable rows carry no winner and nothing to compare.
        expect({ status: body.quotes[0].status, best: body.quotes[0].best, edge: body.quotes[0].edge }).toEqual({
            status: 'unavailable',
            best: null,
            edge: null,
        });
        // The per-provider detail is still present, so callers can see who failed and why.
        expect(body.quotes[0].providerQuotes.length).toBeGreaterThan(0);
        for (const quote of body.quotes[0].providerQuotes) {
            expect(quote.status).toBe('unavailable');
            expect(quote.input).toBeNull();
            expect(quote.rank).toBeNull();
            expect(quote.isBest).toBe(false);
            expect(quote.router).toBeNull();
            expect(quote.mode).toBeNull();
            expect(quote.fees).toBeNull();
        }
        // Reasons are per-provider and must not be collapsed: a bad API key
        // (auth) and a genuinely illiquid size (no_route) are different bugs.
        expect(
            (body.quotes[0].providerQuotes as { provider: string; reason: string }[]).map(quote => [
                quote.provider,
                quote.reason,
            ]),
        ).toEqual([
            ['jupiter', 'no_route'],
            ['titan', 'auth'],
        ]);
        expect({
            requested: body.meta.requested,
            available: body.meta.available,
            unavailable: body.meta.unavailable,
        }).toEqual({ requested: 1, available: 0, unavailable: 1 });
        // Nothing quoted anywhere: no wins, no sole quotes, no verdict.
        for (const provider of ['jupiter', 'titan'] as const) {
            expect(body.meta.providerStats[provider]).toEqual({
                quoted: 0,
                unavailable: 1,
                wins: 0,
                soleQuotes: 0,
                meanEdgeBps: null,
                medianEdgeBps: null,
            });
        }
        expect(body.meta.summary.bestProvider).toBeNull();
        expect(body.meta.summary.bestProviderReason).toBe('no_comparison');
        expect(body.meta.summary.comparableEntries).toBe(0);
    });

    it('narrows the provider set and reports no comparison for a single provider', async () => {
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000&providers=jupiter`);
        expect(response.status).toBe(200);
        expect(quoteArgs?.providers).toEqual(['jupiter']);

        const body = await response.json();
        // One provider: nothing to compare, so no edge anywhere.
        expect(body.meta.upstreamQuotes).toBe(1);
        for (const quote of body.quotes) expect(quote.edge).toBeNull();
        expect(body.meta.summary.comparableEntries).toBe(0);
        expect(body.meta.providerStats.titan.quoted).toBe(0);
    });

    it('rejects an unknown provider with the valid set in the message', async () => {
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000&providers=uniswap`);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toContain('uniswap');
        expect(body.error.message).toContain('jupiter');
    });

    it('validates mint, side-specific amounts, precision, range, and batch size', async () => {
        expect((await request('/api/v2/execution/evaluate')).status).toBe(400);
        expect((await request('/api/v2/execution/evaluate?mint=bad&amountUsd=10')).status).toBe(400);
        // No amounts is no longer an error: the default ladder answers instead.
        const defaulted = await request(`/api/v2/execution/evaluate?mint=${MINT}`);
        expect(defaulted.status).toBe(200);
        const defaultedBody = await defaulted.json();
        expect(defaultedBody.meta.amountSource).toBe('default');
        expect(defaultedBody.meta.defaultLadderUsd).toEqual([10_000, 100_000, 1_000_000]);
        expect(quoteArgs?.amounts).toEqual(['10000', '100000', '1000000']);
        // Sells still require explicit sizes until USD sells land.
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&side=sell`)).status).toBe(400);
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&side=buy&tokenAmount=1`)).status).toBe(400);
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&side=sell&amountUsd=1`)).status).toBe(400);
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=0.5`)).status).toBe(400);
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=50000001`)).status).toBe(400);
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&side=sell&tokenAmount=1.000000001`)).status).toBe(
            400,
        );
        const ten = Array.from({ length: 10 }, (_, index) => `amountUsd=${index + 1}`).join('&');
        expect((await request(`/api/v2/execution/evaluate?mint=${MINT}&${ten}`)).status).toBe(400);
    });

    it('returns 404 for unsupported token metadata', async () => {
        tokenExists = false;
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`);
        expect(response.status).toBe(404);
    });

    it('uses authoritative variant-market decimals when the token row is absent', async () => {
        tokenExists = false;
        marketMetadataExists = true;
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`);
        expect(response.status).toBe(200);
        expect(
            (({ mint, side, amounts, tokenDecimals }) => ({ mint, side, amounts, tokenDecimals }))(
                quoteArgs as {
                    mint: string;
                    side: string;
                    amounts: string[];
                    tokenDecimals: number;
                },
            ),
        ).toEqual({ mint: MINT, side: 'buy', amounts: ['10000'], tokenDecimals: 8 });
    });

    it('falls back to Jupiter token metadata when local rows omit decimals', async () => {
        tokenExists = false;
        marketMetadataExists = true;
        marketDecimals = null;
        jupiterMetadataExists = true;
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`);
        expect(response.status).toBe(200);
        expect(
            (({ mint, side, amounts, tokenDecimals }) => ({ mint, side, amounts, tokenDecimals }))(
                quoteArgs as {
                    mint: string;
                    side: string;
                    amounts: string[];
                    tokenDecimals: number;
                },
            ),
        ).toEqual({ mint: MINT, side: 'buy', amounts: ['10000'], tokenDecimals: 8 });
    });

    it('rejects a malformed upstream raw amount instead of throwing inside BigInt', async () => {
        const entry = availableEntry('10000', '10000000000');
        quoteResponder = () => ({
            providers: ['jupiter'],
            mint: MINT,
            side: 'buy',
            quoteMint: USDC,
            entries: [
                {
                    ...entry,
                    outAmountRaw: 'not-a-number',
                    candidates: [{ ...entry.candidates[0], outAmountRaw: 'not-a-number' }],
                },
            ],
        });
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`);
        // A 500 either way, but a tagged upstream-data failure rather than an
        // unhandled BigInt SyntaxError escaping serialization.
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error._tag).toBe('UpstreamDataError');
    });

    it('retains the execution:read scope', async () => {
        const response = await request(`/api/v2/execution/evaluate?mint=${MINT}&amountUsd=10000`, ['assets:read']);
        expect(response.status).toBe(403);
    });
});
