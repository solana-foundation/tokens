import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const {
    __candidateCacheProcessSizeForTesting,
    __resetCandidateCacheForTesting,
    candidateCacheWindowSeconds,
    rawCandidateCacheKey,
    readRawCandidates,
    sourceQueryFor,
    storeRawCandidates,
} = await import('./candidate-cache');

const keyFor = (q: string) => rawCandidateCacheKey(q, classifyQuery(q));
const { classifyQuery } = await import('./intent');

import type { RawCandidate } from './candidate-cache';
import type { RedisClient } from '@/lib/redis';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function raw(mint: string, symbol: string): RawCandidate {
    return {
        mint,
        symbol,
        name: `${symbol} token`,
        decimals: 6,
        logoURI: null,
        price: 1,
        liquidityUsd: 1000,
        volume24hUsd: 100,
        marketCapUsd: 10_000,
        priceChange24hPercent: 0,
        holderCount: 10,
        tokenMintTime: null,
        sources: ['provider'],
    };
}

/** Minimal in-memory Redis: get/set only, TTL tracked for assertions. */
function fakeRedis() {
    const store = new Map<string, { value: string; ex?: number }>();
    let fail = false;
    const client = {
        get: async <T = string>(key: string) => {
            if (fail) throw new Error('redis down');
            return (store.get(key)?.value ?? null) as T | null;
        },
        set: async (key: string, value: string | number, options?: { ex?: number }) => {
            if (fail) throw new Error('redis down');
            store.set(key, { value: String(value), ex: options?.ex });
            return 'OK' as const;
        },
    } as unknown as RedisClient;
    return { client, store, setFail: (value: boolean) => void (fail = value) };
}

/** Run deferred writes inline so assertions can see them. */
const inlineWrite = (effect: Effect.Effect<void, never>) => void Effect.runPromise(effect);

const ENV = ['TOKENS_JUDGED_CANDIDATE_CACHE', 'TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    __resetCandidateCacheForTesting();
});

afterEach(() => {
    for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    __resetCandidateCacheForTesting();
});

describe('rawCandidateCacheKey', () => {
    it('ticker and name queries share an entry across case and the $ prefix', () => {
        const keys = ['bonk', 'BONK', '$bonk', ' Bonk '].map(keyFor);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe('judged:raw:v1:ticker:bonk');
    });

    it('a lookalike spelling gets its own key — it is a different question to the sources', () => {
        // Cyrillic С normalizes to C in the pipeline, but the sources never saw a 'C'.
        expect(keyFor('USD\u0421')).not.toBe(keyFor('USDC'));
    });

    it('a mint address keeps its case and intent', () => {
        expect(keyFor(USDC)).toBe(`judged:raw:v1:mint:${USDC}`);
        expect(keyFor(USDC.toLowerCase())).not.toBe(keyFor(USDC));
    });

    it('name intent is keyed separately from ticker intent', () => {
        expect(keyFor('usd coin')).toBe('judged:raw:v1:name:usd coin');
    });
});

describe('sourceQueryFor', () => {
    it('strips a decorative leading $ and trims, keeps case, passes mints through', () => {
        expect(sourceQueryFor(' $Bonk ', classifyQuery('$Bonk'))).toBe('Bonk');
        expect(sourceQueryFor('$$wif', classifyQuery('$$wif'))).toBe('wif');
        expect(sourceQueryFor('usd coin', classifyQuery('usd coin'))).toBe('usd coin');
        expect(sourceQueryFor(` ${USDC} `, classifyQuery(USDC))).toBe(USDC);
    });

    it('a bare $ stays a $ rather than becoming an empty query', () => {
        expect(sourceQueryFor('$', classifyQuery('$'))).toBe('$');
    });
});

describe('window', () => {
    it('defaults to 45 s, honours the env, clamps to 600', () => {
        expect(candidateCacheWindowSeconds()).toBe(45);
        process.env.TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS = '90';
        expect(candidateCacheWindowSeconds()).toBe(90);
        process.env.TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS = '100000';
        expect(candidateCacheWindowSeconds()).toBe(600);
        process.env.TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS = 'abc';
        expect(candidateCacheWindowSeconds()).toBe(45);
    });
});

describe('read / store', () => {
    it('misses when empty, hits from the process tier after a store, writes Redis with the window TTL', async () => {
        const redis = fakeRedis();
        let now = 1_000_000;
        const opts = { getClient: () => redis.client, scheduleWrite: inlineWrite, now: () => now };
        const key = keyFor('USDC');

        expect(await Effect.runPromise(readRawCandidates(key, opts))).toBeNull();

        storeRawCandidates(key, { raws: [raw(USDC, 'USDC')], sources: { provider: 'ok', db: 'ok' } }, opts);
        const hit = await Effect.runPromise(readRawCandidates(key, opts));
        expect(hit?.raws.map(r => r.mint)).toEqual([USDC]);
        expect(hit?.sources).toEqual({ provider: 'ok', db: 'ok' });
        expect(hit?.cachedAt).toBe(now);

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(redis.store.get(key)?.ex).toBe(45);

        // Past the window the process entry is gone and the Redis copy is too old.
        now += 46_000;
        expect(await Effect.runPromise(readRawCandidates(key, opts))).toBeNull();
    });

    it('a Redis hit inside the window back-fills the process tier with the original cachedAt', async () => {
        const redis = fakeRedis();
        const key = 'judged:raw:v1:ticker:sol';
        const cachedAt = 5_000_000;
        redis.store.set(key, {
            value: JSON.stringify({
                v: 1,
                cachedAt,
                raws: [raw('So11111111111111111111111111111111111111112', 'SOL')],
                sources: { provider: 'ok', db: 'degraded' },
            }),
        });
        let now = cachedAt + 10_000;
        const opts = { getClient: () => redis.client, scheduleWrite: inlineWrite, now: () => now };

        const hit = await Effect.runPromise(readRawCandidates(key, opts));
        expect(hit?.cachedAt).toBe(cachedAt);
        expect(hit?.sources.db).toBe('degraded');
        expect(__candidateCacheProcessSizeForTesting()).toBe(1);

        // The back-filled entry expires on the Redis entry's clock, not the read's.
        now = cachedAt + 46_000;
        redis.setFail(true);
        expect(await Effect.runPromise(readRawCandidates(key, opts))).toBeNull();
    });

    it('ignores malformed Redis payloads and Redis failures', async () => {
        const redis = fakeRedis();
        const opts = { getClient: () => redis.client, scheduleWrite: inlineWrite };
        redis.store.set('k1', { value: '{"v":2,"cachedAt":1,"raws":[]}' });
        redis.store.set('k2', { value: 'not json' });
        redis.store.set('k3', { value: JSON.stringify({ v: 1, cachedAt: Date.now(), raws: [{ nope: true }] }) });
        for (const key of ['k1', 'k2', 'k3']) {
            expect(await Effect.runPromise(readRawCandidates(key, opts))).toBeNull();
        }
        redis.setFail(true);
        expect(await Effect.runPromise(readRawCandidates('k4', opts))).toBeNull();
    });

    it('works with no Redis at all (process tier only)', async () => {
        const opts = {
            getClient: () => {
                throw new Error('not configured');
            },
            scheduleWrite: inlineWrite,
        };
        storeRawCandidates('k', { raws: [raw(USDC, 'USDC')], sources: { provider: 'ok', db: 'ok' } }, opts);
        expect((await Effect.runPromise(readRawCandidates('k', opts)))?.raws.length).toBe(1);
    });

    it('TOKENS_JUDGED_CANDIDATE_CACHE=off disables reads and writes', async () => {
        process.env.TOKENS_JUDGED_CANDIDATE_CACHE = 'off';
        const redis = fakeRedis();
        const opts = { getClient: () => redis.client, scheduleWrite: inlineWrite };
        storeRawCandidates('k', { raws: [raw(USDC, 'USDC')], sources: { provider: 'ok', db: 'ok' } }, opts);
        expect(__candidateCacheProcessSizeForTesting()).toBe(0);
        expect(redis.store.size).toBe(0);
        expect(await Effect.runPromise(readRawCandidates('k', opts))).toBeNull();
    });

    it('bounds the process tier', () => {
        const opts = {
            getClient: () => {
                throw new Error('not configured');
            },
            scheduleWrite: inlineWrite,
        };
        for (let i = 0; i < 300; i += 1) {
            storeRawCandidates(`k${i}`, { raws: [], sources: { provider: 'ok', db: 'ok' } }, opts);
        }
        expect(__candidateCacheProcessSizeForTesting()).toBeLessThanOrEqual(256);
    });
});
