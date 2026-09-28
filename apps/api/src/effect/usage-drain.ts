import { Effect } from 'effect';

import type { UsageAggregateBucket } from '@/lib/cloudrun/platformAuth';
import type { RedisClient } from '@/lib/redis';
import {
    USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT,
    USAGE_DRAIN_LIST_DIRTY_SCRIPT,
    USAGE_DRAIN_TAKE_SCRIPT,
} from '@/lib/redis/lua';

/**
 * Usage-aggregate drain.
 *
 * In `aggregated` usage mode every request increments Redis hashes
 * (`usage:v1:day:*` / `usage:v1:endpoint:*`) instead of writing a row. Those
 * hashes only reach the dashboard once something moves them into the rollup
 * tables via the usage service's `ingestUsageAggregates`. That used to be an
 * external timer, which was retired — so the API drains itself: a request
 * that wins the drain lock flushes the dirty hashes after its response.
 *
 * Delivery is at-most-once with best-effort restore: hashes are read and
 * deleted atomically, then ingested; if the ingest fails the counts are
 * added back so the next drain retries them.
 */

const DAY_KEY_PREFIX = 'usage:v1:day:';
const ENDPOINT_KEY_PREFIX = 'usage:v1:endpoint:';
const ENDPOINT_NAME_KEY_PREFIX = 'usage:v1:endpoint-name:';

/** Hash used as a set: field = usage hash key with undrained increments. */
export const USAGE_DIRTY_KEY = 'usage:v1:dirty';
export const USAGE_DRAIN_LOCK_KEY = 'usage:v1:drain-lock';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENDPOINT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const HISTOGRAM_FIELD_PREFIX = 'hist:';
// LATENCY_BOUNDS_MS.length + 1 — must match the usage service's histogram.
const HISTOGRAM_BUCKETS = 14;

const DEFAULT_MAX_KEYS = 200;
const MAX_BATCHES_PER_DRAIN = 5;

export function usageDayKey(day: string, projectId: string): string {
    return `${DAY_KEY_PREFIX}${day}:${projectId}`;
}

export function usageEndpointKey(day: string, projectId: string, endpointHash: string): string {
    return `${ENDPOINT_KEY_PREFIX}${day}:${projectId}:${endpointHash}`;
}

export function usageEndpointNameKey(endpointHash: string): string {
    return `${ENDPOINT_NAME_KEY_PREFIX}${endpointHash}`;
}

export type ParsedUsageKey =
    | { kind: 'day'; day: string; projectId: string }
    | { kind: 'endpoint'; day: string; projectId: string; endpointHash: string };

export function parseUsageKey(key: string): ParsedUsageKey | null {
    const isDay = key.startsWith(DAY_KEY_PREFIX);
    if (!isDay && !key.startsWith(ENDPOINT_KEY_PREFIX)) return null;

    const rest = key.slice(isDay ? DAY_KEY_PREFIX.length : ENDPOINT_KEY_PREFIX.length);
    const day = rest.slice(0, 10);
    if (!DAY_PATTERN.test(day) || rest[10] !== ':') return null;
    const tail = rest.slice(11);

    if (isDay) return tail ? { kind: 'day', day, projectId: tail } : null;

    // The project id may itself contain ':'; the hash is always the last segment.
    const split = tail.lastIndexOf(':');
    if (split <= 0) return null;
    const endpointHash = tail.slice(split + 1);
    if (!ENDPOINT_HASH_PATTERN.test(endpointHash)) return null;
    return { kind: 'endpoint', day, projectId: tail.slice(0, split), endpointHash };
}

function toCount(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * HGETALL comes back as a flat `[field, value, ...]` array (RESP2 / Lua) or
 * an object, with values as strings or already-deserialized numbers
 * depending on the client.
 */
function parseHashReply(reply: unknown): Map<string, number> {
    const fields = new Map<string, number>();
    if (Array.isArray(reply)) {
        for (let i = 0; i + 1 < reply.length; i += 2) {
            fields.set(String(reply[i]), toCount(reply[i + 1]));
        }
    } else if (reply && typeof reply === 'object') {
        for (const [field, value] of Object.entries(reply)) fields.set(field, toCount(value));
    }
    for (const [field, value] of fields) if (value <= 0) fields.delete(field);
    return fields;
}

function toBucket(parsed: ParsedUsageKey, fields: Map<string, number>, endpoint: string | null): UsageAggregateBucket {
    const base = {
        projectId: parsed.projectId,
        day: parsed.day,
        successCalls: fields.get('successCalls') ?? 0,
        sumLatencyMs: fields.get('sumLatencyMs') ?? 0,
    };
    if (parsed.kind === 'day') {
        return { ...base, totalCalls: fields.get('totalCalls') ?? 0, assetCalls: fields.get('assetCalls') ?? 0 };
    }
    const latencyHistogram = Array.from(
        { length: HISTOGRAM_BUCKETS },
        (_, i) => fields.get(`${HISTOGRAM_FIELD_PREFIX}${i}`) ?? 0,
    );
    return { ...base, endpoint: endpoint ?? '', totalCalls: fields.get('calls') ?? 0, latencyHistogram };
}

interface TakenHash {
    key: string;
    fields: Map<string, number>;
}

/** Add taken counts back so the next drain retries them. */
function restoreTaken(redis: RedisClient, taken: ReadonlyArray<TakenHash>, ttlSeconds: number) {
    return Effect.tryPromise(() => {
        const pipeline = redis.pipeline();
        for (const { key, fields } of taken) {
            for (const [field, value] of fields) pipeline.hincrby(key, field, value);
            pipeline.expire(key, ttlSeconds);
            pipeline.hincrby(USAGE_DIRTY_KEY, key, 1);
        }
        pipeline.expire(USAGE_DIRTY_KEY, ttlSeconds);
        return pipeline.exec();
    });
}

export interface UsageDrainDeps {
    redis: RedisClient;
    ingest: (buckets: UsageAggregateBucket[]) => Effect.Effect<void, unknown>;
    /** TTL re-applied to hashes restored after a failed ingest. */
    ttlSeconds: number;
    maxKeys?: number;
}

export interface UsageDrainResult {
    /** Buckets handed to the usage service. */
    ingested: number;
    /** Hashes put back after a failed ingest or a missing endpoint name. */
    restored: number;
}

function drainBatch(deps: UsageDrainDeps, maxKeys: number) {
    return Effect.gen(function* () {
        const { redis } = deps;

        const dirty = yield* Effect.tryPromise(() =>
            redis.eval<unknown[]>(USAGE_DRAIN_LIST_DIRTY_SCRIPT.script, [USAGE_DIRTY_KEY], [maxKeys]),
        );
        const entries: Array<{ key: string; parsed: ParsedUsageKey }> = [];
        for (const raw of Array.isArray(dirty) ? dirty : []) {
            const key = String(raw);
            const parsed = parseUsageKey(key);
            if (parsed) entries.push({ key, parsed });
        }
        if (entries.length === 0) return { ingested: 0, restored: 0, listed: 0 };

        // Resolve endpoint names before taking anything, so a failed lookup
        // leaves the hashes untouched.
        const endpointHashes = [
            ...new Set(entries.flatMap(e => (e.parsed.kind === 'endpoint' ? [e.parsed.endpointHash] : []))),
        ];
        const endpointNames = new Map<string, string>();
        if (endpointHashes.length > 0) {
            const names = yield* Effect.tryPromise(() =>
                redis.eval<unknown[]>(
                    USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT.script,
                    endpointHashes.map(usageEndpointNameKey),
                    [],
                ),
            );
            endpointHashes.forEach((hash, i) => {
                const name = Array.isArray(names) ? names[i] : null;
                if (typeof name === 'string' && name) endpointNames.set(hash, name);
            });
        }

        const replies = yield* Effect.tryPromise(() =>
            redis.eval<unknown[]>(
                USAGE_DRAIN_TAKE_SCRIPT.script,
                [USAGE_DIRTY_KEY, ...entries.map(e => e.key)],
                [],
            ),
        );

        const ready: Array<TakenHash & { bucket: UsageAggregateBucket }> = [];
        const unnamed: TakenHash[] = [];
        entries.forEach(({ key, parsed }, i) => {
            const fields = parseHashReply(Array.isArray(replies) ? replies[i] : null);
            // Empty = already drained or expired; the dirty mark was stale.
            if (fields.size === 0) return;
            const endpoint = parsed.kind === 'endpoint' ? (endpointNames.get(parsed.endpointHash) ?? null) : null;
            if (parsed.kind === 'endpoint' && endpoint === null) {
                unnamed.push({ key, fields });
                return;
            }
            ready.push({ key, fields, bucket: toBucket(parsed, fields, endpoint) });
        });

        if (unnamed.length > 0) yield* restoreTaken(redis, unnamed, deps.ttlSeconds);
        if (ready.length === 0) return { ingested: 0, restored: unnamed.length, listed: entries.length };

        yield* deps.ingest(ready.map(r => r.bucket)).pipe(
            Effect.catch(error =>
                restoreTaken(redis, ready, deps.ttlSeconds).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.andThen(Effect.fail(error)),
                ),
            ),
        );

        return { ingested: ready.length, restored: unnamed.length, listed: entries.length };
    });
}

/** Flush dirty usage hashes into the rollup tables. */
export function drainUsageAggregates(deps: UsageDrainDeps): Effect.Effect<UsageDrainResult, unknown> {
    return Effect.gen(function* () {
        const maxKeys = Math.max(1, Math.floor(deps.maxKeys ?? DEFAULT_MAX_KEYS));
        const total: UsageDrainResult = { ingested: 0, restored: 0 };

        for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch++) {
            const result = yield* drainBatch(deps, maxKeys);
            total.ingested += result.ingested;
            total.restored += result.restored;
            // A short page means the dirty set is empty; restored hashes are
            // dirty again, so stop rather than spin on them.
            if (result.listed < maxKeys || result.restored > 0) break;
        }

        return total;
    });
}

let lastDrainAttemptMs = 0;

/**
 * Drain at most once per `intervalSeconds` across all instances. The
 * in-memory check keeps the lock attempt off the per-request path; the Redis
 * lock picks the single instance that drains. Resolves `null` when skipped.
 */
export function maybeDrainUsageAggregates(
    deps: UsageDrainDeps & { intervalSeconds: number; lockValue: string; now?: number },
): Effect.Effect<UsageDrainResult | null, unknown> {
    return Effect.gen(function* () {
        const intervalSeconds = Math.floor(deps.intervalSeconds);
        if (intervalSeconds <= 0) return null;

        const now = deps.now ?? Date.now();
        if (now - lastDrainAttemptMs < intervalSeconds * 1000) return null;
        lastDrainAttemptMs = now;

        const acquired = yield* Effect.tryPromise(() =>
            deps.redis.set(USAGE_DRAIN_LOCK_KEY, deps.lockValue, { nx: true, ex: intervalSeconds }),
        );
        if (acquired !== 'OK') return null;

        return yield* drainUsageAggregates(deps);
    });
}

export function __resetUsageDrainForTesting(): void {
    lastDrainAttemptMs = 0;
}
