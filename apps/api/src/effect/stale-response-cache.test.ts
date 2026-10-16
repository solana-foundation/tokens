import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { BadRequestError } from '@tokens/effect';

import type { RedisClient } from '@/lib/redis';
import {
    __processFreshSizeForTesting,
    __resetStaleResponseCacheForTesting,
    withStaleFallback,
    type StaleFallbackOptions,
} from './stale-response-cache';

/** Deferred writes land here; `flush()` runs them like Next's `after()` would. */
let pending: Array<Effect.Effect<void, never>> = [];
async function flush(): Promise<void> {
    const batch = pending;
    pending = [];
    for (const effect of batch) await Effect.runPromise(effect);
}

const ORIGINAL_FLAG = process.env.TOKENS_STALE_CACHE_PROCESS_FRESH;

class FakeRedis implements Pick<RedisClient, 'get' | 'set'> {
    store = new Map<string, string>();
    lastSetOptions: { ex?: number; px?: number; nx?: boolean } | undefined;
    setCalls = 0;
    getCalls = 0;
    failWrites = false;
    failReads = false;

    async get<T = string>(key: string): Promise<T | null> {
        this.getCalls++;
        if (this.failReads) throw new Error('redis read failed');
        return (this.store.get(key) ?? null) as T | null;
    }

    async set(
        key: string,
        value: string | number,
        options?: { ex?: number; px?: number; nx?: boolean },
    ): Promise<'OK' | null> {
        this.setCalls++;
        this.lastSetOptions = options;
        if (this.failWrites) throw new Error('redis write failed');
        this.store.set(key, String(value));
        return 'OK';
    }
}

function optionsWith(
    redis: FakeRedis,
    overrides: Partial<StaleFallbackOptions<Record<string, unknown>>> = {},
): StaleFallbackOptions<Record<string, unknown>> {
    return {
        operation: 'test.op',
        cacheKey: 'stale-response:v1:test',
        ttlSeconds: 900,
        writeIntervalMs: 0,
        getClient: () => redis as unknown as RedisClient,
        scheduleWrite: effect => {
            pending.push(effect);
        },
        ...overrides,
    };
}

function serverError<A extends Record<string, unknown>>(message: string): Effect.Effect<A, unknown, never> {
    return Effect.tryPromise(() => Promise.reject(new Error(message)) as Promise<A>);
}

describe('withStaleFallback', () => {
    beforeEach(() => {
        __resetStaleResponseCacheForTesting();
        pending = [];
        delete process.env.TOKENS_STALE_CACHE_PROCESS_FRESH;
    });

    afterEach(() => {
        if (ORIGINAL_FLAG === undefined) delete process.env.TOKENS_STALE_CACHE_PROCESS_FRESH;
        else process.env.TOKENS_STALE_CACHE_PROCESS_FRESH = ORIGINAL_FLAG;
    });

    it('passes successful payloads through unchanged and caches them', async () => {
        const redis = new FakeRedis();
        const payload = { listId: 'all', assets: [{ assetId: 'solana' }] };

        const result = await Effect.runPromise(withStaleFallback(optionsWith(redis), Effect.succeed(payload)));

        expect(result).toEqual(payload);
        expect('stale' in result).toBe(false);
        // The write is deferred until after the response is sent.
        expect(redis.setCalls).toBe(0);
        await flush();
        expect(redis.setCalls).toBe(1);
        expect(redis.store.get('stale-response:v1:test')).toContain('"listId":"all"');
        // Entries must expire — an immortal last-good payload would serve
        // arbitrarily old data during a long outage.
        expect(redis.lastSetOptions?.ex).toBe(900);
    });

    it('serves the last-good payload with stale markers on server error', async () => {
        const redis = new FakeRedis();
        const payload = { listId: 'all', assets: [{ assetId: 'solana' }] };

        await Effect.runPromise(withStaleFallback(optionsWith(redis), Effect.succeed(payload)));
        await flush();

        const result = await Effect.runPromise(
            withStaleFallback(
                optionsWith(redis),
                serverError<{ listId: string; assets: unknown[] }>('downstream timeout'),
            ),
        );

        expect(result.listId).toBe('all');
        expect(result.assets).toEqual([{ assetId: 'solana' }]);
        expect((result as Record<string, unknown>).stale).toBe(true);
        expect(typeof (result as Record<string, unknown>).staleCachedAt).toBe('number');
    });

    it('propagates the original error when there is no cached payload', async () => {
        const redis = new FakeRedis();

        let thrown: unknown;
        try {
            await Effect.runPromise(withStaleFallback(optionsWith(redis), serverError('downstream timeout')));
        } catch (err) {
            thrown = err;
        }
        expect(String((thrown as Error | undefined)?.cause)).toContain('downstream timeout');
    });

    it('never masks 4xx-class failures with stale data', async () => {
        const redis = new FakeRedis();
        await Effect.runPromise(withStaleFallback(optionsWith(redis), Effect.succeed({ listId: 'all' })));

        let thrown: unknown;
        try {
            await Effect.runPromise(
                withStaleFallback(optionsWith(redis), Effect.fail(new BadRequestError({ message: 'Invalid limit' }))),
            );
        } catch (err) {
            thrown = err;
        }
        expect(String(thrown)).toContain('Invalid limit');
        // The fallback read must not even be attempted for client errors.
        expect(redis.getCalls).toBe(0);
    });

    it('does not mask an ineligible server error', async () => {
        const redis = new FakeRedis();
        const options = optionsWith(redis, { shouldFallback: () => false });
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));

        let thrown: unknown;
        try {
            await Effect.runPromise(withStaleFallback(options, serverError('application bug')));
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(redis.getCalls).toBe(0);
    });

    it('propagates the original error when the fallback read also fails', async () => {
        const redis = new FakeRedis();
        await Effect.runPromise(withStaleFallback(optionsWith(redis), Effect.succeed({ listId: 'all' })));
        await flush();
        redis.failReads = true;

        let thrown: unknown;
        try {
            await Effect.runPromise(withStaleFallback(optionsWith(redis), serverError('downstream timeout')));
        } catch (err) {
            thrown = err;
        }
        expect(String((thrown as Error | undefined)?.cause)).toContain('downstream timeout');
    });

    it('does not fail the request when the cache write fails', async () => {
        const redis = new FakeRedis();
        redis.failWrites = true;

        const result = await Effect.runPromise(
            withStaleFallback(optionsWith(redis), Effect.succeed({ listId: 'all' })),
        );
        expect(result).toEqual({ listId: 'all' });
        // The deferred write fails and is logged, never thrown.
        await flush();
        expect(redis.setCalls).toBe(1);
    });

    it('throttles cache writes within the write interval', async () => {
        const redis = new FakeRedis();
        const options = optionsWith(redis, { writeIntervalMs: 60_000 });

        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));

        // The throttle is armed at schedule time, so only one write was queued.
        expect(pending.length).toBe(1);
        await flush();
        expect(redis.setCalls).toBe(1);
    });

    it('serves a fresh entry without invoking the live effect', async () => {
        const redis = new FakeRedis();
        const options = optionsWith(redis, { freshSeconds: 60 });
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));

        let liveCalls = 0;
        const result = await Effect.runPromise(
            withStaleFallback(
                options,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'changed' };
                }),
            ),
        );

        expect(result).toEqual({ listId: 'all' });
        expect(liveCalls).toBe(0);
        expect((result as Record<string, unknown>).stale).toBe(undefined);
        // The seeding call read Redis once (process miss → Redis miss → live);
        // the second call was served from the process tier without a read.
        expect(redis.getCalls).toBe(1);
    });

    it('a fresh Redis entry is served on a process miss and back-fills the process tier', async () => {
        const redis = new FakeRedis();
        const options = optionsWith(redis, { freshSeconds: 60 });
        redis.store.set(
            'stale-response:v1:test',
            JSON.stringify({ v: 1, cachedAt: Date.now() - 1_000, payload: { listId: 'from-redis' } }),
        );

        let liveCalls = 0;
        const live = Effect.sync(() => {
            liveCalls += 1;
            return { listId: 'changed' };
        });

        const first = await Effect.runPromise(withStaleFallback(options, live));
        expect(first).toEqual({ listId: 'from-redis' });
        expect('stale' in first).toBe(false);
        expect(redis.getCalls).toBe(1);

        const second = await Effect.runPromise(withStaleFallback(options, live));
        expect(second).toEqual({ listId: 'from-redis' });
        expect(redis.getCalls).toBe(1);
        expect(liveCalls).toBe(0);
    });

    it('an expired process entry falls through to Redis, then to the live effect', async () => {
        const redis = new FakeRedis();
        let now = 1_000_000;
        const options = optionsWith(redis, { freshSeconds: 60, now: () => now });
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'v1' })));
        await flush();
        expect(redis.getCalls).toBe(1);

        // Past the fresh window on both tiers: the live effect runs again.
        now += 61_000;
        let liveCalls = 0;
        const result = await Effect.runPromise(
            withStaleFallback(
                options,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'v2' };
                }),
            ),
        );
        expect(result).toEqual({ listId: 'v2' });
        expect(liveCalls).toBe(1);
        // Process tier missed, so Redis was consulted again (and was stale too).
        expect(redis.getCalls).toBe(2);
    });

    it('the failure path still reads last-good from Redis, never from the process tier', async () => {
        const redis = new FakeRedis();
        let now = 1_000_000;
        const options = optionsWith(redis, { freshSeconds: 60, now: () => now });
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));
        expect(__processFreshSizeForTesting()).toBe(1);
        // Deliberately not flushed, so Redis holds nothing. Past the fresh
        // window the live effect runs and fails; the fallback must consult
        // Redis (empty → the error propagates) and never the process tier,
        // even though it still holds the payload.
        now += 61_000;
        let thrown: unknown;
        try {
            await Effect.runPromise(withStaleFallback(options, serverError('downstream timeout')));
        } catch (err) {
            thrown = err;
        }
        expect(String((thrown as Error | undefined)?.cause)).toContain('downstream timeout');
        // seed fresh-check + expired fresh-check + failure fallback.
        expect(redis.getCalls).toBe(3);
    });

    it('callers without a fresh window never take a process-tier slot', async () => {
        const redis = new FakeRedis();
        await Effect.runPromise(withStaleFallback(optionsWith(redis), Effect.succeed({ listId: 'all' })));
        expect(__processFreshSizeForTesting()).toBe(0);
    });

    it('TOKENS_STALE_CACHE_PROCESS_FRESH=off reads Redis on every fresh check', async () => {
        process.env.TOKENS_STALE_CACHE_PROCESS_FRESH = 'off';
        const redis = new FakeRedis();
        const options = optionsWith(redis, { freshSeconds: 60 });
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));
        await flush();
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'changed' })));
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'changed' })));
        expect(redis.getCalls).toBe(3);
        expect(__processFreshSizeForTesting()).toBe(0);
    });

    it('distinct cache keys never share a process entry', async () => {
        const redis = new FakeRedis();
        const a = optionsWith(redis, { freshSeconds: 60, cacheKey: 'stale-response:v1:a' });
        const b = optionsWith(redis, { freshSeconds: 60, cacheKey: 'stale-response:v1:b' });
        await Effect.runPromise(withStaleFallback(a, Effect.succeed({ listId: 'a' })));

        let liveCalls = 0;
        const result = await Effect.runPromise(
            withStaleFallback(
                b,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'b' };
                }),
            ),
        );
        expect(result).toEqual({ listId: 'b' });
        expect(liveCalls).toBe(1);
    });

    it('a shorter fresh window on one key never sweeps another key stored with a longer window', async () => {
        const redis = new FakeRedis();
        let now = 1_000_000;
        const long = optionsWith(redis, { freshSeconds: 60, cacheKey: 'stale-response:v1:long', now: () => now });
        const short = optionsWith(redis, { freshSeconds: 30, cacheKey: 'stale-response:v1:short', now: () => now });
        await Effect.runPromise(withStaleFallback(long, Effect.succeed({ listId: 'long' })));

        // 39 s later the short-window caller inserts; `long` is still inside its own 60 s window.
        now += 39_000;
        await Effect.runPromise(withStaleFallback(short, Effect.succeed({ listId: 'short' })));
        const stillFresh = await Effect.runPromise(withStaleFallback(long, serverError('must not run')));
        expect(stillFresh).toEqual({ listId: 'long' });

        // Past its own window it falls through (Redis is empty → live).
        now += 22_000;
        let liveCalls = 0;
        await Effect.runPromise(
            withStaleFallback(
                long,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'long-2' };
                }),
            ),
        );
        expect(liveCalls).toBe(1);
    });

    it('a back-filled Redis entry keeps the original cachedAt, so it is never served past the fresh window', async () => {
        const redis = new FakeRedis();
        let now = 1_000_000;
        const options = optionsWith(redis, { freshSeconds: 60, now: () => now });
        redis.store.set(
            'stale-response:v1:test',
            JSON.stringify({ v: 1, cachedAt: now - 59_000, payload: { listId: 'from-redis' } }),
        );
        expect(await Effect.runPromise(withStaleFallback(options, serverError('must not run')))).toEqual({
            listId: 'from-redis',
        });
        // Two seconds later the payload is 61 s old: process miss, Redis stale, live runs.
        now += 2_000;
        let liveCalls = 0;
        await Effect.runPromise(
            withStaleFallback(
                options,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'live' };
                }),
            ),
        );
        expect(liveCalls).toBe(1);
    });

    it('holds at most eight process entries and evicts the oldest', async () => {
        const redis = new FakeRedis();
        let now = 1_000_000;
        for (let i = 0; i < 9; i += 1) {
            now += 1;
            const options = optionsWith(redis, {
                freshSeconds: 600,
                cacheKey: `stale-response:v1:k${i}`,
                now: () => now,
            });
            await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: `k${i}` })));
        }
        expect(__processFreshSizeForTesting()).toBe(8);

        // k0 (the oldest) was evicted → process miss → Redis (empty) → live.
        let liveCalls = 0;
        const evicted = optionsWith(redis, { freshSeconds: 600, cacheKey: 'stale-response:v1:k0', now: () => now });
        await Effect.runPromise(
            withStaleFallback(
                evicted,
                Effect.sync(() => {
                    liveCalls += 1;
                    return { listId: 'k0-live' };
                }),
            ),
        );
        expect(liveCalls).toBe(1);

        // k8 (the newest) is still served locally.
        const kept = optionsWith(redis, { freshSeconds: 600, cacheKey: 'stale-response:v1:k8', now: () => now });
        const result = await Effect.runPromise(withStaleFallback(kept, serverError('must not run')));
        expect(result).toEqual({ listId: 'k8' });
    });

    it('never caches unhealthy payloads and serves the last healthy one instead', async () => {
        const redis = new FakeRedis();
        const isHealthy = (payload: Record<string, unknown>) =>
            Array.isArray(payload.assets) && payload.assets.length > 0;

        const healthy = { listId: 'all', assets: [{ assetId: 'solana' }] };
        await Effect.runPromise(withStaleFallback(optionsWith(redis, { isHealthy }), Effect.succeed(healthy)));
        await flush();
        expect(redis.setCalls).toBe(1);

        const hollow = { listId: 'all', assets: [] as unknown[] };
        const result = await Effect.runPromise(
            withStaleFallback(optionsWith(redis, { isHealthy }), Effect.succeed(hollow)),
        );

        // The hollow 200 was replaced by the cached healthy payload…
        expect(result.assets).toEqual([{ assetId: 'solana' }]);
        expect((result as Record<string, unknown>).stale).toBe(true);
        // …and was never written to the cache.
        expect(redis.setCalls).toBe(1);
    });

    it('returns the unhealthy payload unchanged when there is no cached fallback', async () => {
        const redis = new FakeRedis();
        const isHealthy = () => false;

        const payload = { listId: 'all', assets: [] as unknown[] };
        const result = await Effect.runPromise(
            withStaleFallback(optionsWith(redis, { isHealthy }), Effect.succeed(payload)),
        );

        expect(result).toEqual(payload);
        expect('stale' in result).toBe(false);
        await flush();
        expect(redis.setCalls).toBe(0);
    });

    it('arms the write throttle even when the payload is too large to cache', async () => {
        const redis = new FakeRedis();
        const options = optionsWith(redis, { writeIntervalMs: 60_000 });
        // ~5MB payload — exceeds MAX_CACHEABLE_CHARS.
        const huge = { listId: 'all', blob: 'x'.repeat(5_000_000) };

        await Effect.runPromise(withStaleFallback(options, Effect.succeed(huge)));
        await flush();
        await Effect.runPromise(withStaleFallback(options, Effect.succeed(huge)));
        await flush();

        // Nothing was cached, and the second request must have been throttled
        // before re-serializing (setCalls stays 0 either way; the observable
        // throttle effect is that a later *small* payload is also skipped
        // within the interval).
        expect(redis.setCalls).toBe(0);
        await Effect.runPromise(withStaleFallback(options, Effect.succeed({ listId: 'all' })));
        await flush();
        expect(redis.setCalls).toBe(0);
    });

    it('ignores malformed cache entries and propagates the error', async () => {
        const redis = new FakeRedis();
        redis.store.set('stale-response:v1:test', 'not json {');

        let thrown: unknown;
        try {
            await Effect.runPromise(withStaleFallback(optionsWith(redis), serverError('downstream timeout')));
        } catch (err) {
            thrown = err;
        }
        expect(String((thrown as Error | undefined)?.cause)).toContain('downstream timeout');
    });
});
