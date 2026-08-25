import { describe, expect, it } from 'bun:test';

import {
    depthSampleMints,
    executionQuoteTokenMetadata,
    executionQuotesLive,
    formatRawAmount,
    type ExactQuote,
    type ExactQuoteClient,
    type JupiterSwapV2QuoteClient,
    type LiveQuoteDeps,
    type QuoteUnavailableReason,
    limitQuoteConcurrency,
} from './liveQuotes';
import type { DepthQuote, DepthQuoteClient } from './crons.depth';
import { createConcurrencyLimiter } from '../concurrencyLimiter';

const MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function exactQuote(amountRaw: string, outAmountRaw = '123456789012345678'): ExactQuote {
    return {
        inAmountRaw: amountRaw,
        outAmountRaw,
        priceImpactPct: 0.42,
        route: [
            {
                ammKey: 'amm',
                label: 'Meteora DLMM',
                percent: 100,
                inputMint: USDC,
                outputMint: MINT,
                inAmountRaw: amountRaw,
                outAmountRaw,
                feeAmountRaw: '10',
                feeMint: USDC,
            },
        ],
        contextSlot: 123,
        router: 'metis',
        mode: 'ultra',
        fees: {
            feeBps: 10,
            feeMint: USDC,
            platformFee: { amountRaw: null, feeBps: 10, feeMint: USDC },
        },
    };
}

function deps(
    handler: JupiterSwapV2QuoteClient['fetchQuote'],
    now: () => number = () => 1_700_000_000_000,
    titanHandler?: ExactQuoteClient['fetchQuote'],
): LiveQuoteDeps {
    return {
        jupiterTokenMetadataSource: {
            async fetchTokenMetadata(mint) {
                return { mint, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 };
            },
        },
        jupiterQuoteSource: {
            id: 'jupiter',
            fetchQuote: handler,
        },
        ...(titanHandler ? { titanQuoteSource: { id: 'titan' as const, fetchQuote: titanHandler } } : {}),
        now,
    };
}

describe('executionQuoteTokenMetadata', () => {
    it('returns Jupiter metadata for the exact mint', async () => {
        await expect(executionQuoteTokenMetadata(deps(async () => null), { mint: MINT })).resolves.toEqual({
            mint: MINT,
            symbol: 'cbBTC',
            name: 'Coinbase Wrapped BTC',
            decimals: 8,
        });
    });
});

describe('executionQuotesLive', () => {
    it('validates the exact-mint batch contract', async () => {
        const d = deps(async () => null);
        await expect(executionQuotesLive(d, null)).rejects.toThrow('args must be an object');
        await expect(executionQuotesLive(d, { mint: MINT, side: 'hold', amounts: [], tokenDecimals: 8 })).rejects.toThrow(
            'side must be buy or sell',
        );
        await expect(executionQuotesLive(d, { mint: MINT, side: 'buy', amounts: [], tokenDecimals: 8 })).rejects.toThrow(
            'at least one amount is required',
        );
        await expect(
            executionQuotesLive(d, { mint: MINT, side: 'buy', amounts: ['0.5'], tokenDecimals: 8 }),
        ).rejects.toThrow('amountUsd must be between 1 and 50000000');
    });

    it('quotes buys from USDC into the exact selected mint and preserves raw data', async () => {
        const calls: Array<{ inputMint: string; outputMint: string; amountRaw: string; timeoutMs?: number }> = [];
        const result = await executionQuotesLive(
            deps(async args => {
                calls.push(args);
                return exactQuote(args.amountRaw);
            }),
            { mint: MINT, side: 'buy', amounts: ['10000', '25000'], tokenDecimals: 8 },
        );

        expect(result).toMatchObject({ providers: ['jupiter', 'titan'], mint: MINT, side: 'buy', quoteMint: USDC });
        // Provider calls also carry a per-call timeout derived from the budget.
        expect(calls.map(({ inputMint, outputMint, amountRaw }) => ({ inputMint, outputMint, amountRaw }))).toEqual([
            { inputMint: USDC, outputMint: MINT, amountRaw: '10000000000' },
            { inputMint: USDC, outputMint: MINT, amountRaw: '25000000000' },
        ]);
        expect(result.entries[0]).toMatchObject({
            status: 'available',
            provider: 'jupiter',
            request: { unit: 'usd', amount: '10000', rawAmount: '10000000000' },
            outAmountRaw: '123456789012345678',
            priceImpactPct: 0.42,
            contextSlot: 123,
            router: 'metis',
            mode: 'ultra',
            fees: {
                feeBps: 10,
                feeMint: USDC,
                platformFee: { amountRaw: null, feeBps: 10, feeMint: USDC },
            },
            quotedAt: '2023-11-14T22:13:20.000Z',
        });
        expect(result.entries[0]?.candidates.map(candidate => candidate.provider)).toEqual(['jupiter', 'titan']);
    });

    it('reverses the pair for exact token sells and respects token decimals', async () => {
        const calls: Array<{ inputMint: string; outputMint: string; amountRaw: string }> = [];
        const result = await executionQuotesLive(
            deps(async args => {
                calls.push(args);
                return exactQuote(args.amountRaw);
            }),
            { mint: MINT, side: 'sell', amounts: ['12.50000001'], tokenDecimals: 8 },
        );
        expect(calls[0]).toMatchObject({ inputMint: MINT, outputMint: USDC, amountRaw: '1250000001' });
        expect(result.entries[0]?.request).toEqual({ unit: 'token', amount: '12.50000001', rawAmount: '1250000001' });
        await expect(
            executionQuotesLive(deps(async () => null), {
                mint: MINT,
                side: 'sell',
                amounts: ['1.000000001'],
                tokenDecimals: 8,
            }),
        ).rejects.toThrow('more than 8 decimal places');
    });

    it('dedupes equivalent amounts, preserves order, and caps the batch at nine', async () => {
        const d = deps(async args => exactQuote(args.amountRaw));
        const result = await executionQuotesLive(d, {
            mint: MINT,
            side: 'buy',
            amounts: ['10.0', '25', '10.00'],
            tokenDecimals: 8,
        });
        expect(result.entries.map(entry => entry.request.amount)).toEqual(['10', '25']);

        await expect(
            executionQuotesLive(d, {
                mint: MINT,
                side: 'buy',
                amounts: Array.from({ length: 10 }, (_, index) => String(index + 1)),
                tokenDecimals: 8,
            }),
        ).rejects.toThrow('at most 9 unique amounts');
    });

    it('limits quote concurrency to two', async () => {
        let active = 0;
        let maxActive = 0;
        const d = deps(async args => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            active -= 1;
            return exactQuote(args.amountRaw);
        });
        await executionQuotesLive(d, {
            mint: MINT,
            side: 'buy',
            amounts: ['10', '20', '30', '40', '50'],
            tokenDecimals: 8,
        });
        expect(maxActive).toBe(2);
    });

    it('returns explicit unavailable rows for nulls and transport failures', async () => {
        const result = await executionQuotesLive(
            deps(async args => {
                if (args.amountRaw === '10000000') return null;
                throw new Error('rate limited');
            }),
            { mint: MINT, side: 'buy', amounts: ['10', '25'], tokenDecimals: 8 },
        );
        expect(result.entries).toHaveLength(2);
        for (const entry of result.entries) {
            expect(entry).toMatchObject({
                status: 'unavailable',
                inAmountRaw: null,
                outAmountRaw: null,
                route: [],
            });
            // Both rungs end unavailable, but for reasons the caller can act on:
            // a null quote is a market answer, a thrown error is not.
            if (entry.status !== 'unavailable') throw new Error('expected an unavailable entry');
            expect(entry.reason).toBe('no_route');
        }
        const jupiterReasons = result.entries.map(entry => {
            const candidate = entry.candidates.find(c => c.provider === 'jupiter')!;
            return candidate.status === 'unavailable' ? candidate.reason : 'available';
        });
        expect(jupiterReasons).toEqual(['no_route', 'error']);
    });

    it('selects Titan only when its raw output is greater and Jupiter on ties', async () => {
        const titanWins = await executionQuotesLive(
            deps(
                async args => exactQuote(args.amountRaw, '100'),
                () => 1_700_000_000_000,
                async args => ({ ...exactQuote(args.amountRaw, '101'), priceImpactPct: null }),
            ),
            { mint: MINT, side: 'buy', amounts: ['10'], tokenDecimals: 8 },
        );
        expect(titanWins.entries[0]).toMatchObject({ status: 'available', provider: 'titan', outAmountRaw: '101' });

        const tie = await executionQuotesLive(
            deps(
                async args => exactQuote(args.amountRaw, '100'),
                () => 1_700_000_000_000,
                async args => ({ ...exactQuote(args.amountRaw, '100'), priceImpactPct: null }),
            ),
            { mint: MINT, side: 'buy', amounts: ['10'], tokenDecimals: 8 },
        );
        expect(tie.entries[0]).toMatchObject({ status: 'available', provider: 'jupiter' });
    });

    it('uses either provider independently and preserves candidate order', async () => {
        const onlyTitan = await executionQuotesLive(
            deps(
                async () => null,
                () => 1_700_000_000_000,
                async args => ({ ...exactQuote(args.amountRaw, '9007199254740993'), priceImpactPct: null }),
            ),
            { mint: MINT, side: 'sell', amounts: ['12.5'], tokenDecimals: 8 },
        );
        expect(onlyTitan.entries[0]).toMatchObject({
            status: 'available',
            provider: 'titan',
            outAmountRaw: '9007199254740993',
            priceImpactPct: null,
        });
        expect(onlyTitan.entries[0]?.candidates.map(candidate => [candidate.provider, candidate.status])).toEqual([
            ['jupiter', 'unavailable'],
            ['titan', 'available'],
        ]);
    });

    it('degrades missing Jupiter configuration to an explicit Titan-only result', async () => {
        const d = deps(
            async () => {
                throw new Error('unconfigured Jupiter must not be called');
            },
            () => 1_700_000_000_000,
            async args => ({
                ...exactQuote(args.amountRaw, '101'),
                priceImpactPct: null,
                router: null,
                mode: null,
                fees: null,
            }),
        );
        delete d.jupiterQuoteSource;

        const result = await executionQuotesLive(d, {
            mint: MINT,
            side: 'buy',
            amounts: ['10'],
            tokenDecimals: 8,
        });
        expect(result.entries[0]).toMatchObject({ status: 'available', provider: 'titan', outAmountRaw: '101' });
        expect(result.entries[0]?.candidates).toMatchObject([
            { provider: 'jupiter', status: 'unavailable', reason: 'error' },
            { provider: 'titan', status: 'available', router: null, mode: null, fees: null },
        ]);
    });

    it('formats integer strings without precision loss', () => {
        expect(formatRawAmount('123456789012345678', 8)).toBe('1234567890.12345678');
    });
});

describe('depthSampleMints', () => {
    function syntheticQuote(amount: number): DepthQuote {
        return { inAmount: amount, outAmount: amount * 0.99, routeVenues: [] };
    }

    function sampleDeps(args: {
        handler: (a: { outputMint: string; amount: number }) => Promise<DepthQuote | null>;
        existing?: Array<{ mint: string; lastComputedAt: number }>;
    }) {
        const upserts: Array<{ mint: string; points: number }> = [];
        const quoteSource: DepthQuoteClient = {
            id: 'jupiter_lite',
            async fetchQuote(q) {
                return args.handler({ outputMint: q.outputMint, amount: q.amount });
            },
            async close() {},
        };
        const sampleDependencies = {
            quoteSource,
            curvesRepo: {
                async selectStalestDepthMints() {
                    return [];
                },
                async upsertVariantDepthCurve(row: { mint: string; points: number }) {
                    upserts.push({ mint: row.mint, points: row.points });
                },
            },
            readsRepo: {
                async findLatestByMints() {
                    return (args.existing ?? []).map(row => ({
                        mint: row.mint,
                        quote_mint: USDC,
                        side: 'buy',
                        source: 'jupiter_lite',
                        ladder: [],
                        points: 0,
                        failed_points: 0,
                        as_of: 0,
                        last_computed_at: row.lastComputedAt,
                    }));
                },
            },
            now: () => 1_700_000_000_000,
        };
        return { deps: sampleDependencies as never, upserts };
    }

    it('keeps the stored depth sampler independent', async () => {
        const { deps, upserts } = sampleDeps({ handler: async ({ amount }) => syntheticQuote(amount) });
        const result = await depthSampleMints(deps, { mints: [MINT] });
        expect(result.sampled).toEqual([MINT]);
        expect(upserts).toEqual([{ mint: MINT, points: 4 }]);
    });

    it('preserves depth freshness and failure behavior', async () => {
        const fresh = sampleDeps({
            handler: async ({ amount }) => syntheticQuote(amount),
            existing: [{ mint: MINT, lastComputedAt: 1_700_000_000_000 - 60_000 }],
        });
        expect(await depthSampleMints(fresh.deps, { mints: [MINT] })).toMatchObject({ skippedFresh: [MINT] });

        const failed = sampleDeps({ handler: async () => null });
        expect(await depthSampleMints(failed.deps, { mints: [MINT] })).toMatchObject({ sampled: [MINT] });
        expect(failed.upserts).toEqual([{ mint: MINT, points: 0 }]);
    });
});

describe('executionQuotesLive failure classification', () => {
    it('reports no_route when a provider has no route, distinct from an operational failure', async () => {
        const result = await executionQuotesLive(deps(async () => null), {
            mint: MINT,
            side: 'buy',
            amounts: ['10000'],
            tokenDecimals: 8,
        });
        const jupiter = result.entries[0]!.candidates.find(c => c.provider === 'jupiter')!;
        const titan = result.entries[0]!.candidates.find(c => c.provider === 'titan')!;
        if (jupiter.status !== 'unavailable' || titan.status !== 'unavailable') {
            throw new Error('expected both candidates to be unavailable');
        }
        expect(jupiter.reason).toBe('no_route');
        // No Titan client configured at all is a config gap, not a market answer.
        expect(titan.reason).toBe('error');
        const entry = result.entries[0]!;
        if (entry.status !== 'unavailable') throw new Error('expected an unavailable entry');
        expect(entry.reason).toBe('no_route');
    });

    it('maps carried and inferred error shapes to their reasons', async () => {
        const cases: Array<{ thrown: unknown; expected: QuoteUnavailableReason }> = [
            { thrown: Object.assign(new Error('nope'), { quoteReason: 'auth' }), expected: 'auth' },
            { thrown: Object.assign(new Error('bad bytes'), { quoteReason: 'malformed' }), expected: 'malformed' },
            { thrown: new DOMException('too slow', 'TimeoutError'), expected: 'timeout' },
            { thrown: { _tag: 'UpstreamHttpError', status: 403 }, expected: 'auth' },
            { thrown: { _tag: 'UpstreamDataError' }, expected: 'malformed' },
            { thrown: { _tag: 'JsonParseError' }, expected: 'malformed' },
            { thrown: { _tag: 'FetchFailedError', cause: 'timeout' }, expected: 'timeout' },
            { thrown: new Error('who knows'), expected: 'error' },
        ];

        for (const { thrown, expected } of cases) {
            const result = await executionQuotesLive(
                deps(async () => {
                    throw thrown;
                }),
                { mint: MINT, side: 'buy', amounts: ['10000'], tokenDecimals: 8 },
            );
            const jupiter = result.entries[0]!.candidates.find(c => c.provider === 'jupiter')!;
            if (jupiter.status !== 'unavailable') throw new Error('expected an unavailable candidate');
            expect(jupiter.reason).toBe(expected);
        }
    });

    it('returns partial results instead of failing when the budget runs out', async () => {
        // Clock jumps past the budget after the first batch resolves.
        let calls = 0;
        let clock = 1_700_000_000_000;
        const result = await executionQuotesLive(
            deps(
                async () => {
                    calls += 1;
                    clock += 9_000;
                    return exactQuote('10000000000');
                },
                () => clock,
            ),
            { mint: MINT, side: 'buy', amounts: ['10000', '100000', '1000000'], tokenDecimals: 8, timeoutMs: 2_000 },
        );

        expect(result.entries).toHaveLength(3);
        // First batch quoted; the rest are reported as timed out, not dropped.
        expect(result.entries[0]!.status).toBe('available');
        const timedOut = result.entries.filter(
            entry => entry.status === 'unavailable' && entry.reason === 'timeout',
        );
        expect(timedOut.length).toBeGreaterThan(0);
        // Timed-out rungs never reach the providers.
        expect(calls).toBeLessThan(3);
    });

    it('passes a per-call timeout down to the providers', async () => {
        const seen: Array<number | undefined> = [];
        await executionQuotesLive(
            deps(async args => {
                seen.push(args.timeoutMs);
                return exactQuote(args.amountRaw);
            }),
            { mint: MINT, side: 'buy', amounts: ['10000'], tokenDecimals: 8, timeoutMs: 6_000 },
        );
        expect(seen[0]).toBeGreaterThan(0);
        expect(seen[0]).toBeLessThanOrEqual(6_000);
    });
});

describe('limitQuoteConcurrency', () => {
    it('caps in-flight fetchQuote calls without dropping any', async () => {
        let inFlight = 0;
        let peak = 0;
        const client = {
            id: 'jupiter' as const,
            async fetchQuote(_args: { inputMint: string; outputMint: string; amountRaw: string }) {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise(resolve => setTimeout(resolve, 5));
                inFlight -= 1;
                return null;
            },
        };
        const limited = limitQuoteConcurrency(client, createConcurrencyLimiter(2));
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                limited.fetchQuote({ inputMint: 'a', outputMint: 'b', amountRaw: '1' }),
            ),
        );
        expect(results).toHaveLength(8);
        expect(peak).toBeLessThanOrEqual(2);
    });

    it('propagates rejections through the limiter', async () => {
        const limited = limitQuoteConcurrency(
            {
                id: 'titan' as const,
                async fetchQuote(_args: { inputMint: string; outputMint: string; amountRaw: string }): Promise<null> {
                    throw new Error('boom');
                },
            },
            createConcurrencyLimiter(1),
        );
        await expect(limited.fetchQuote({ inputMint: 'a', outputMint: 'b', amountRaw: '1' })).rejects.toThrow('boom');
    });
});
