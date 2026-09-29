import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';
import { MissingEnvError, RateLimitedError, UpstreamHttpError } from '@tokens/effect';

import type { PlatformAuthContext } from '@/effect/next-route';
import type { ProviderMarketOverview } from '@/lib/birdeye-overview';
import type { RedisClient } from '@/lib/redis';

mock.module('server-only', () => ({}));

const { loadLiveMarketFallback, needsLiveFallback } = await import('./_risk-live-fallback');
type LiveMarketDeps = import('./_risk-live-fallback').LiveMarketDeps;

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const KEY = `risk-live:v1:${MINT}`;
const NOW = 1_790_000_000_000;

const AUTH: PlatformAuthContext = {
    apiKeyId: 'k',
    keyPrefix: 'tk_test',
    projectId: 'p',
    ownerClerkUserId: 'u',
    scopes: ['assets:read'],
};

const MARKET: ProviderMarketOverview = {
    liquidity: 11_000_000,
    marketCap: 1_200_000_000,
    holder: 850_000,
    volume24hUSD: 14_500_000,
};

interface Harness {
    deps: LiveMarketDeps;
    store: Map<string, unknown>;
    sets: Array<{ key: string; value: string; ex: number | undefined }>;
    calls: { budget: number; fetch: number; warm: number };
}

function harness(overrides: Partial<LiveMarketDeps> = {}): Harness {
    const store = new Map<string, unknown>();
    const sets: Harness['sets'] = [];
    const calls = { budget: 0, fetch: 0, warm: 0 };

    const redis = {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: string | number, options?: { ex?: number }) => {
            sets.push({ key, value: String(value), ex: options?.ex });
            store.set(key, String(value));
            return 'OK' as const;
        },
    } as unknown as RedisClient;

    const deps: LiveMarketDeps = {
        getRedis: () => Effect.succeed(redis),
        checkBudget: () =>
            Effect.sync(() => {
                calls.budget += 1;
            }),
        fetchOverview: () =>
            Effect.sync(() => {
                calls.fetch += 1;
                return MARKET;
            }),
        scheduleWarm: () =>
            Effect.sync(() => {
                calls.warm += 1;
            }),
        now: () => NOW,
        ...overrides,
    };

    return { deps, store, sets, calls };
}

function counted<A>(calls: Harness['calls'], effect: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return Effect.suspend(() => {
        calls.fetch += 1;
        return effect;
    });
}

const run = (h: Harness) => Effect.runPromise(loadLiveMarketFallback(AUTH, MINT, h.deps));

const ORIGINAL_LOG = console.log;
let events: Array<Record<string, unknown>> = [];

beforeEach(() => {
    events = [];
    console.log = (line: unknown) => {
        try {
            events.push(JSON.parse(String(line)) as Record<string, unknown>);
        } catch {
            // not a structured event
        }
    };
});

afterEach(() => {
    console.log = ORIGINAL_LOG;
});

describe('needsLiveFallback', () => {
    it('is true without a snapshot, or when it carries neither liquidity nor market cap', () => {
        expect(needsLiveFallback(null)).toBe(true);
        expect(needsLiveFallback(undefined)).toBe(true);
        expect(needsLiveFallback({})).toBe(true);
        expect(needsLiveFallback({ liquidity: null, marketCap: null })).toBe(true);
    });

    it('is false for a snapshot with real values, however small', () => {
        expect(needsLiveFallback({ liquidity: 5_000_000, marketCap: 80_000_000 })).toBe(false);
        expect(needsLiveFallback({ liquidity: 200, marketCap: null })).toBe(false);
        expect(needsLiveFallback({ liquidity: null, marketCap: 500 })).toBe(false);
        expect(needsLiveFallback({ liquidity: 0, marketCap: 0 })).toBe(false);
    });
});

describe('loadLiveMarketFallback', () => {
    it('reads the provider on a cache miss and caches the hit for 5 minutes', async () => {
        const h = harness();
        const result = await run(h);

        expect(result).toEqual({ market: MARKET, outcome: 'live_hit', fetchedAt: NOW });
        expect(h.calls).toEqual({ budget: 1, fetch: 1, warm: 1 });
        expect(h.sets.length).toBe(1);
        expect(h.sets[0]!.key).toBe(KEY);
        expect(h.sets[0]!.ex).toBe(300);
        expect(JSON.parse(h.sets[0]!.value)).toEqual({ v: 1, market: MARKET, at: NOW });
    });

    it('caches a mint the provider does not know for 15 minutes', async () => {
        const h = harness();
        h.deps.fetchOverview = () => counted(h.calls, Effect.succeed(null));
        const result = await run(h);

        expect(result).toEqual({ market: null, outcome: 'live_miss', fetchedAt: null });
        expect(h.sets[0]!.ex).toBe(900);
        expect(JSON.parse(h.sets[0]!.value)).toEqual({ v: 1, market: null, at: NOW });
    });

    it('serves a cached hit without spending budget or calling the provider', async () => {
        const h = harness();
        h.store.set(KEY, JSON.stringify({ v: 1, market: MARKET, at: NOW - 60_000 }));
        const result = await run(h);

        expect(result).toEqual({ market: MARKET, outcome: 'cached_hit', fetchedAt: NOW - 60_000 });
        expect(h.calls).toEqual({ budget: 0, fetch: 0, warm: 0 });
        expect(h.sets).toEqual([]);
    });

    it('serves a cached miss without spending budget or calling the provider', async () => {
        const h = harness();
        h.store.set(KEY, JSON.stringify({ v: 1, market: null, at: NOW - 60_000 }));
        const result = await run(h);

        expect(result).toEqual({ market: null, outcome: 'cached_miss', fetchedAt: null });
        expect(h.calls).toEqual({ budget: 0, fetch: 0, warm: 0 });
    });

    it('reads a cache entry the client already parsed (Upstash)', async () => {
        const h = harness();
        h.store.set(KEY, { v: 1, market: MARKET, at: NOW - 1_000 });
        expect((await run(h)).outcome).toBe('cached_hit');
    });

    it('ignores a cache entry it cannot read and goes to the provider', async () => {
        for (const entry of ['{not json', JSON.stringify({ v: 2, market: MARKET, at: NOW }), 'null', 42]) {
            const h = harness();
            h.store.set(KEY, entry);
            expect((await run(h)).outcome).toBe('live_hit');
        }
    });

    it('discards a cached market with no usable values and goes to the provider', async () => {
        const h = harness();
        h.store.set(KEY, JSON.stringify({ v: 1, market: { liquidity: 'lots', marketCap: '1e9' }, at: NOW }));
        const result = await run(h);

        expect(result).toEqual({ market: MARKET, outcome: 'live_hit', fetchedAt: NOW });
    });

    it('does not call the provider once the budget is exhausted', async () => {
        const h = harness();
        h.deps.checkBudget = () =>
            Effect.fail(new RateLimitedError({ service: 'providerBudget', message: 'exhausted', retryAfterMs: 1_000 }));
        const result = await run(h);

        expect(result).toEqual({ market: null, outcome: 'budget_exhausted', fetchedAt: null });
        expect(h.calls.fetch).toBe(0);
        expect(h.calls.warm).toBe(0);
        expect(h.sets).toEqual([]);
    });

    it('fails open when the budget check hangs', async () => {
        const h = harness();
        h.deps.checkBudget = () => Effect.never;
        expect((await run(h)).outcome).toBe('live_hit');
    });

    it('resolves unscored on a provider error, cached briefly', async () => {
        const failures = [
            new UpstreamHttpError({ service: 'birdeye', status: 500, message: 'birdeye request failed' }),
            new RateLimitedError({ service: 'birdeye', message: 'birdeye rate limited' }),
            new Error('socket hang up'),
        ];
        for (const failure of failures) {
            const h = harness();
            h.deps.fetchOverview = () => counted(h.calls, Effect.fail(failure));
            const result = await run(h);

            expect(result).toEqual({ market: null, outcome: 'provider_error', fetchedAt: null });
            expect(h.sets[0]!.ex).toBe(60);
        }
    });

    it('resolves unscored, uncached, when the provider key is not configured', async () => {
        const h = harness();
        h.deps.fetchOverview = () =>
            counted(h.calls, Effect.fail(new MissingEnvError({ name: 'BIRDEYE_API_KEY', message: 'not set' })));
        const result = await run(h);

        expect(result).toEqual({ market: null, outcome: 'not_configured', fetchedAt: null });
        expect(h.sets).toEqual([]);
    });

    it('resolves unscored when the provider read throws', async () => {
        const h = harness();
        h.deps.fetchOverview = () =>
            Effect.sync(() => {
                throw new TypeError('boom');
            });
        expect(await run(h)).toEqual({ market: null, outcome: 'provider_error', fetchedAt: null });
    });

    it('still reads the provider when Redis is unavailable', async () => {
        const unavailable = [
            () => Effect.fail(new MissingEnvError({ name: 'UPSTASH_REDIS_REST_URL', message: 'not configured' })),
            () =>
                Effect.succeed({
                    get: async () => {
                        throw new Error('redis down');
                    },
                    set: async () => {
                        throw new Error('redis down');
                    },
                } as unknown as RedisClient),
            () =>
                Effect.succeed({
                    get: () => new Promise(() => undefined),
                    set: () => new Promise(() => undefined),
                } as unknown as RedisClient),
        ];
        for (const getRedis of unavailable) {
            const h = harness({ getRedis });
            expect(await run(h)).toEqual({ market: MARKET, outcome: 'live_hit', fetchedAt: NOW });
        }
    });

    it('schedules a warm only when it actually read the provider', async () => {
        const h = harness();
        await run(h);
        await run(h);
        await run(h);

        expect(h.calls).toEqual({ budget: 1, fetch: 1, warm: 1 });
    });

    it('emits one event per read with the outcome', async () => {
        const h = harness();
        await run(h);
        await run(h);

        const fallbackEvents = events.filter(e => e.event === 'risk_live_fallback');
        expect(fallbackEvents.map(e => e.outcome)).toEqual(['live_hit', 'cached_hit']);
        expect(fallbackEvents[0]!.mint).toBe(MINT);
    });
});
