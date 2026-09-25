import { afterEach, describe, expect, test } from 'bun:test';

import { makeClickhouseClient, makeRwaXyzClient } from './clients';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

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

describe('makeRwaXyzClient timeout', () => {
    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH;
        console.log = ORIGINAL_LOG;
    });

    test('rejects with a timeout FetchFailedError when the upstream fetch hangs', async () => {
        console.log = () => {};

        let abortObserved = false;

        globalThis.fetch = ((_url: string, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted) {
                    abortObserved = true;
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                    return;
                }
                signal?.addEventListener('abort', () => {
                    abortObserved = true;
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                });
            });
        }) as typeof fetch;

        const client = makeRwaXyzClient({ apiKey: 'test-key' });

        const started = Date.now();
        let caught: unknown = null;
        try {
            await client.fetchSolanaTokenAndAssetByMint('SomeMint');
        } catch (err) {
            caught = err;
        }
        const elapsedMs = Date.now() - started;

        expect(caught).not.toBeNull();
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message).toContain('rwaxyz');
        expect(message.toLowerCase()).toContain('timed out');

        expect(abortObserved).toBe(true);

        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
        expect(elapsedMs).toBeLessThan(8_000);
    }, 15_000);
});
