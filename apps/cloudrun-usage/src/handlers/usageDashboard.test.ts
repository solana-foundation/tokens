import { describe, expect, it } from 'bun:test';

import type { IdentityRepo } from './clerkIdentity';
import { IdentityRequiredError, UnauthorizedError } from './errors';
import {
    usageGetEndpointPerformance,
    usageGetProjectUsageStats,
    usageGetProjectUsageTimeSeries,
    type DailyRollupRow,
    type EndpointRollupRow,
    type RawUsageEvent,
    type UsageDashboardDeps,
    type UsageDashboardRepo,
} from './usageDashboard';

const IDENT = { clerkUserId: 'user_1' };
// 2026-07-01T12:00:00Z
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0, 0);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const identityRepo: IdentityRepo = {
    listClerkUserIdsByEmail: async () => [],
    getIdentityScoreInputs: async () => ({ memberships: 0, keys: 0, activeKeys: 0 }),
};

interface RepoState {
    isMember?: boolean;
    limits?: unknown;
    cursor?: number | null;
    daily?: DailyRollupRow[];
    endpoint?: EndpointRollupRow[];
    events?: RawUsageEvent[];
    activeKeysUsed?: number;
    failDaily?: boolean;
}

function makeDeps(state: RepoState = {}): { deps: UsageDashboardDeps; eventQueries: number[] } {
    const eventQueries: number[] = [];
    const repo: UsageDashboardRepo = {
        hasProjectMembership: async () => state.isMember ?? true,
        getProjectLimits: async () => ({ exists: true, limits: state.limits ?? null }),
        getRollupCursor: async () => state.cursor ?? null,
        getDailyRollups: async () => {
            if (state.failDaily) throw new Error('db down');
            return state.daily ?? [];
        },
        getEndpointDailyRollups: async () => state.endpoint ?? [],
        getEventsAfterTs: async (_projectId, afterTs) => {
            eventQueries.push(afterTs);
            return (state.events ?? []).filter(e => e.ts > afterTs);
        },
        countActiveKeysUsedSince: async () => state.activeKeysUsed ?? 0,
    };
    return { deps: { repo, identity: identityRepo, now: () => NOW }, eventQueries };
}

function dayKey(offsetDays: number): string {
    return new Date(NOW - offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

describe('membership enforcement', () => {
    it('requires identity (401) and membership (403)', async () => {
        const { deps } = makeDeps();
        await expect(usageGetProjectUsageStats(deps, { projectId: 'p' }, null)).rejects.toBeInstanceOf(
            IdentityRequiredError,
        );

        const denied = makeDeps({ isMember: false });
        await expect(usageGetProjectUsageStats(denied.deps, { projectId: 'p' }, IDENT)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );
        await expect(
            usageGetProjectUsageTimeSeries(denied.deps, { projectId: 'p', days: 7 }, IDENT),
        ).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(
            usageGetEndpointPerformance(denied.deps, { projectId: 'p', days: 7 }, IDENT),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });
});

describe('usageGetProjectUsageStats', () => {
    it('merges rollups and unrolled events into week/month/today windows', async () => {
        const { deps } = makeDeps({
            cursor: NOW - 1000,
            daily: [
                {
                    day: dayKey(0),
                    totalCalls: 10,
                    assetCalls: 6,
                    successCalls: 9,
                    sumLatencyMs: 1_000,
                },
                {
                    day: dayKey(3),
                    totalCalls: 20,
                    assetCalls: 5,
                    successCalls: 18,
                    sumLatencyMs: 2_000,
                },
            ],
            events: [
                // Unrolled event today, after cursor.
                { endpoint: '/api/v1/assets/x', status: 200, latencyMs: 100, ts: NOW - 500 },
            ],
            activeKeysUsed: 2,
            limits: { quota: { requestsPerMonth: 50_000 } },
        });

        const stats = await usageGetProjectUsageStats(deps, { projectId: 'p' }, IDENT);
        // NOW = 2026-07-01: dayKey(0) is in-month (July); dayKey(3)=06-28 is in-week but prior month.
        expect(stats.totalApiCalls).toBe(31); // 10 + 20 + 1 (week window covers both days)
        expect(stats.assetCallsToday).toBe(7); // 6 + 1 event
        expect(stats.assetCallsThisMonth).toBe(7); // July only: 6 + 1 event
        expect(stats.successRate).toBe(Number((((9 + 18 + 1) / 31) * 100).toFixed(1)));
        expect(stats.averageResponseTime).toBe(Math.round((1_000 + 2_000 + 100) / 31));
        expect(stats.uniqueUsers).toBe(2);
        expect(stats.monthlyQuotaLimit).toBe(50_000);
        expect(stats.monthlyQuotaUsed).toBe(11); // July only: 10 + 1 event
        // Deprecated aliases mirror asset calls.
        expect(stats.memoriesStored).toBe(stats.assetCallsThisMonth);
        expect(stats.memoriesAddedToday).toBe(stats.assetCallsToday);
    });

    it('falls back to emptyUsageStats (with quota) when the repo throws', async () => {
        const { deps } = makeDeps({ failDaily: true, limits: { quota: { requestsPerMonth: 123 } } });
        const stats = await usageGetProjectUsageStats(deps, { projectId: 'p' }, IDENT);
        expect(stats.totalApiCalls).toBe(0);
        expect(stats.monthlyQuotaLimit).toBe(123);
    });

    it('defaults the quota (incl. -1 sentinel) to 1,000,000', async () => {
        const none = makeDeps({});
        expect((await usageGetProjectUsageStats(none.deps, { projectId: 'p' }, IDENT)).monthlyQuotaLimit).toBe(
            1_000_000,
        );
        const sentinel = makeDeps({ limits: { quota: { requestsPerMonth: -1 } } });
        expect((await usageGetProjectUsageStats(sentinel.deps, { projectId: 'p' }, IDENT)).monthlyQuotaLimit).toBe(
            1_000_000,
        );
    });
});

describe('loadDashboardRawEvents cursor semantics (via time series)', () => {
    it('with a cursor, only events after max(from-1, cursor) count', async () => {
        const cursor = NOW - 2 * MS_PER_DAY;
        const { deps, eventQueries } = makeDeps({
            cursor,
            daily: [{ day: dayKey(1), totalCalls: 5, assetCalls: 2, successCalls: 5, sumLatencyMs: 50 }],
            events: [
                { endpoint: '/api/v1/assets/a', status: 200, latencyMs: 10, ts: NOW - 3 * MS_PER_DAY }, // pre-cursor: rolled up already
                { endpoint: '/api/v1/assets/b', status: 200, latencyMs: 10, ts: NOW - MS_PER_DAY / 2 }, // post-cursor
            ],
        });
        const series = await usageGetProjectUsageTimeSeries(deps, { projectId: 'p', days: 7 }, IDENT);
        expect(eventQueries[0]).toBe(cursor); // from-1 < cursor → cursor wins
        const today = series[series.length - 1];
        expect(today?.apiCalls).toBe(1);
        const yesterday = series[series.length - 2];
        expect(yesterday?.apiCalls).toBe(5); // rollup only, pre-cursor event NOT double counted
    });

    it('without a cursor: rollups present → no raw events; none → full fallback', async () => {
        const withRollups = makeDeps({
            cursor: null,
            daily: [{ day: dayKey(0), totalCalls: 5, assetCalls: 0, successCalls: 5, sumLatencyMs: 0 }],
            events: [{ endpoint: '/x', status: 200, latencyMs: 10, ts: NOW - 100 }],
        });
        const seriesA = await usageGetProjectUsageTimeSeries(withRollups.deps, { projectId: 'p', days: 1 }, IDENT);
        expect(seriesA[0]?.apiCalls).toBe(5); // event ignored

        const noRollups = makeDeps({
            cursor: null,
            daily: [],
            events: [{ endpoint: '/x', status: 200, latencyMs: 10, ts: NOW - 100 }],
        });
        const seriesB = await usageGetProjectUsageTimeSeries(noRollups.deps, { projectId: 'p', days: 1 }, IDENT);
        expect(seriesB[0]?.apiCalls).toBe(1); // fallback counts raw events
    });
});

describe('usageGetProjectUsageTimeSeries', () => {
    it('zero-fills all requested days and clamps days to [1,30]', async () => {
        const { deps } = makeDeps({ daily: [], events: [] });
        const series = await usageGetProjectUsageTimeSeries(deps, { projectId: 'p', days: 500 }, IDENT);
        expect(series).toHaveLength(30);
        expect(series[0]).toEqual({ date: dayKey(29), apiCalls: 0, assetCalls: 0, memories: 0, users: 0 });
    });
});

describe('usageGetEndpointPerformance', () => {
    it('aggregates rollups + events, computes zone/trend/p95, sorts by calls, caps at 12', async () => {
        const endpointRollups: EndpointRollupRow[] = [];
        for (let i = 0; i < 15; i++) {
            endpointRollups.push({
                day: dayKey(0),
                endpoint: `/api/v1/assets/e${i}`,
                calls: 100 - i,
                successCalls: 90 - i,
                sumLatencyMs: (100 - i) * 50, // avg 50ms → excellent
                latencyHistogram: [0, 100 - i], // all in the 50ms bin
            });
        }
        const { deps } = makeDeps({ cursor: NOW - 1000, endpoint: endpointRollups, events: [] });
        const rows = await usageGetEndpointPerformance(deps, { projectId: 'p', days: 7 }, IDENT);
        expect(rows).toHaveLength(12);
        expect(rows[0]?.endpoint).toBe('/api/v1/assets/e0');
        expect(rows[0]?.calls).toBe(100);
        expect(rows[0]?.zone).toBe('excellent');
        expect(rows[0]?.p95).toBe(50);
        expect(rows[0]?.successRate).toBe(90.0);
    });

    it('detects degrading trend across the window midpoint', async () => {
        const { deps } = makeDeps({
            cursor: NOW - 1000,
            endpoint: [
                {
                    day: dayKey(6), // previous half
                    endpoint: '/e',
                    calls: 10,
                    successCalls: 10,
                    sumLatencyMs: 1_000, // avg 100
                    latencyHistogram: [],
                },
                {
                    day: dayKey(0), // current half
                    endpoint: '/e',
                    calls: 10,
                    successCalls: 10,
                    sumLatencyMs: 2_000, // avg 200 → +100% → degrading
                    latencyHistogram: [],
                },
            ],
        });
        const rows = await usageGetEndpointPerformance(deps, { projectId: 'p', days: 7 }, IDENT);
        expect(rows[0]?.trend).toBe('degrading');
        expect(rows[0]?.avgTime).toBe(150);
    });
});
