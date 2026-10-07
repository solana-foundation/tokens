import { Effect } from 'effect';

import type { UsageAggregateBucket } from '@/lib/cloudrun/platformAuth';
import type { RedisClient } from '@/lib/redis';
import {
    USAGE_DRAIN_CLEAR_DIRTY_SCRIPT,
    USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT,
    USAGE_DRAIN_LIST_DIRTY_SCRIPT,
    USAGE_DRAIN_READ_SCRIPT,
} from '@/lib/redis/lua';

/**
 * Usage-aggregate drain.
 *
 * In `aggregated` usage mode every request increments Redis hashes
 * (`usage:v1:day:*` / `usage:v1:endpoint:*`) instead of writing a row. Those
 * hashes only reach the dashboard once something copies them into the rollup
 * tables. That used to be an external timer, which was retired — so the API
 * drains itself: a request that wins the drain lock syncs the dirty hashes
 * after its response, and a scheduled call to the drain route covers the
 * buckets no later request would flush.
 *
 * The sync is state-based. A hash holds the running totals for its day and is
 * never deleted here; the drain sends those totals and the usage service
 * keeps the larger of stored and incoming. Replaying a batch (lost response,
 * timeout, two instances draining at once) therefore cannot double-count, and
 * a failed sync loses nothing: the hash and its dirty mark are still there.
 * Drains need no mutual exclusion for correctness; the lock below only keeps
 * instances from all draining at once.
 *
 * Two invariants this relies on, both enforced in `lib/env.ts`:
 * - the hash TTL outlasts a day, so a day's totals never restart from zero;
 * - raw sampling is off in aggregated mode, so the event rollup never adds to
 *   rows this sync owns.
 */

const DAY_KEY_PREFIX = 'usage:v1:day:';
const ENDPOINT_KEY_PREFIX = 'usage:v1:endpoint:';
const ENDPOINT_NAME_KEY_PREFIX = 'usage:v1:endpoint-name:';

/**
 * Hash: usage hash key -> mark of the last write to it. Marks are unique per
 * write (never a counter): a drain clears a mark only if it is still the one
 * it listed, and a value that can repeat would let a second, concurrent drain
 * clear a mark written after its own read.
 */
export const USAGE_DIRTY_KEY = 'usage:v1:dirty';
export const USAGE_DRAIN_LOCK_KEY = 'usage:v1:drain-lock';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENDPOINT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const HISTOGRAM_FIELD_PREFIX = 'hist:';
// LATENCY_BOUNDS_MS.length + 1 — must match the usage service's histogram.
const HISTOGRAM_BUCKETS = 14;

const DEFAULT_MAX_KEYS = 200;
const MAX_BATCHES_PER_DRAIN = 5;

/** A fresh dirty mark. Prefixed so no Redis client mistakes it for JSON or a number. */
export function newUsageDirtyMark(): string {
    return `m_${crypto.randomUUID()}`;
}

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
function flatPairs(reply: unknown): Array<[string, unknown]> {
    if (Array.isArray(reply)) {
        const pairs: Array<[string, unknown]> = [];
        for (let i = 0; i + 1 < reply.length; i += 2) pairs.push([String(reply[i]), reply[i + 1]]);
        return pairs;
    }
    if (reply && typeof reply === 'object') return Object.entries(reply);
    return [];
}

function parseHashReply(reply: unknown): Map<string, number> {
    const fields = new Map<string, number>();
    for (const [field, value] of flatPairs(reply)) {
        const count = toCount(value);
        if (count > 0) fields.set(field, count);
    }
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

/** Keeps the Redis error itself as the failure, so drain logs name the real cause. */
function tryRedis<T>(run: () => Promise<T>): Effect.Effect<T, unknown> {
    return Effect.tryPromise({ try: run, catch: error => error });
}

export interface UsageDrainDeps {
    redis: RedisClient;
    sync: (buckets: UsageAggregateBucket[]) => Effect.Effect<void, unknown>;
    maxKeys?: number;
}

export interface UsageDrainResult {
    /** Buckets sent to the usage service. */
    synced: number;
    /** Dirty keys left for the next drain: written to mid-drain, or not yet attributable. */
    pending: number;
}

function drainBatch(deps: UsageDrainDeps, maxKeys: number) {
    return Effect.gen(function* () {
        const { redis } = deps;

        const dirty = yield* tryRedis(() =>
            redis.eval<unknown>(USAGE_DRAIN_LIST_DIRTY_SCRIPT.script, [USAGE_DIRTY_KEY], [maxKeys]),
        );
        const listed = flatPairs(dirty);
        const entries: Array<{ key: string; mark: string; parsed: ParsedUsageKey }> = [];
        for (const [key, mark] of listed) {
            const parsed = parseUsageKey(key);
            if (parsed) entries.push({ key, mark: String(mark), parsed });
        }
        if (entries.length === 0) return { synced: 0, cleared: 0, listed: 0 };

        const endpointHashes = [
            ...new Set(entries.flatMap(e => (e.parsed.kind === 'endpoint' ? [e.parsed.endpointHash] : []))),
        ];
        const endpointNames = new Map<string, string>();
        if (endpointHashes.length > 0) {
            const names = yield* tryRedis(() =>
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

        const replies = yield* tryRedis(() =>
            redis.eval<unknown[]>(
                USAGE_DRAIN_READ_SCRIPT.script,
                entries.map(e => e.key),
                [],
            ),
        );

        const buckets: UsageAggregateBucket[] = [];
        const done: Array<{ key: string; mark: string }> = [];
        entries.forEach(({ key, mark, parsed }, i) => {
            const fields = parseHashReply(Array.isArray(replies) ? replies[i] : null);
            // Empty = the hash expired; only the stale mark is left to clear.
            if (fields.size > 0) {
                const endpoint = parsed.kind === 'endpoint' ? (endpointNames.get(parsed.endpointHash) ?? null) : null;
                // No name yet: leave it dirty rather than sync an unattributable bucket.
                if (parsed.kind === 'endpoint' && endpoint === null) return;
                buckets.push(toBucket(parsed, fields, endpoint));
            }
            done.push({ key, mark });
        });

        if (buckets.length > 0) yield* deps.sync(buckets);

        const cleared =
            done.length > 0
                ? yield* tryRedis(() =>
                      redis.eval<unknown>(
                          USAGE_DRAIN_CLEAR_DIRTY_SCRIPT.script,
                          [USAGE_DIRTY_KEY],
                          done.flatMap(d => [d.key, d.mark]),
                      ),
                  )
                : 0;

        return { synced: buckets.length, cleared: toCount(cleared), listed: entries.length };
    });
}

/** Sync dirty usage hashes into the rollup tables. */
export function drainUsageAggregates(deps: UsageDrainDeps): Effect.Effect<UsageDrainResult, unknown> {
    return Effect.gen(function* () {
        const maxKeys = Math.max(1, Math.floor(deps.maxKeys ?? DEFAULT_MAX_KEYS));
        const total: UsageDrainResult = { synced: 0, pending: 0 };

        for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch++) {
            const result = yield* drainBatch(deps, maxKeys);
            total.synced += result.synced;
            total.pending = result.listed - result.cleared;
            // A short page means the index is drained. A page that cleared
            // nothing would be listed again unchanged, so stop on it too.
            if (result.listed < maxKeys || result.cleared === 0) break;
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

        const acquired = yield* tryRedis(() =>
            deps.redis.set(USAGE_DRAIN_LOCK_KEY, deps.lockValue, { nx: true, ex: intervalSeconds }),
        );
        if (acquired !== 'OK') return null;

        return yield* drainUsageAggregates(deps);
    });
}

export function __resetUsageDrainForTesting(): void {
    lastDrainAttemptMs = 0;
}
