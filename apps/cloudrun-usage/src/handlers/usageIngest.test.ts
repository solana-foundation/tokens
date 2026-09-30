import { describe, expect, it } from 'bun:test';

import { InvalidArgsError } from './errors';
import { emptyLatencyHistogram } from './histogram';
import { ingestUsageAggregates, syncUsageAggregates, type UsageIngestRepo } from './usageIngest';

const NOW = 1_750_000_000_000; // deterministic "now"

function makeRepo() {
    const applied: Array<{ daily: unknown[]; endpoint: unknown[]; updatedAtMs: number }> = [];
    const synced: Array<{ daily: unknown[]; endpoint: unknown[]; updatedAtMs: number }> = [];
    const repo: UsageIngestRepo = {
        applyIngestBuckets: async args => {
            applied.push(args as never);
        },
        applySyncBuckets: async args => {
            synced.push(args as never);
        },
    };
    return { repo, applied, synced };
}

const DAY_BUCKET = {
    projectId: 'proj_1',
    day: '2026-07-01',
    totalCalls: 10,
    assetCalls: 4,
    successCalls: 9,
    sumLatencyMs: 1_234,
};

describe('ingestUsageAggregates', () => {
    it('splits daily and endpoint buckets and applies them in one call', async () => {
        const { repo, applied } = makeRepo();
        const result = await ingestUsageAggregates(
            repo,
            {
                buckets: [
                    DAY_BUCKET,
                    {
                        ...DAY_BUCKET,
                        endpoint: '/api/v1/assets/:assetId',
                        totalCalls: 6,
                        successCalls: 6,
                        sumLatencyMs: 500,
                        latencyHistogram: [1, 2, 3],
                    },
                ],
            },
            NOW,
        );
        expect(result).toEqual({ ingested: 2, dailyBuckets: 1, endpointBuckets: 1 });
        expect(applied).toHaveLength(1);
        expect(applied[0]?.updatedAtMs).toBe(NOW);
        expect(applied[0]?.daily).toEqual([DAY_BUCKET]);
        const ep = applied[0]?.endpoint[0] as { calls: number; latencyHistogram: number[] };
        expect(ep.calls).toBe(6);
        // Histogram normalized to full bound length.
        expect(ep.latencyHistogram).toHaveLength(emptyLatencyHistogram().length);
        expect(ep.latencyHistogram.slice(0, 3)).toEqual([1, 2, 3]);
    });

    it('skips zero-call buckets and sanitizes negative/NaN counts', async () => {
        const { repo, applied } = makeRepo();
        const result = await ingestUsageAggregates(
            repo,
            {
                buckets: [
                    { ...DAY_BUCKET, totalCalls: 0 },
                    { ...DAY_BUCKET, totalCalls: Number.NaN },
                    { ...DAY_BUCKET, assetCalls: -5, successCalls: 2.9 },
                ],
            },
            NOW,
        );
        expect(result.ingested).toBe(1);
        expect(applied[0]?.daily).toEqual([{ ...DAY_BUCKET, assetCalls: 0, successCalls: 2 }]);
    });

    it('replaces malformed day keys with today (UTC)', async () => {
        const { repo, applied } = makeRepo();
        await ingestUsageAggregates(repo, { buckets: [{ ...DAY_BUCKET, day: 'garbage' }] }, NOW);
        const row = applied[0]?.daily[0] as { day: string };
        expect(row.day).toBe(new Date(NOW).toISOString().slice(0, 10));
    });

    it('caps at 1000 buckets per call', async () => {
        const { repo } = makeRepo();
        const buckets = Array.from({ length: 1_500 }, (_, i) => ({ ...DAY_BUCKET, day: '2026-07-01', totalCalls: i + 1 }));
        const result = await ingestUsageAggregates(repo, { buckets }, NOW);
        expect(result.ingested).toBe(1_000);
    });

    it('does not call the repo when nothing survives validation', async () => {
        const { repo, applied } = makeRepo();
        const result = await ingestUsageAggregates(repo, { buckets: [{ ...DAY_BUCKET, totalCalls: 0 }] }, NOW);
        expect(result).toEqual({ ingested: 0, dailyBuckets: 0, endpointBuckets: 0 });
        expect(applied).toHaveLength(0);
    });

    it('throws InvalidArgsError on malformed input', async () => {
        const { repo } = makeRepo();
        await expect(ingestUsageAggregates(repo, undefined, NOW)).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(ingestUsageAggregates(repo, { buckets: 'nope' }, NOW)).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(ingestUsageAggregates(repo, { buckets: [null] }, NOW)).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            ingestUsageAggregates(repo, { buckets: [{ ...DAY_BUCKET, projectId: 7 }] }, NOW),
        ).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(
            ingestUsageAggregates(repo, { buckets: [{ ...DAY_BUCKET, endpoint: 42 }] }, NOW),
        ).rejects.toBeInstanceOf(InvalidArgsError);
    });
});

describe('syncUsageAggregates', () => {
    it('sends running totals to the replay-safe write, never the additive one', async () => {
        const { repo, applied, synced } = makeRepo();
        const result = await syncUsageAggregates(
            repo,
            { buckets: [DAY_BUCKET, { ...DAY_BUCKET, endpoint: '/api/v1/whoami', latencyHistogram: [5] }] },
            NOW,
        );
        expect(result).toEqual({ ingested: 2, dailyBuckets: 1, endpointBuckets: 1 });
        expect(applied).toHaveLength(0);
        expect(synced).toHaveLength(1);
        expect(synced[0]?.daily).toEqual([DAY_BUCKET]);
        expect(synced[0]?.updatedAtMs).toBe(NOW);
    });

    it('validates like the additive ingest and writes nothing for empty input', async () => {
        const { repo, synced } = makeRepo();
        await expect(syncUsageAggregates(repo, { buckets: 'nope' }, NOW)).rejects.toBeInstanceOf(InvalidArgsError);
        expect(await syncUsageAggregates(repo, { buckets: [{ ...DAY_BUCKET, totalCalls: 0 }] }, NOW)).toEqual({
            ingested: 0,
            dailyBuckets: 0,
            endpointBuckets: 0,
        });
        expect(synced).toHaveLength(0);
    });
});
