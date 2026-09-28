import { beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import type { UsageAggregateBucket } from '@/lib/cloudrun/platformAuth';
import type { RedisClient, RedisPipeline, RedisSetOptions } from '@/lib/redis';
import {
    USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT,
    USAGE_DRAIN_LIST_DIRTY_SCRIPT,
    USAGE_DRAIN_TAKE_SCRIPT,
} from '@/lib/redis/lua';

import {
    __resetUsageDrainForTesting,
    drainUsageAggregates,
    maybeDrainUsageAggregates,
    parseUsageKey,
    USAGE_DIRTY_KEY,
    USAGE_DRAIN_LOCK_KEY,
    usageDayKey,
    usageEndpointKey,
    usageEndpointNameKey,
} from './usage-drain';

const DAY = '2026-09-28';
const PROJECT = 'prj_abc';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const TTL = 172_800;

/** In-memory Redis that executes the drain scripts' semantics. */
function makeFakeRedis(options: { numericReplies?: boolean } = {}) {
    const hashes = new Map<string, Map<string, number>>();
    const strings = new Map<string, string>();

    const hincrby = (key: string, field: string, delta: number) => {
        const hash = hashes.get(key) ?? new Map<string, number>();
        hash.set(field, (hash.get(field) ?? 0) + delta);
        hashes.set(key, hash);
    };

    const redis: RedisClient = {
        async get<T = string>(key: string): Promise<T | null> {
            return (strings.get(key) ?? null) as T | null;
        },
        async set(key: string, value: string | number, opts?: RedisSetOptions): Promise<'OK' | null> {
            if (opts?.nx && strings.has(key)) return null;
            strings.set(key, String(value));
            return 'OK';
        },
        pipeline(): RedisPipeline {
            const ops: Array<() => void> = [];
            const pipe: RedisPipeline = {
                incr: () => pipe,
                expire: () => pipe,
                hincrby(key, field, delta) {
                    ops.push(() => hincrby(key, field, delta));
                    return pipe;
                },
                set(key, value) {
                    ops.push(() => strings.set(key, String(value)));
                    return pipe;
                },
                async exec<TResult extends ReadonlyArray<unknown> = unknown[]>(): Promise<TResult> {
                    for (const op of ops) op();
                    return [] as unknown as TResult;
                },
            };
            return pipe;
        },
        async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
            if (script === USAGE_DRAIN_LIST_DIRTY_SCRIPT.script) {
                const fields = [...(hashes.get(keys[0]!)?.keys() ?? [])];
                return fields.slice(0, Number(args[0])) as T;
            }
            if (script === USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT.script) {
                return keys.map(key => strings.get(key) ?? null) as T;
            }
            if (script === USAGE_DRAIN_TAKE_SCRIPT.script) {
                const [dirtyKey, ...usageKeys] = keys;
                const out = usageKeys.map(key => {
                    const flat: Array<string | number> = [];
                    for (const [field, value] of hashes.get(key) ?? []) {
                        flat.push(field, options.numericReplies ? value : String(value));
                    }
                    hashes.delete(key);
                    hashes.get(dirtyKey!)?.delete(key);
                    return flat;
                });
                return out as T;
            }
            throw new Error('unexpected script');
        },
        async evalsha<T = unknown>(): Promise<T> {
            throw new Error('not implemented');
        },
        async scriptLoad(): Promise<string> {
            throw new Error('not implemented');
        },
    };

    /** Mirrors what `recordUsageAggregate` writes for one request. */
    const record = (endpointHash: string, endpoint: string, latencyBin: number, project = PROJECT) => {
        const dayKey = usageDayKey(DAY, project);
        const endpointKey = usageEndpointKey(DAY, project, endpointHash);
        hincrby(dayKey, 'totalCalls', 1);
        hincrby(dayKey, 'assetCalls', 1);
        hincrby(dayKey, 'successCalls', 1);
        hincrby(dayKey, 'sumLatencyMs', 40);
        hincrby(dayKey, 'status2xx', 1);
        hincrby(endpointKey, 'calls', 1);
        hincrby(endpointKey, 'successCalls', 1);
        hincrby(endpointKey, 'sumLatencyMs', 40);
        hincrby(endpointKey, 'status2xx', 1);
        hincrby(endpointKey, `hist:${latencyBin}`, 1);
        strings.set(usageEndpointNameKey(endpointHash), endpoint);
        hincrby(USAGE_DIRTY_KEY, dayKey, 1);
        hincrby(USAGE_DIRTY_KEY, endpointKey, 1);
    };

    return { redis, hashes, strings, record };
}

function makeIngest(fail = false) {
    const calls: UsageAggregateBucket[][] = [];
    const ingest = (buckets: UsageAggregateBucket[]) =>
        Effect.suspend(() => {
            calls.push(buckets);
            return fail ? Effect.fail(new Error('usage service down')) : Effect.void;
        });
    return { ingest, calls };
}

describe('parseUsageKey', () => {
    it('round-trips day and endpoint keys', () => {
        expect(parseUsageKey(usageDayKey(DAY, PROJECT))).toEqual({ kind: 'day', day: DAY, projectId: PROJECT });
        expect(parseUsageKey(usageEndpointKey(DAY, PROJECT, HASH_A))).toEqual({
            kind: 'endpoint',
            day: DAY,
            projectId: PROJECT,
            endpointHash: HASH_A,
        });
    });

    it('keeps a project id that contains ":"', () => {
        expect(parseUsageKey(usageEndpointKey(DAY, 'org:prj', HASH_A))).toEqual({
            kind: 'endpoint',
            day: DAY,
            projectId: 'org:prj',
            endpointHash: HASH_A,
        });
    });

    it('rejects keys it does not own', () => {
        expect(parseUsageKey('ratelimit:key:abc:3')).toBeNull();
        expect(parseUsageKey('usage:v1:day:garbage:prj')).toBeNull();
        expect(parseUsageKey(`usage:v1:day:${DAY}:`)).toBeNull();
        expect(parseUsageKey(`usage:v1:endpoint:${DAY}:${PROJECT}:nothex`)).toBeNull();
        expect(parseUsageKey(usageEndpointNameKey(HASH_A))).toBeNull();
    });
});

describe('drainUsageAggregates', () => {
    it('ingests daily and per-endpoint buckets, then clears them from Redis', async () => {
        const { redis, hashes, record } = makeFakeRedis();
        record(HASH_A, '/api/v1/assets/search', 1);
        record(HASH_A, '/api/v1/assets/search', 1);
        record(HASH_B, '/api/v1/whoami', 13);
        const { ingest, calls } = makeIngest();

        const result = await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));

        expect(result).toEqual({ ingested: 3, restored: 0 });
        expect(calls.length).toBe(1);
        const byEndpoint = new Map(calls[0]!.map(b => [b.endpoint ?? 'daily', b]));
        expect(byEndpoint.get('daily')).toEqual({
            projectId: PROJECT,
            day: DAY,
            totalCalls: 3,
            assetCalls: 3,
            successCalls: 3,
            sumLatencyMs: 120,
        });
        const search = byEndpoint.get('/api/v1/assets/search')!;
        expect(search.totalCalls).toBe(2);
        expect(search.latencyHistogram).toEqual([0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(byEndpoint.get('/api/v1/whoami')!.latencyHistogram![13]).toBe(1);

        expect(hashes.has(usageDayKey(DAY, PROJECT))).toBe(false);
        expect(hashes.get(USAGE_DIRTY_KEY)?.size).toBe(0);
    });

    it('reads replies the client already deserialized to numbers', async () => {
        const { redis, record } = makeFakeRedis({ numericReplies: true });
        record(HASH_A, '/api/v1/assets/search', 0);
        const { ingest, calls } = makeIngest();

        await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));

        expect(calls[0]!.find(b => !b.endpoint)!.totalCalls).toBe(1);
    });

    it('does nothing when no usage is dirty', async () => {
        const { redis } = makeFakeRedis();
        const { ingest, calls } = makeIngest();

        const result = await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));

        expect(result).toEqual({ ingested: 0, restored: 0 });
        expect(calls.length).toBe(0);
    });

    it('drops a stale dirty mark whose hash already expired', async () => {
        const { redis, hashes, record } = makeFakeRedis();
        record(HASH_A, '/api/v1/assets/search', 0);
        hashes.delete(usageDayKey(DAY, PROJECT));
        hashes.delete(usageEndpointKey(DAY, PROJECT, HASH_A));
        const { ingest, calls } = makeIngest();

        const result = await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));

        expect(result).toEqual({ ingested: 0, restored: 0 });
        expect(calls.length).toBe(0);
        expect(hashes.get(USAGE_DIRTY_KEY)?.size).toBe(0);
    });

    it('restores the counts when the ingest fails so the next drain retries', async () => {
        const { redis, hashes, record } = makeFakeRedis();
        record(HASH_A, '/api/v1/assets/search', 2);
        const failing = makeIngest(true);

        const error = await Effect.runPromise(
            Effect.flip(drainUsageAggregates({ redis, ingest: failing.ingest, ttlSeconds: TTL })),
        );
        expect((error as Error).message).toBe('usage service down');

        expect(hashes.get(usageDayKey(DAY, PROJECT))?.get('totalCalls')).toBe(1);
        expect(hashes.get(USAGE_DIRTY_KEY)?.has(usageDayKey(DAY, PROJECT))).toBe(true);

        const { ingest, calls } = makeIngest();
        const retry = await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));
        expect(retry).toEqual({ ingested: 2, restored: 0 });
        expect(calls[0]!.find(b => b.endpoint)!.latencyHistogram![2]).toBe(1);
    });

    it('holds back an endpoint bucket whose name is missing', async () => {
        const { redis, hashes, strings, record } = makeFakeRedis();
        record(HASH_A, '/api/v1/assets/search', 0);
        strings.delete(usageEndpointNameKey(HASH_A));
        const { ingest, calls } = makeIngest();

        const result = await Effect.runPromise(drainUsageAggregates({ redis, ingest, ttlSeconds: TTL }));

        expect(result).toEqual({ ingested: 1, restored: 1 });
        expect(calls[0]!.map(b => b.endpoint)).toEqual([undefined]);
        expect(hashes.get(usageEndpointKey(DAY, PROJECT, HASH_A))?.get('calls')).toBe(1);
    });

    it('pages through more dirty keys than one batch holds', async () => {
        const { redis, hashes, record } = makeFakeRedis();
        for (let i = 0; i < 3; i++) record(HASH_A, '/api/v1/assets/search', 0, `prj_${i}`);
        const { ingest, calls } = makeIngest();

        const result = await Effect.runPromise(
            drainUsageAggregates({ redis, ingest, ttlSeconds: TTL, maxKeys: 4 }),
        );

        expect(result).toEqual({ ingested: 6, restored: 0 });
        expect(calls.map(c => c.length)).toEqual([4, 2]);
        expect(hashes.get(USAGE_DIRTY_KEY)?.size).toBe(0);
    });
});

describe('maybeDrainUsageAggregates', () => {
    beforeEach(() => __resetUsageDrainForTesting());

    const run = (
        fake: ReturnType<typeof makeFakeRedis>,
        ingest: ReturnType<typeof makeIngest>['ingest'],
        overrides: { intervalSeconds?: number; now?: number } = {},
    ) =>
        Effect.runPromise(
            maybeDrainUsageAggregates({
                redis: fake.redis,
                ingest,
                ttlSeconds: TTL,
                intervalSeconds: overrides.intervalSeconds ?? 60,
                lockValue: 'req_1',
                now: overrides.now ?? 1_000_000,
            }),
        );

    it('drains when it wins the lock', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, '/api/v1/assets/search', 0);
        const { ingest } = makeIngest();

        expect(await run(fake, ingest)).toEqual({ ingested: 2, restored: 0 });
        expect(fake.strings.get(USAGE_DRAIN_LOCK_KEY)).toBe('req_1');
    });

    it('skips when another instance holds the lock', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, '/api/v1/assets/search', 0);
        fake.strings.set(USAGE_DRAIN_LOCK_KEY, 'req_other');
        const { ingest, calls } = makeIngest();

        expect(await run(fake, ingest)).toBeNull();
        expect(calls.length).toBe(0);
    });

    it('does not retry the lock inside the interval', async () => {
        const fake = makeFakeRedis();
        const { ingest } = makeIngest();
        await run(fake, ingest, { now: 1_000_000 });
        fake.strings.delete(USAGE_DRAIN_LOCK_KEY);
        fake.record(HASH_A, '/api/v1/assets/search', 0);

        expect(await run(fake, ingest, { now: 1_030_000 })).toBeNull();
        expect(await run(fake, ingest, { now: 1_060_000 })).toEqual({ ingested: 2, restored: 0 });
    });

    it('is disabled by a zero interval', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, '/api/v1/assets/search', 0);
        const { ingest, calls } = makeIngest();

        expect(await run(fake, ingest, { intervalSeconds: 0 })).toBeNull();
        expect(calls.length).toBe(0);
        expect(fake.strings.has(USAGE_DRAIN_LOCK_KEY)).toBe(false);
    });
});
