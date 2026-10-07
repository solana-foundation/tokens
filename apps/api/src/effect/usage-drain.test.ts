import { beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import type { UsageAggregateBucket } from '@/lib/cloudrun/platformAuth';
import type { RedisClient, RedisPipeline, RedisSetOptions } from '@/lib/redis';
import {
    USAGE_DRAIN_CLEAR_DIRTY_SCRIPT,
    USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT,
    USAGE_DRAIN_LIST_DIRTY_SCRIPT,
    USAGE_DRAIN_READ_SCRIPT,
} from '@/lib/redis/lua';

import {
    __resetUsageDrainForTesting,
    drainUsageAggregates,
    maybeDrainUsageAggregates,
    newUsageDirtyMark,
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
const SEARCH = '/api/v1/assets/search';

/** In-memory Redis that executes the drain scripts' semantics. */
function makeFakeRedis(options: { numericReplies?: boolean; onRead?: () => void; onSync?: () => void } = {}) {
    const hashes = new Map<string, Map<string, number | string>>();
    const strings = new Map<string, string>();
    const reply = (value: number) => (options.numericReplies ? value : String(value));

    const hincrby = (key: string, field: string, delta: number) => {
        const hash = hashes.get(key) ?? new Map<string, number | string>();
        hash.set(field, Number(hash.get(field) ?? 0) + delta);
        hashes.set(key, hash);
    };
    const hset = (key: string, field: string, value: string) => {
        const hash = hashes.get(key) ?? new Map<string, number | string>();
        hash.set(field, value);
        hashes.set(key, hash);
    };
    const hgetall = (key: string) => {
        const flat: Array<string | number> = [];
        for (const [field, value] of hashes.get(key) ?? []) {
            flat.push(field, typeof value === 'number' ? reply(value) : value);
        }
        return flat;
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
            throw new Error('the drain must not write usage');
        },
        async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
            if (script === USAGE_DRAIN_LIST_DIRTY_SCRIPT.script) {
                return hgetall(keys[0]!).slice(0, Number(args[0]) * 2) as T;
            }
            if (script === USAGE_DRAIN_ENDPOINT_NAMES_SCRIPT.script) {
                return keys.map(key => strings.get(key) ?? null) as T;
            }
            if (script === USAGE_DRAIN_READ_SCRIPT.script) {
                const out = keys.map(hgetall);
                options.onRead?.();
                return out as T;
            }
            if (script === USAGE_DRAIN_CLEAR_DIRTY_SCRIPT.script) {
                const dirty = hashes.get(keys[0]!);
                let cleared = 0;
                for (let i = 0; i + 1 < args.length; i += 2) {
                    const field = String(args[i]);
                    if (dirty?.has(field) && String(dirty.get(field)) === String(args[i + 1])) {
                        dirty.delete(field);
                        cleared += 1;
                    }
                }
                return cleared as T;
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
        const mark = newUsageDirtyMark();
        hset(USAGE_DIRTY_KEY, dayKey, mark);
        hset(USAGE_DIRTY_KEY, endpointKey, mark);
    };

    const dirtyKeys = () => [...(hashes.get(USAGE_DIRTY_KEY)?.keys() ?? [])];

    return { redis, hashes, strings, record, dirtyKeys };
}

function makeSync(fail = false) {
    const calls: UsageAggregateBucket[][] = [];
    const sync = (buckets: UsageAggregateBucket[]) =>
        Effect.suspend(() => {
            calls.push(buckets);
            return fail ? Effect.fail(new Error('usage service down')) : Effect.void;
        });
    return { sync, calls };
}

const daily = (buckets: UsageAggregateBucket[] | undefined) => buckets?.find(b => !b.endpoint);

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

describe('newUsageDirtyMark', () => {
    it('never repeats and cannot be parsed as JSON or a number', () => {
        const marks = new Set(Array.from({ length: 1_000 }, newUsageDirtyMark));
        expect(marks.size).toBe(1_000);
        for (const mark of marks) {
            expect(Number.isNaN(Number(mark))).toBe(true);
            let parsed = false;
            try {
                JSON.parse(mark);
                parsed = true;
            } catch {
                // expected: a mark is not JSON
            }
            expect(parsed).toBe(false);
        }
    });
});

describe('drainUsageAggregates', () => {
    it('syncs the running totals and clears the dirty marks, leaving the hashes in place', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 1);
        fake.record(HASH_A, SEARCH, 1);
        fake.record(HASH_B, '/api/v1/whoami', 13);
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(result).toEqual({ synced: 3, pending: 0 });
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
        const search = byEndpoint.get(SEARCH)!;
        expect(search.totalCalls).toBe(2);
        expect(search.latencyHistogram).toEqual([0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(byEndpoint.get('/api/v1/whoami')!.latencyHistogram![13]).toBe(1);

        expect(fake.dirtyKeys()).toEqual([]);
        // The hash is the running total for the day; the drain never deletes it.
        expect(fake.hashes.get(usageDayKey(DAY, PROJECT))?.get('totalCalls')).toBe(3);
    });

    it('sends the full day total again after more requests, not a delta', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 1);
        const { sync, calls } = makeSync();
        await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        fake.record(HASH_A, SEARCH, 1);
        fake.record(HASH_A, SEARCH, 1);
        await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(calls.map(c => daily(c)!.totalCalls)).toEqual([1, 3]);
    });

    it('reads replies the client already deserialized to numbers', async () => {
        const fake = makeFakeRedis({ numericReplies: true });
        fake.record(HASH_A, SEARCH, 0);
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(daily(calls[0])!.totalCalls).toBe(1);
        expect(result).toEqual({ synced: 2, pending: 0 });
    });

    it('does nothing when no usage is dirty', async () => {
        const fake = makeFakeRedis();
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(result).toEqual({ synced: 0, pending: 0 });
        expect(calls.length).toBe(0);
    });

    it('drops a stale dirty mark whose hash already expired', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 0);
        fake.hashes.delete(usageDayKey(DAY, PROJECT));
        fake.hashes.delete(usageEndpointKey(DAY, PROJECT, HASH_A));
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(result).toEqual({ synced: 0, pending: 0 });
        expect(calls.length).toBe(0);
        expect(fake.dirtyKeys()).toEqual([]);
    });

    it('changes nothing in Redis when the sync fails, so the next drain retries the same totals', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 2);
        const failing = makeSync(true);

        const error = await Effect.runPromise(
            Effect.flip(drainUsageAggregates({ redis: fake.redis, sync: failing.sync })),
        );
        expect((error as Error).message).toBe('usage service down');

        expect(fake.hashes.get(usageDayKey(DAY, PROJECT))?.get('totalCalls')).toBe(1);
        expect(fake.dirtyKeys().length).toBe(2);

        // Whether or not the failed call was applied, the retry carries the
        // same totals — there is nothing to add twice.
        const { sync, calls } = makeSync();
        const retry = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));
        expect(retry).toEqual({ synced: 2, pending: 0 });
        expect(calls[0]).toEqual(failing.calls[0]!);
    });

    it('keeps a key dirty when a request writes to it mid-drain', async () => {
        let raced = false;
        const fake = makeFakeRedis({
            onRead: () => {
                if (raced) return;
                raced = true;
                fake.record(HASH_A, SEARCH, 1);
            },
        });
        fake.record(HASH_A, SEARCH, 1);
        const { sync, calls } = makeSync();

        const first = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(first).toEqual({ synced: 2, pending: 2 });
        expect(daily(calls[0])!.totalCalls).toBe(1);
        expect(fake.dirtyKeys().length).toBe(2);

        const second = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));
        expect(second).toEqual({ synced: 2, pending: 0 });
        expect(daily(calls[1])!.totalCalls).toBe(2);
    });

    it('a concurrent drain cannot clear a mark written after its own read', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 1);
        const { sync } = makeSync();
        // Drain B lists and reads, then stalls in its sync call. Meanwhile
        // drain A finishes and a request re-dirties the keys.
        const slow = makeSync();
        const stalledSync = (buckets: UsageAggregateBucket[]) =>
            Effect.gen(function* () {
                yield* Effect.promise(() => Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync })));
                fake.record(HASH_A, SEARCH, 1);
                yield* slow.sync(buckets);
            });

        const drainB = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync: stalledSync }));

        // B synced its older snapshot but must leave the newer write dirty.
        expect(daily(slow.calls[0])!.totalCalls).toBe(1);
        expect(drainB.pending).toBe(2);
        expect(fake.dirtyKeys().length).toBe(2);

        const after = makeSync();
        await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync: after.sync }));
        expect(daily(after.calls[0])!.totalCalls).toBe(2);
        expect(fake.dirtyKeys()).toEqual([]);
    });

    it('holds back an endpoint bucket whose name is missing', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 0);
        fake.strings.delete(usageEndpointNameKey(HASH_A));
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync }));

        expect(result).toEqual({ synced: 1, pending: 1 });
        expect(calls[0]!.map(b => b.endpoint)).toEqual([undefined]);
        expect(fake.dirtyKeys()).toEqual([usageEndpointKey(DAY, PROJECT, HASH_A)]);
    });

    it('pages through more dirty keys than one batch holds', async () => {
        const fake = makeFakeRedis();
        for (let i = 0; i < 3; i++) fake.record(HASH_A, SEARCH, 0, `prj_${i}`);
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync, maxKeys: 4 }));

        expect(result).toEqual({ synced: 6, pending: 0 });
        expect(calls.map(c => c.length)).toEqual([4, 2]);
        expect(fake.dirtyKeys()).toEqual([]);
    });

    it('stops instead of spinning when a full page cannot be cleared', async () => {
        const fake = makeFakeRedis();
        for (const hash of [HASH_A, HASH_B]) {
            fake.record(hash, SEARCH, 0);
            fake.strings.delete(usageEndpointNameKey(hash));
        }
        fake.hashes.get(USAGE_DIRTY_KEY)!.delete(usageDayKey(DAY, PROJECT));
        const { sync, calls } = makeSync();

        const result = await Effect.runPromise(drainUsageAggregates({ redis: fake.redis, sync, maxKeys: 2 }));

        expect(result).toEqual({ synced: 0, pending: 2 });
        expect(calls.length).toBe(0);
    });
});

describe('maybeDrainUsageAggregates', () => {
    beforeEach(() => __resetUsageDrainForTesting());

    const run = (
        fake: ReturnType<typeof makeFakeRedis>,
        sync: ReturnType<typeof makeSync>['sync'],
        overrides: { intervalSeconds?: number; now?: number } = {},
    ) =>
        Effect.runPromise(
            maybeDrainUsageAggregates({
                redis: fake.redis,
                sync,
                intervalSeconds: overrides.intervalSeconds ?? 60,
                lockValue: 'req_1',
                now: overrides.now ?? 1_000_000,
            }),
        );

    it('drains when it wins the lock', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 0);
        const { sync } = makeSync();

        expect(await run(fake, sync)).toEqual({ synced: 2, pending: 0 });
        expect(fake.strings.get(USAGE_DRAIN_LOCK_KEY)).toBe('req_1');
    });

    it('skips when another instance holds the lock', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 0);
        fake.strings.set(USAGE_DRAIN_LOCK_KEY, 'req_other');
        const { sync, calls } = makeSync();

        expect(await run(fake, sync)).toBeNull();
        expect(calls.length).toBe(0);
        // Skipped, not lost: the marks wait for the next drain.
        expect(fake.dirtyKeys().length).toBe(2);
    });

    it('does not retry the lock inside the interval', async () => {
        const fake = makeFakeRedis();
        const { sync } = makeSync();
        await run(fake, sync, { now: 1_000_000 });
        fake.strings.delete(USAGE_DRAIN_LOCK_KEY);
        fake.record(HASH_A, SEARCH, 0);

        expect(await run(fake, sync, { now: 1_030_000 })).toBeNull();
        expect(await run(fake, sync, { now: 1_060_000 })).toEqual({ synced: 2, pending: 0 });
    });

    it('is disabled by a zero interval', async () => {
        const fake = makeFakeRedis();
        fake.record(HASH_A, SEARCH, 0);
        const { sync, calls } = makeSync();

        expect(await run(fake, sync, { intervalSeconds: 0 })).toBeNull();
        expect(calls.length).toBe(0);
        expect(fake.strings.has(USAGE_DRAIN_LOCK_KEY)).toBe(false);
    });
});
