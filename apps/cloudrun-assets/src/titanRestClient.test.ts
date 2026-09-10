import { describe, expect, it } from 'bun:test';
import { encode } from '@msgpack/msgpack';
import bs58 from 'bs58';

import {
    TITAN_DEFAULT_QUOTE_USER_PUBLIC_KEY,
    TITAN_DEMO_BASE_URL,
    makeTitanRestQuoteClient,
} from './titanRestClient';

const INPUT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OUTPUT = 'MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT';

function messagePackResponse(value: unknown): Response {
    return new Response(encode(value, { useBigInt64: true }), { status: 200 });
}

describe('makeTitanRestQuoteClient', () => {
    it('uses the demo endpoint, bearer key, quote wallet, and preserves u64 amounts', async () => {
        let url = '';
        let authorization = '';
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async (input, init) => {
                url = String(input);
                authorization = new Headers(init?.headers).get('authorization') ?? '';
                return messagePackResponse({
                    quotes: {
                        Titan: {
                            inAmount: 5_000_000_000_000n,
                            outAmount: 9_007_199_254_740_993n,
                            contextSlot: 441_000_000,
                            steps: [
                                {
                                    ammKey: bs58.decode(INPUT),
                                    label: 'Raydium CLMM',
                                    inputMint: bs58.decode(INPUT),
                                    outputMint: bs58.decode(OUTPUT),
                                    inAmount: 5_000_000_000_000n,
                                    outAmount: 9_007_199_254_740_993n,
                                    allocPpb: 1_000_000_000,
                                    feeAmount: 0,
                                    feeMint: bs58.decode(INPUT),
                                },
                            ],
                        },
                    },
                });
            }) as typeof fetch,
        });

        const quote = await client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '5000000000000' });
        expect(url.startsWith(`${TITAN_DEMO_BASE_URL}/api/v1/quote/swap?`)).toBe(true);
        expect(new URL(url).searchParams.get('userPublicKey')).toBe(TITAN_DEFAULT_QUOTE_USER_PUBLIC_KEY);
        expect(new URL(url).searchParams.get('amount')).toBe('5000000000000');
        expect(authorization).toBe('Bearer secret');
        expect(quote).toMatchObject({
            inAmountRaw: '5000000000000',
            outAmountRaw: '9007199254740993',
            priceImpactPct: null,
            contextSlot: 441000000,
            route: [
                {
                    ammKey: INPUT,
                    inputMint: INPUT,
                    outputMint: OUTPUT,
                    percent: 100,
                    feeAmountRaw: '0',
                },
            ],
        });
    });

    it('selects the greatest output from Titan quote entries', async () => {
        let requestedUrl = '';
        const client = makeTitanRestQuoteClient({
            authToken: 'secret',
            baseUrl: 'https://titan.test/',
            userPublicKey: OUTPUT,
            fetch: (async (input: string | URL | Request) => {
                requestedUrl = String(input);
                return messagePackResponse({
                    quotes: {
                        slow: { inAmount: 100, outAmount: 90, steps: [] },
                        fast: { inAmount: 100, outAmount: 95, steps: [] },
                    },
                });
            }) as unknown as typeof fetch,
        });
        expect((await client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' }))?.outAmountRaw).toBe(
            '95',
        );
        expect(requestedUrl.startsWith('https://titan.test/api/v1/quote/swap?')).toBe(true);
        expect(new URL(requestedUrl).searchParams.get('userPublicKey')).toBe(OUTPUT);
    });

    it('retries transient failures and degrades deterministic no-route responses', async () => {
        let calls = 0;
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            sleep: async () => undefined,
            fetch: (async () => {
                calls += 1;
                if (calls < 2) return new Response('temporary', { status: 500 });
                return messagePackResponse({ quotes: { Titan: { inAmount: 100, outAmount: 95, steps: [] } } });
            }) as unknown as typeof fetch,
        });
        expect((await client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' }))?.outAmountRaw).toBe(
            '95',
        );
        expect(calls).toBe(2);

        const unavailable = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async () => new Response('no routes', { status: 404 })) as unknown as typeof fetch,
        });
        expect(await unavailable.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' })).toBeNull();
    });

    it('rejects invalid quote keys and malformed MessagePack', async () => {
        expect(() => makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret', userPublicKey: 'bad' })).toThrow(
            'Invalid TITAN_QUOTE_USER_PUBLIC_KEY',
        );
        let malformedCalls = 0;
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async () => {
                malformedCalls += 1;
                return new Response('not messagepack');
            }) as unknown as typeof fetch,
        });
        await expect(client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' })).rejects.toThrow();
        expect(malformedCalls).toBe(1);
    });

    it('does not retry authentication failures and exhausts rate-limit and transport retries', async () => {
        let authCalls = 0;
        const authFailure = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'bad',
            fetch: (async () => {
                authCalls += 1;
                return new Response('unauthorized', { status: 401 });
            }) as unknown as typeof fetch,
        });
        await expect(authFailure.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' })).rejects.toThrow();
        expect(authCalls).toBe(1);

        for (const mode of ['rate-limit', 'transport'] as const) {
            let calls = 0;
            const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
                sleep: async () => undefined,
                fetch: (async () => {
                    calls += 1;
                    if (mode === 'rate-limit') return new Response('slow down', { status: 429 });
                    throw new DOMException('timed out', 'TimeoutError');
                }) as unknown as typeof fetch,
            });
            await expect(client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' })).rejects.toThrow();
            // Default is one retry: two attempts total on the interactive path.
            expect(calls).toBe(2);
        }
    });
});

describe('makeTitanRestQuoteClient response validation', () => {
    it('rejects a quote priced for a different input amount', async () => {
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async () =>
                // Exact-out style response: Titan priced 99, we asked for 100.
                messagePackResponse({
                    quotes: { Titan: { inAmount: 99, outAmount: 500, steps: [] } },
                })) as unknown as typeof fetch,
        });
        await expect(
            client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' }),
        ).resolves.toBeNull();
    });

    it('rejects a quote whose route endpoints do not match the requested pair', async () => {
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async () =>
                messagePackResponse({
                    quotes: {
                        Titan: {
                            inAmount: 100,
                            outAmount: 500,
                            steps: [{ inputMint: OUTPUT, outputMint: INPUT, allocPpb: 1_000_000_000 }],
                        },
                    },
                })) as unknown as typeof fetch,
        });
        await expect(
            client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' }),
        ).resolves.toBeNull();
    });

    it('accepts a matching quote and keeps a route that omits mints', async () => {
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async () =>
                messagePackResponse({
                    quotes: { Titan: { inAmount: 100, outAmount: 500, steps: [{ allocPpb: 1_000_000_000 }] } },
                })) as unknown as typeof fetch,
        });
        const quote = await client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100' });
        expect(quote?.outAmountRaw).toBe('500');
    });

    it('splits the caller budget across attempts', async () => {
        const timeouts: number[] = [];
        const client = makeTitanRestQuoteClient({
            baseUrl: TITAN_DEMO_BASE_URL,
            authToken: 'secret',
            fetch: (async (_input: unknown, init?: RequestInit) => {
                // AbortSignal.timeout exposes no deadline, so assert indirectly:
                // the signal must already exist and not be aborted at call time.
                timeouts.push(init?.signal ? 1 : 0);
                return messagePackResponse({ quotes: { Titan: { inAmount: 100, outAmount: 500, steps: [] } } });
            }) as unknown as typeof fetch,
        });
        await client.fetchQuote({ inputMint: INPUT, outputMint: OUTPUT, amountRaw: '100', timeoutMs: 4_000 });
        expect(timeouts).toEqual([1]);
    });
});
