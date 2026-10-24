/**
 * `gatherCandidates`: cached collect → live enrich, with the provider budget
 * charged only on a cache miss. I/O is stubbed at the fetch boundary (the
 * same seam the other route tests use) plus the advisories / curated
 * membership test seams — no module mocks, so nothing bleeds into other
 * files in the same bun process. The registry is the real compiled one, so
 * queries are chosen not to match any alias.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { gatherCandidates } = await import('./candidates');
const { classifyQuery } = await import('./intent');
const { __resetCandidateCacheForTesting } = await import('./candidate-cache');
const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { __setAdvisoriesForTests } = await import('@/lib/advisories');
const { __setCuratedMembershipSnapshotForTests } = await import('@/lib/curated-membership');
const { __resetDeletedRefsForTests } = await import('@/lib/deleted-refs');

const ZZ_MINT = 'ZzqxMint111111111111111111111111111111111111';
const ZZ2_MINT = 'ZzqxMint222222222222222222222222222222222222';

let providerCalls = 0;
let providerFails = false;
let dbCalls = 0;
let marketCalls = 0;
let providerKeywords: string[] = [];
let dbQueries: string[] = [];

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ERROR = console.error;
const ORIGINAL_LOG = console.log;
const ENV_KEYS = [
    'BIRDEYE_API_KEY',
    'TOKENS_JUDGED_CANDIDATE_CACHE',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_DELETED_REFS_MEMO',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.BIRDEYE_API_KEY = 'test';
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_DELETED_REFS_MEMO = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetCandidateCacheForTesting();
    __resetDeletedRefsForTests();
    __setAdvisoriesForTests([]);
    __setCuratedMembershipSnapshotForTests({ loadedAt: Date.now(), mintsByList: {}, allMints: [], entriesByMint: {} });
    providerCalls = 0;
    providerFails = false;
    dbCalls = 0;
    marketCalls = 0;
    providerKeywords = [];
    dbQueries = [];
    console.error = () => undefined;
    console.log = () => undefined;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('public-api.birdeye.so/defi/v3/search')) {
            providerCalls += 1;
            providerKeywords.push(new URL(url).searchParams.get('keyword') ?? '');
            if (providerFails) return json({ success: false }, 503);
            return json({
                success: true,
                data: {
                    items: [
                        {
                            type: 'token',
                            result: [
                                {
                                    address: ZZ_MINT,
                                    symbol: 'ZZQX',
                                    name: 'Zzqx Token',
                                    decimals: 6,
                                    price: 2,
                                    liquidity: 50_000,
                                    volume_24h_usd: 1_000,
                                    market_cap: 100_000,
                                    price_change_24h_percent: 0,
                                    holder: 5,
                                },
                            ],
                        },
                    ],
                },
            });
        }
        const name = /\/query\/([A-Za-z]+)$/.exec(url)?.[1] ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        switch (name) {
            case 'tokensSearchTokens':
                dbCalls += 1;
                dbQueries.push(String(body.query));
                return json([
                    {
                        address: ZZ2_MINT,
                        symbol: 'ZZQX2',
                        name: 'Zzqx Two',
                        decimals: 9,
                        liquidity: 10,
                        volume24hUSD: 0,
                        price: 0,
                        priceChange24hPercent: 0,
                        marketCap: 0,
                    },
                ]);
            case 'variantMarketsGetLatestByMints':
                marketCalls += 1;
                return json((body.mints as string[]).map(mint => ({ mint, market: null })));
            case 'variantFillQualityGetLatestByMints':
                return json((body.mints as string[]).map(mint => ({ mint, fillQuality: null })));
            case 'listDeletedRefs':
                return json([]);
            default:
                throw new Error(`unexpected fetch: ${url}`);
        }
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.error = ORIGINAL_ERROR;
    console.log = ORIGINAL_LOG;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetCandidateCacheForTesting();
    __resetDeletedRefsForTests();
    __setAdvisoriesForTests(null);
    __setCuratedMembershipSnapshotForTests(null);
});

const noRedis = {
    getClient: () => {
        throw new Error('not configured');
    },
    scheduleWrite: () => undefined,
};

function gather(q: string, budget?: Effect.Effect<void, unknown>) {
    return Effect.runPromise(gatherCandidates(q, classifyQuery(q), { budget, cache: noRedis }));
}

describe('gatherCandidates', () => {
    it('miss: charges the budget once, hits provider + index, merges and enriches', async () => {
        let charged = 0;
        const out = await gather(
            'zzqx',
            Effect.sync(() => void (charged += 1)),
        );
        expect(charged).toBe(1);
        expect(providerCalls).toBe(1);
        expect(dbCalls).toBe(1);
        expect(marketCalls).toBe(1);
        expect(out.sources).toEqual({ provider: 'ok', db: 'ok', registry: 'ok', cache: 'miss' });
        expect(out.candidates.map(c => c.mint)).toEqual([ZZ_MINT, ZZ2_MINT]);
        expect(out.candidates[0]?.sources).toEqual(['provider']);
        expect(out.candidates[0]?.liquidityUsd).toBe(50_000);
        expect(out.candidates[1]?.sources).toEqual(['db']);
        expect(out.timing.collectMs).toBeGreaterThanOrEqual(0);
    });

    it('hit: the same normalized query skips the budget and the sources but still enriches live', async () => {
        await gather('zzqx');
        __setAdvisoriesForTests([{ mint: ZZ_MINT, status: 'blocked', reason: 'test', url: null, since: 1 }]);
        let charged = 0;
        const out = await gather(
            'ZZQX',
            Effect.sync(() => void (charged += 1)),
        );
        expect(charged).toBe(0);
        expect(providerCalls).toBe(1);
        expect(dbCalls).toBe(1);
        expect(marketCalls).toBe(2);
        expect(out.sources.cache).toBe('hit');
        // Editorial state is live even on a cache hit.
        expect(out.candidates[0]?.advisory?.status).toBe('blocked');
    });

    it('a budget failure on a miss fails the gather and caches nothing', async () => {
        const failing = Effect.fail(new Error('budget exhausted'));
        const error = await Effect.runPromise(
            Effect.flip(gatherCandidates('zzqx', classifyQuery('zzqx'), { budget: failing, cache: noRedis })),
        );
        expect((error as Error).message).toBe('budget exhausted');
        expect(providerCalls).toBe(0);
        const out = await gather('zzqx');
        expect(out.sources.cache).toBe('miss');
        expect(providerCalls).toBe(1);
    });

    it('provider failure degrades that source; the degraded set is still cached', async () => {
        providerFails = true;
        const first = await gather('zzqx');
        expect(first.sources.provider).toBe('degraded');
        expect(first.candidates.map(c => c.mint)).toEqual([ZZ2_MINT]);
        const second = await gather('zzqx');
        expect(second.sources.cache).toBe('hit');
        expect(second.sources.provider).toBe('degraded');
    });

    it('no provider key → provider disabled, nothing charged for it but the budget still applies on miss', async () => {
        delete process.env.BIRDEYE_API_KEY;
        let charged = 0;
        const out = await gather(
            'zzqx',
            Effect.sync(() => void (charged += 1)),
        );
        expect(out.sources.provider).toBe('disabled');
        expect(providerCalls).toBe(0);
        expect(charged).toBe(1);
    });

    it('TOKENS_JUDGED_CANDIDATE_CACHE=off bypasses the cache and charges every call', async () => {
        process.env.TOKENS_JUDGED_CANDIDATE_CACHE = 'off';
        let charged = 0;
        const budget = Effect.sync(() => void (charged += 1));
        const a = await gather('zzqx', budget);
        const b = await gather('zzqx', budget);
        expect(a.sources.cache).toBe('bypass');
        expect(b.sources.cache).toBe('bypass');
        expect(charged).toBe(2);
        expect(providerCalls).toBe(2);
    });

    it('asks the sources the $-stripped query, so what is cached is what the key describes', async () => {
        await gather(' $Zzqx ');
        expect(providerKeywords).toEqual(['Zzqx']);
        expect(dbQueries).toEqual(['Zzqx']);
        // …and the plain spelling is the same entry.
        const plain = await gather('zzqx');
        expect(plain.sources.cache).toBe('hit');
        expect(providerCalls).toBe(1);
    });

    it('a hit stamps provider-sourced prices with the collection time, not the request time', async () => {
        const first = await gather('zzqx');
        const providerCandidate = first.candidates.find(c => c.mint === ZZ_MINT);
        expect(providerCandidate?.dataAsOf).not.toBeNull();
        await new Promise(resolve => setTimeout(resolve, 15));
        const hit = await gather('zzqx');
        expect(hit.sources.cache).toBe('hit');
        expect(hit.candidates.find(c => c.mint === ZZ_MINT)?.dataAsOf).toBe(providerCandidate!.dataAsOf);
        expect(hit.candidates.find(c => c.mint === ZZ_MINT)!.dataAsOf!).toBeLessThan(Date.now() - 10);
    });

    it('a mint query is a direct lookup keyed on the exact address', async () => {
        const out = await gather(ZZ_MINT);
        expect(out.sources.cache).toBe('miss');
        expect(out.candidates.some(c => c.mint === ZZ_MINT)).toBe(true);
        const again = await gather(ZZ_MINT);
        expect(again.sources.cache).toBe('hit');
    });
});
