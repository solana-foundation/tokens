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

    // Prevents the shared 15s CloudRun `assets.cacheWarmRequest` budget from
    // being blown by a slow rwa.xyz call. Timeout is 5s per attempt with 0
    // retries. The `fetchSolanaTokenAndAssetByMint` client method issues two
    // sequential HTTP calls, so the per-mint worst case is 5s + 5s = 10s
    // (< 15s budget). This test exercises only the first call (which hangs and
    // times out at ~5s), so expected elapsed is ~5s.
    test('rejects with a timeout FetchFailedError when the upstream fetch hangs', async () => {
        // Silence the JSON-lines telemetry `emitEvent` logs the test would otherwise emit.
        console.log = () => {};

        // Prove Effect.timeout actually aborts the underlying fetch (not just
        // discards the promise). If retries or the 30s timeout regress, the
        // abort will still eventually fire — but the elapsed-time assertion
        // below will fail first, catching the regression cleanly.
        let abortObserved = false;

        // A fetch that only resolves when the AbortSignal fires. Effect.timeout
        // interrupts the fiber after 5s, which aborts the underlying fetch.
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
        // Effect wraps FetchFailedError in FiberFailure; check message text.
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message).toContain('rwaxyz');
        expect(message.toLowerCase()).toContain('timed out');

        // Proves Effect.timeout aborts the underlying fetch (not just drops the
        // promise on the floor). Without this, a regression that no longer
        // wires the abort signal through would still time out but leak fetch
        // handles in production.
        expect(abortObserved).toBe(true);

        // 0 retries + 5s per-attempt timeout => expected elapsed ~5s. Assert
        // < 8s so a regression that reintroduces `maxRetries: 1` (worst case
        // ~10s) or the old 30s timeout fails this test.
        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
        expect(elapsedMs).toBeLessThan(8_000);
    }, 15_000);
});
