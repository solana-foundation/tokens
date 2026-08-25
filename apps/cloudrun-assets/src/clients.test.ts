import { describe, expect, test } from 'bun:test';

import { makeClickhouseClient, makeJupiterSwapV2QuoteClient, makeJupiterTokenMetadataClient } from './clients';

const BASE_OPTS = {
    url: 'http://clickhouse.invalid',
    username: 'u',
    password: 'p',
    database: 'default',
    solanaTradesTable: 'trades_anza_final',
    tradingApiUrl: 'https://trading-api.test/v1/query',
} as const;

describe('fetchSolanaMintSnapshots (clickhouse-api gateway)', () => {
    test('posts the tokens_summary preset and maps rows + price change', async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(
                JSON.stringify({
                    data: [
                        {
                            mint: 'MintA',
                            priceUsd: 110,
                            volume1hUsd: 5,
                            volume24hUsd: 20,
                            trade1h: 2,
                            trade24h: 8,
                            uniqueTrader1h: 1,
                            uniqueTrader24h: 4,
                            price1hAgo: 100,
                            price24hAgo: 50,
                            lastTradeAtMs: 1784018908299,
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }) as unknown as typeof fetch;

        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        const out = await client.fetchSolanaMintSnapshots({
            mints: ['MintA'],
            stableMints: ['USDC'],
            asOfMs: 2_000_000,
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe('https://trading-api.test/v1/query');
        expect(calls[0]?.body).toEqual({
            name: 'tokens_summary',
            params: { mints: ['MintA'], stables: ['USDC'] },
        });
        expect(out).toHaveLength(1);
        const s = out[0]!;
        expect(s.priceUsd).toBe(110);
        expect(s.volume24hUsd).toBe(20);
        expect(s.uniqueTrader24h).toBe(4);
        expect(s.priceChange1hPercent).toBeCloseTo(10); // (110-100)/100*100
        expect(s.priceChange24hPercent).toBeCloseTo(120); // (110-50)/50*100
        expect(s.lastTradeAt).toBe(1784018908299);
        expect(s.asOf).toBe(2000); // floor(asOfMs/1000)
    });

    test('leaves price change null when a reference price is missing', async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ data: [{ mint: 'M', priceUsd: 1, price1hAgo: null }] }), {
                status: 200,
            })) as unknown as typeof fetch;
        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        const [s] = await client.fetchSolanaMintSnapshots({ mints: ['M'], stableMints: ['USDC'] });
        expect(s?.priceChange1hPercent).toBeNull();
        expect(s?.volume24hUsd).toBe(0);
        expect(s?.asOf).toBeNull();
    });

    test('throws on a non-ok gateway response', async () => {
        const fetchImpl = (async () => new Response('upstream boom', { status: 502 })) as unknown as typeof fetch;
        const client = makeClickhouseClient({ ...BASE_OPTS, fetchImpl });
        await expect(
            client.fetchSolanaMintSnapshots({ mints: ['M'], stableMints: ['USDC'] }),
        ).rejects.toThrow('clickhouse-api HTTP 502');
    });
});

describe('Jupiter live evaluation clients', () => {
    test('resolves exact token metadata from the Jupiter token index', async () => {
        const originalFetch = globalThis.fetch;
        let requestUrl = '';
        globalThis.fetch = (async (input: string | URL | Request) => {
            requestUrl = String(input);
            return Response.json([
                { id: 'another-mint', name: 'Other', symbol: 'OTHER', decimals: 9 },
                { id: 'TOKEN', name: 'Sandisk - Backpack Securities', symbol: 'SNDK', decimals: 6 },
            ]);
        }) as unknown as typeof fetch;
        try {
            const client = makeJupiterTokenMetadataClient({ baseUrl: 'https://lite-api.jup.test' });
            expect(await client.fetchTokenMetadata('TOKEN')).toEqual({
                mint: 'TOKEN',
                name: 'Sandisk - Backpack Securities',
                symbol: 'SNDK',
                decimals: 6,
            });
            expect(requestUrl).toBe('https://lite-api.jup.test/tokens/v2/search?query=TOKEN');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('uses quote-only Swap V2 and preserves router, fees, raw amounts, and normalized impact', async () => {
        const originalFetch = globalThis.fetch;
        let requestUrl = '';
        let requestHeaders = new Headers();
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            requestUrl = String(input);
            requestHeaders = new Headers(init?.headers);
            return Response.json({
                inAmount: '10000000000',
                outAmount: '123456789012345678',
                priceImpact: -98.46,
                priceImpactPct: '999',
                router: 'future-router',
                mode: 'ultra',
                transaction: null,
                feeBps: 10,
                feeMint: 'USDC',
                platformFee: { amount: '1000000', feeBps: 10, feeMint: 'USDC' },
                routePlan: [
                    {
                        percent: 0.32,
                        bps: 32,
                        swapInfo: {
                            ammKey: 'amm',
                            label: 'Meteora DLMM',
                            inputMint: 'USDC',
                            outputMint: 'TOKEN',
                            inAmount: '10000000000',
                            outAmount: '123456789012345678',
                        },
                    },
                ],
            });
        }) as unknown as typeof fetch;
        try {
            const client = makeJupiterSwapV2QuoteClient({ baseUrl: 'https://api.jup.test', apiKey: 'secret' });
            const quote = await client.fetchQuote({ inputMint: 'USDC', outputMint: 'TOKEN', amountRaw: '10000000000' });
            const parsedUrl = new URL(requestUrl);
            expect(parsedUrl.pathname).toBe('/swap/v2/order');
            expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({
                inputMint: 'USDC',
                outputMint: 'TOKEN',
                amount: '10000000000',
            });
            expect(parsedUrl.searchParams.has('taker')).toBeFalse();
            expect(parsedUrl.searchParams.has('slippageBps')).toBeFalse();
            expect(requestHeaders.get('x-api-key')).toBe('secret');
            expect(quote).toEqual({
                inAmountRaw: '10000000000',
                outAmountRaw: '123456789012345678',
                priceImpactPct: Math.abs(-98.46) / 100,
                contextSlot: null,
                router: 'future-router',
                mode: 'ultra',
                fees: {
                    feeBps: 10,
                    feeMint: 'USDC',
                    platformFee: { amountRaw: '1000000', feeBps: 10, feeMint: 'USDC' },
                },
                route: [
                    {
                        ammKey: 'amm',
                        label: 'Meteora DLMM',
                        percent: 0.32,
                        inputMint: 'USDC',
                        outputMint: 'TOKEN',
                        inAmountRaw: '10000000000',
                        outAmountRaw: '123456789012345678',
                        feeAmountRaw: null,
                        feeMint: null,
                    },
                ],
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('degrades a Jupiter no-route response to null', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response('{"errorCode":"COULD_NOT_FIND_ANY_ROUTE"}', { status: 400 })) as unknown as typeof fetch;
        try {
            const client = makeJupiterSwapV2QuoteClient({ baseUrl: 'https://api.jup.test', apiKey: 'secret' });
            expect(await client.fetchQuote({ inputMint: 'USDC', outputMint: 'TOKEN', amountRaw: '1' })).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('rejects missing configuration before making a request', () => {
        expect(() => makeJupiterSwapV2QuoteClient({ apiKey: '   ' })).toThrow('JUPITER_API_KEY is required');
    });

    test('classifies malformed raw amounts without falling back to Swap V1', async () => {
        const originalFetch = globalThis.fetch;
        let requestUrl = '';
        globalThis.fetch = (async input => {
            requestUrl = String(input);
            return Response.json({ inAmount: '1', outAmount: 'not-an-integer', priceImpact: -1 });
        }) as typeof fetch;
        try {
            const client = makeJupiterSwapV2QuoteClient({ baseUrl: 'https://api.jup.test', apiKey: 'secret' });
            await expect(client.fetchQuote({ inputMint: 'USDC', outputMint: 'TOKEN', amountRaw: '1' })).rejects.toMatchObject({
                quoteReason: 'malformed',
            });
            expect(requestUrl).toContain('/swap/v2/order?');
            expect(requestUrl).not.toContain('/swap/v1/quote');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('does not retry authentication failures', async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return new Response('{"error":"unauthorized"}', { status: 401 });
        }) as unknown as typeof fetch;
        try {
            const client = makeJupiterSwapV2QuoteClient({ baseUrl: 'https://api.jup.test', apiKey: 'bad-key' });
            await expect(client.fetchQuote({ inputMint: 'USDC', outputMint: 'TOKEN', amountRaw: '1' })).rejects.toMatchObject({
                _tag: 'UpstreamHttpError',
                status: 401,
            });
            expect(calls).toBe(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('retries a transient server failure and keeps the exact input amount', async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            if (calls === 1) return new Response('{"error":"busy"}', { status: 503 });
            return Response.json({
                inAmount: '9007199254740993',
                outAmount: '900719925474099312345',
                priceImpact: -0.1,
                router: 'jupiterz',
                mode: 'ultra',
                transaction: null,
                routePlan: [],
            });
        }) as unknown as typeof fetch;
        try {
            const client = makeJupiterSwapV2QuoteClient({ baseUrl: 'https://api.jup.test', apiKey: 'secret' });
            await expect(
                client.fetchQuote({ inputMint: 'USDC', outputMint: 'TOKEN', amountRaw: '9007199254740993' }),
            ).resolves.toMatchObject({
                inAmountRaw: '9007199254740993',
                outAmountRaw: '900719925474099312345',
                router: 'jupiterz',
            });
            expect(calls).toBe(2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
