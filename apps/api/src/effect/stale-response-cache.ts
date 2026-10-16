import { Effect } from 'effect';

import { runAfterResponse } from '@/effect/after-response';
import { getRedisClient, type RedisClient } from '@/lib/redis';
import { httpStatusForError, toApiErrorInfo } from '@tokens/effect';

/**
 * Last-good response cache: serve slightly stale data instead of a 500 or a
 * degraded (near-empty) 200.
 *
 * `withStaleFallback` wraps a route handler effect so that
 * - every healthy successful payload is written to Redis (best-effort,
 *   throttled),
 * - a 5xx-class failure is answered with the last healthy payload for the
 *   same cache key (marked `stale: true`) when one exists, and
 * - an *unhealthy* success (per `isHealthy` — e.g. a payload assembled while
 *   every downstream call defaulted to empty) is replaced by the last healthy
 *   payload when one exists, and is never written to the cache.
 *
 * 4xx-class failures (bad request, auth, rate limit) are never masked — they
 * propagate unchanged. When Redis is unavailable or has no entry, the original
 * outcome propagates and behavior is identical to an unwrapped handler.
 *
 * Latency: the Redis behind this is Upstash with its primary far from the API
 * region, so every command costs a cross-country round-trip. Two things keep
 * it off the request's critical path:
 * - `freshSeconds` is answered first from a small **per-process** tier
 *   (`TOKENS_STALE_CACHE_PROCESS_FRESH=off` disables it); Redis is only
 *   consulted on a process miss (e.g. a cold instance right after a deploy),
 *   and a Redis fresh hit back-fills the process tier.
 * - The last-good **write** is scheduled after the response is sent
 *   (`runAfterResponse`) instead of being awaited inline. The write throttle
 *   is still armed synchronously, so "one write per interval per process"
 *   holds under concurrency.
 * The failure paths (5xx-class error, hollow success) still read last-good
 * from Redis exactly as before — the process tier is never used there.
 */

export interface StaleFallbackOptions<A = Record<string, unknown>> {
    /** Label for log lines (e.g. `assets.curated`). */
    operation: string;
    /** Redis key holding the last-good payload for this request shape. */
    cacheKey: string;
    /** How long a last-good payload stays servable, in seconds. */
    ttlSeconds: number;
    /** Serve a cached success without invoking the live effect while this fresh. */
    freshSeconds?: number;
    /**
     * Health check for successful payloads. Unhealthy payloads are never
     * cached, and are swapped for the last healthy payload when one exists
     * (route handlers that default failed sub-calls to empty data can 200
     * with a hollow body — that hollow body must not become "last good").
     * Defaults to treating every success as healthy.
     */
    isHealthy?: (payload: A) => boolean;
    /** Restrict which 5xx-class errors are eligible for stale substitution. */
    shouldFallback?: (error: unknown) => boolean;
    /**
     * Minimum interval between cache writes from this process, in ms.
     * Payloads can be large; rewriting on every request is wasteful when the
     * data only changes on the order of seconds. Defaults to 30s.
     */
    writeIntervalMs?: number;
    /** Test injection for the Redis client. Defaults to `getRedisClient()`. */
    getClient?: () => RedisClient;
    /** Where the deferred last-good write runs. Defaults to `runAfterResponse`. */
    scheduleWrite?: (effect: Effect.Effect<void, never>) => void;
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;
}

interface StaleEnvelope {
    v: 1;
    cachedAt: number;
    payload: Record<string, unknown>;
}

/** Skip caching payloads larger than this many serialized bytes. */
const MAX_CACHEABLE_CHARS = 4_000_000;

const DEFAULT_WRITE_INTERVAL_MS = 30_000;

/** Per-process write throttle (serverless instances each keep their own). */
const lastWriteAtByKey = new Map<string, number>();

/** Bound the throttle map — arbitrary offset/limit combos yield unbounded keys. */
const MAX_THROTTLE_ENTRIES = 1_000;

interface ProcessFreshEntry {
    payload: Record<string, unknown>;
    cachedAt: number;
}

/**
 * Per-process fresh tier. Payloads can be megabytes, so this is bounded by
 * entry count, not by the throttle map's limit: a handful of request shapes
 * per instance is the realistic working set.
 */
const processFresh = new Map<string, ProcessFreshEntry>();
const MAX_PROCESS_FRESH_ENTRIES = 8;

function processFreshEnabled(): boolean {
    return process.env.TOKENS_STALE_CACHE_PROCESS_FRESH?.trim().toLowerCase() !== 'off';
}

function rememberFresh(cacheKey: string, entry: ProcessFreshEntry, freshMs: number, now: number): void {
    if (!processFreshEnabled()) return;
    // Drop anything that can no longer be served fresh, then the oldest
    // survivor if we are still at the cap.
    for (const [key, existing] of processFresh) {
        if (key !== cacheKey && now - existing.cachedAt > freshMs) processFresh.delete(key);
    }
    processFresh.delete(cacheKey);
    if (processFresh.size >= MAX_PROCESS_FRESH_ENTRIES) {
        let oldestKey: string | null = null;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, existing] of processFresh) {
            if (existing.cachedAt < oldestAt) {
                oldestAt = existing.cachedAt;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) processFresh.delete(oldestKey);
    }
    processFresh.set(cacheKey, entry);
}

function readProcessFresh(cacheKey: string, freshMs: number, now: number): ProcessFreshEntry | null {
    if (!processFreshEnabled()) return null;
    const entry = processFresh.get(cacheKey);
    if (!entry) return null;
    if (now - entry.cachedAt > freshMs) {
        processFresh.delete(cacheKey);
        return null;
    }
    return entry;
}

function redisOrNull(getClient?: () => RedisClient): RedisClient | null {
    try {
        return (getClient ?? getRedisClient)();
    } catch {
        // Redis not configured — stale fallback silently disabled.
        return null;
    }
}

function parseEnvelope(raw: unknown): StaleEnvelope | null {
    try {
        // Upstash's REST client auto-deserializes JSON values; Memorystore
        // returns the raw string. Handle both.
        const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object') return null;
        const envelope = value as Partial<StaleEnvelope>;
        if (envelope.v !== 1) return null;
        if (typeof envelope.cachedAt !== 'number' || !Number.isFinite(envelope.cachedAt)) return null;
        if (!envelope.payload || typeof envelope.payload !== 'object') return null;
        return envelope as StaleEnvelope;
    } catch {
        return null;
    }
}

function logDegradedResponse(
    options: Pick<StaleFallbackOptions<never>, 'operation' | 'cacheKey'>,
    envelope: StaleEnvelope,
    reason: 'unhealthy_success' | 'transient_error',
    error?: unknown,
): void {
    console.error(
        JSON.stringify({
            event: 'tokens_api_degraded_last_good_response',
            operation: options.operation,
            cacheKey: options.cacheKey,
            reason,
            cachedAt: envelope.cachedAt,
            staleAgeMs: Date.now() - envelope.cachedAt,
            ...(error === undefined ? {} : { error: toApiErrorInfo(error) }),
        }),
    );
}

/**
 * Synchronous half of the last-good write: decide whether this process may
 * write now and arm the throttle. Armed before the (deferred) serialization
 * so an oversized payload cannot bypass the throttle, and so concurrent
 * requests cannot all schedule a write before the first one runs.
 */
function armWriteThrottle(options: StaleFallbackOptions<never>, now: number): boolean {
    const writeIntervalMs = options.writeIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    const lastWriteAt = lastWriteAtByKey.get(options.cacheKey) ?? 0;
    if (now - lastWriteAt < writeIntervalMs) return false;

    // Redis not configured — nothing to write, nothing to arm (as before).
    if (!redisOrNull(options.getClient)) return false;

    if (lastWriteAtByKey.size >= MAX_THROTTLE_ENTRIES) lastWriteAtByKey.clear();
    lastWriteAtByKey.set(options.cacheKey, now);
    return true;
}

/** Deferred half: serialize, size-check, and SET. */
async function persistLastGood(
    options: StaleFallbackOptions<never>,
    payload: Record<string, unknown>,
    cachedAt: number,
): Promise<void> {
    const redis = redisOrNull(options.getClient);
    if (!redis) return;

    const envelope: StaleEnvelope = { v: 1, cachedAt, payload };
    const body = JSON.stringify(envelope);
    if (body.length > MAX_CACHEABLE_CHARS) {
        console.error('Stale-response cache: payload too large to cache', {
            operation: options.operation,
            cacheKey: options.cacheKey,
            chars: body.length,
        });
        return;
    }

    await redis.set(options.cacheKey, body, { ex: options.ttlSeconds });
}

async function readLastGood(options: StaleFallbackOptions<never>): Promise<StaleEnvelope | null> {
    const redis = redisOrNull(options.getClient);
    if (!redis) return null;
    const raw = await redis.get<unknown>(options.cacheKey);
    if (raw === null || raw === undefined) return null;
    return parseEnvelope(raw);
}

export function withStaleFallback<A extends Record<string, unknown>, E, R>(
    options: StaleFallbackOptions<A>,
    effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | (A & { stale: true; staleCachedAt: number }), E, R> {
    type Out = A | (A & { stale: true; staleCachedAt: number });

    const clock = options.now ?? Date.now;
    const scheduleWrite = options.scheduleWrite ?? runAfterResponse;
    const freshSeconds = options.freshSeconds ?? 0;
    const freshMs = freshSeconds * 1_000;

    const readStale = Effect.tryPromise(() => readLastGood(options)).pipe(Effect.catch(() => Effect.succeed(null)));

    const asStale = (envelope: StaleEnvelope): Out => ({
        ...(envelope.payload as A),
        stale: true as const,
        staleCachedAt: envelope.cachedAt,
    });

    const live = effect.pipe(
        Effect.flatMap((payload): Effect.Effect<Out, never, never> => {
            const healthy = options.isHealthy ? options.isHealthy(payload) : true;

            if (!healthy) {
                // A hollow success (every downstream call defaulted) must not
                // become "last good" — and callers are better served by the
                // previous healthy payload when we still have one.
                return readStale.pipe(
                    Effect.map(envelope => {
                        if (!envelope) return payload;
                        logDegradedResponse(options, envelope, 'unhealthy_success');
                        return asStale(envelope);
                    }),
                );
            }

            const now = clock();
            // Only callers with a fresh window take a process-tier slot.
            if (freshMs > 0) rememberFresh(options.cacheKey, { payload, cachedAt: now }, freshMs, now);
            if (armWriteThrottle(options, now)) {
                scheduleWrite(
                    Effect.tryPromise(() => persistLastGood(options, payload, now)).pipe(
                        Effect.catch(error => {
                            console.error('Stale-response cache: write failed', {
                                operation: options.operation,
                                cacheKey: options.cacheKey,
                                error: toApiErrorInfo(error),
                            });
                            return Effect.void;
                        }),
                    ),
                );
            }
            return Effect.succeed(payload);
        }),
        Effect.catch(error => {
            // Never mask client errors (4xx) with stale data — only degrade on
            // server-side failures.
            if (httpStatusForError(error) < 500 || (options.shouldFallback && !options.shouldFallback(error))) {
                return Effect.fail(error);
            }

            return readStale.pipe(
                Effect.flatMap(envelope => {
                    if (!envelope) return Effect.fail(error);
                    logDegradedResponse(options, envelope, 'transient_error', error);
                    return Effect.succeed(asStale(envelope));
                }),
            );
        }),
    );

    if (freshSeconds <= 0) return live;
    return Effect.suspend(() => {
        const now = clock();
        const local = readProcessFresh(options.cacheKey, freshMs, now);
        if (local) return Effect.succeed(local.payload as A);
        return readStale.pipe(
            Effect.flatMap(envelope => {
                if (!envelope || clock() - envelope.cachedAt > freshMs) return live;
                rememberFresh(
                    options.cacheKey,
                    { payload: envelope.payload, cachedAt: envelope.cachedAt },
                    freshMs,
                    clock(),
                );
                return Effect.succeed(envelope.payload as A);
            }),
        );
    });
}

/** Test helper — reset the per-process write throttle and fresh tier. */
export function __resetStaleResponseCacheForTesting(): void {
    lastWriteAtByKey.clear();
    processFresh.clear();
}

/** Test helper — number of entries in the per-process fresh tier. */
export function __processFreshSizeForTesting(): number {
    return processFresh.size;
}
