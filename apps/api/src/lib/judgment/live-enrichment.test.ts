/**
 * Live enrichment tier: provider calls only for uncovered mints, cached per
 * mint, one deadline per request, budget charged only when the provider is
 * reached. I/O is stubbed at the fetch boundary; Redis and the after-response
 * scheduler are injected.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { liveEnrich, __resetLiveEnrichmentForTesting } = await import('./live-enrichment');
import type { RedisClient } from '@/lib/redis';

const MINT_A = 'ZzqxMint111111111111111111111111111111111111';
const MINT_B = 'ZzqxMint222222222222222222222222222222222222';

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeRedis() {
    const store = new Map<string, { value: string; ex?: number }>();
    const client = {
        get: async <T = string>(key: string) => (store.get(key)?.value ?? null) as T | null,
        set: async (key: string, value: string | number, options?: { ex?: number }) => {
            store.set(key, { value: String(value), ex: options?.ex });
            return 'OK' as const;
        },
    } as unknown as RedisClient;
    return { client, store };
}

function scheduler() {
    const scheduled: Array<Effect.Effect<void, never>> = [];
    return {
        schedule: (effect: Effect.Effect<void, never>) => void scheduled.push(effect),
        run: async () => {
            for (const effect of scheduled.splice(0)) await Effect.runPromise(effect);
        },
        get size() {
            return scheduled.length;
        },
    };
}

let overviewCalls: string[] = [];
let securityCalls: string[] = [];
let overviewDelayMs = 0;
let overviewStatus = 200;
let securityStatus = 200;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;
const ORIGINAL_KEY = process.env.BIRDEYE_API_KEY;
const ORIGINAL_FLAG = process.env.TOKENS_JUDGE_LIVE_ENRICHMENT;

beforeEach(() => {
    process.env.BIRDEYE_API_KEY = 'test';
    delete process.env.TOKENS_JUDGE_LIVE_ENRICHMENT;
    overviewCalls = [];
    securityCalls = [];
    overviewDelayMs = 0;
    overviewStatus = 200;
    securityStatus = 200;
    console.log = () => undefined;
    __resetLiveEnrichmentForTesting();
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        const mint = new URL(url).searchParams.get('address') ?? '';
        if (url.includes('/defi/token_overview')) {
            overviewCalls.push(mint);
            if (overviewDelayMs > 0) await new Promise(resolve => setTimeout(resolve, overviewDelayMs));
            if (overviewStatus !== 200) return json({ success: false }, overviewStatus);
            return json({
                success: true,
                data: {
                    liquidity: 40_000,
                    marketCap: 900_000,
                    holder: 1_234,
                    v24hUSD: 12_000,
                    uniqueWallet24h: 300,
                    price: 0.5,
                },
            });
        }
        if (url.includes('/defi/token_security')) {
            securityCalls.push(mint);
            if (securityStatus !== 200) return json({ success: false }, securityStatus);
            return json({
                success: true,
                data: {
                    top10HolderPercent: 0.62,
                    creationTime: 1_700_000_000,
                    ownerAddress: 'Mint11111111111111111111111111111111111111',
                    freezeable: false,
                    freezeAuthority: null,
                    mutableMetadata: true,
                    transferFeeEnable: false,
                },
            });
        }
        throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    if (ORIGINAL_KEY === undefined) delete process.env.BIRDEYE_API_KEY;
    else process.env.BIRDEYE_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_FLAG === undefined) delete process.env.TOKENS_JUDGE_LIVE_ENRICHMENT;
    else process.env.TOKENS_JUDGE_LIVE_ENRICHMENT = ORIGINAL_FLAG;
    __resetLiveEnrichmentForTesting();
});

describe('liveEnrich', () => {
    it('nothing needed → none, no provider call, no budget', async () => {
        let charged = 0;
        const out = await Effect.runPromise(
            liveEnrich([{ mint: MINT_A, market: false, security: false }], {
                budget: Effect.sync(() => void (charged += 1)),
            }),
        );
        expect(out.outcome).toBe('none');
        expect(charged).toBe(0);
        expect(overviewCalls.length + securityCalls.length).toBe(0);
    });

    it('an uncovered mint → two provider calls, normalized facts, budget charged once; the repeat is a free cache hit', async () => {
        const redis = fakeRedis();
        const after = scheduler();
        let charged = 0;
        const opts = {
            budget: Effect.sync(() => void (charged += 1)),
            getRedis: () => Effect.succeed(redis.client),
            scheduleAfterResponse: after.schedule,
        };
        const first = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }], opts));
        expect(first.outcome).toBe('ok');
        expect(first.liveLookups).toBe(1);
        expect(charged).toBe(1);
        expect(overviewCalls).toEqual([MINT_A]);
        expect(securityCalls).toEqual([MINT_A]);
        const facts = first.byMint.get(MINT_A)!;
        expect(facts.market?.liquidity).toBe(40_000);
        expect(facts.market?.uniqueWallet24h).toBe(300);
        expect(facts.security?.top10HoldersPercent).toBe(62);
        expect(facts.security?.mintable).toBe(true);
        expect(facts.security?.freezable).toBe(false);
        expect(facts.security?.mutableMetadata).toBe(true);
        expect(facts.security?.tokenMintTime).toBe(new Date(1_700_000_000 * 1000).toISOString());

        await after.run();
        expect(redis.store.get(`judge-live:v1:${MINT_A}`)?.ex).toBe(600);

        const second = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }], opts));
        expect(second.outcome).toBe('ok');
        expect(second.liveLookups).toBe(0);
        expect(charged).toBe(1);
        expect(overviewCalls.length).toBe(1);
    });

    it('only the uncovered half is fetched (market row exists, security does not)', async () => {
        const out = await Effect.runPromise(
            liveEnrich([{ mint: MINT_A, market: false, security: true }], {
                getRedis: () => Effect.fail(new Error('no redis')),
                scheduleAfterResponse: () => undefined,
            }),
        );
        expect(out.outcome).toBe('ok');
        expect(overviewCalls).toEqual([]);
        expect(securityCalls).toEqual([MINT_A]);
        expect(out.byMint.get(MINT_A)?.market === undefined).toBe(true);
    });

    it('a 404 from the provider is a cached miss (null facts), not an error', async () => {
        overviewStatus = 404;
        securityStatus = 404;
        const redis = fakeRedis();
        const after = scheduler();
        const opts = { getRedis: () => Effect.succeed(redis.client), scheduleAfterResponse: after.schedule };
        const out = await Effect.runPromise(liveEnrich([{ mint: MINT_B, market: true, security: true }], opts));
        expect(out.outcome).toBe('ok');
        expect(out.byMint.get(MINT_B)?.market).toBeNull();
        expect(out.byMint.get(MINT_B)?.security).toBeNull();
        await after.run();
        expect(redis.store.get(`judge-live:v1:${MINT_B}`)?.ex).toBe(900);
        // Known-miss is served from cache: no second provider call.
        await Effect.runPromise(liveEnrich([{ mint: MINT_B, market: true, security: true }], opts));
        expect(overviewCalls.length).toBe(1);
    });

    it('a slow provider misses the deadline → degraded now, warmed after the response', async () => {
        overviewDelayMs = 120;
        const redis = fakeRedis();
        const after = scheduler();
        const opts = {
            getRedis: () => Effect.succeed(redis.client),
            scheduleAfterResponse: after.schedule,
            deadlineMs: 30,
        };
        const out = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }], opts));
        expect(out.outcome).toBe('degraded');
        expect(out.pending).toEqual([MINT_A]);
        expect(out.byMint.has(MINT_A)).toBe(false);
        expect(after.size).toBe(1);
        await after.run();
        const warmed = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }], opts));
        expect(warmed.outcome).toBe('ok');
        expect(warmed.liveLookups).toBe(0);
        expect(warmed.byMint.get(MINT_A)?.market?.liquidity).toBe(40_000);
        expect(overviewCalls.length).toBe(1);
    });

    it('a budget failure stops before the provider is reached', async () => {
        const failing = Effect.fail(new Error('budget exhausted'));
        const error = await Effect.runPromise(
            Effect.flip(
                liveEnrich([{ mint: MINT_A, market: true, security: true }], {
                    budget: failing,
                    getRedis: () => Effect.fail(new Error('no redis')),
                    scheduleAfterResponse: () => undefined,
                }),
            ),
        );
        expect((error as Error).message).toBe('budget exhausted');
        expect(overviewCalls.length + securityCalls.length).toBe(0);
    });

    it('disabled without a provider key or with the kill switch', async () => {
        delete process.env.BIRDEYE_API_KEY;
        const a = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }]));
        expect(a.outcome).toBe('disabled');
        process.env.BIRDEYE_API_KEY = 'test';
        process.env.TOKENS_JUDGE_LIVE_ENRICHMENT = 'off';
        const b = await Effect.runPromise(liveEnrich([{ mint: MINT_A, market: true, security: true }]));
        expect(b.outcome).toBe('disabled');
        expect(overviewCalls.length).toBe(0);
    });
});
