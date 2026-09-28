/**
 * Redis usage-aggregate ingest.
 *
 * Port of `convex/apiUsageRollups.ts:ingestUsageAggregates`. The production
 * apps/api path aggregates per-request usage into Upstash Redis hashes
 * (`usage:v1:day:*` / `usage:v1:endpoint:*`); the API drains them itself
 * (`apps/api/src/effect/usage-drain.ts`) into the rollup tables. This handler
 * is the target for that drain.
 *
 * Auth: the Convex original checked a `secret` arg; on Cloud Run the bearer
 * token on `/mutation/*` covers it, so a `secret` arg is accepted and ignored.
 */

import { InvalidArgsError } from './errors';
import { normalizeLatencyHistogram } from './histogram';

const MAX_BUCKETS_PER_CALL = 1_000;

export interface DailyIngestDelta {
    projectId: string;
    day: string;
    totalCalls: number;
    assetCalls: number;
    successCalls: number;
    sumLatencyMs: number;
}

export interface EndpointIngestDelta {
    projectId: string;
    day: string;
    endpoint: string;
    calls: number;
    successCalls: number;
    sumLatencyMs: number;
    latencyHistogram: number[];
}

export interface UsageIngestRepo {
    /** Apply all deltas additively in a single transaction. */
    applyIngestBuckets(args: {
        daily: DailyIngestDelta[];
        endpoint: EndpointIngestDelta[];
        updatedAtMs: number;
    }): Promise<void>;
}

export interface IngestUsageAggregatesResult {
    ingested: number;
    dailyBuckets: number;
    endpointBuckets: number;
}

function dateKeyUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function validateDayKey(day: unknown, nowMs: number): string {
    return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dateKeyUtc(nowMs);
}

function sanitizeCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

export async function ingestUsageAggregates(
    repo: UsageIngestRepo,
    args: unknown,
    nowMs: number = Date.now(),
): Promise<IngestUsageAggregatesResult> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const rawBuckets = (args as Record<string, unknown>).buckets;
    if (!Array.isArray(rawBuckets)) {
        throw new InvalidArgsError('buckets must be an array');
    }

    const daily: DailyIngestDelta[] = [];
    const endpoint: EndpointIngestDelta[] = [];

    for (const raw of rawBuckets.slice(0, MAX_BUCKETS_PER_CALL)) {
        if (typeof raw !== 'object' || raw === null) {
            throw new InvalidArgsError('each bucket must be an object');
        }
        const b = raw as Record<string, unknown>;
        if (typeof b.projectId !== 'string' || !b.projectId.trim()) {
            throw new InvalidArgsError('bucket.projectId must be a non-empty string');
        }
        if (b.endpoint !== undefined && typeof b.endpoint !== 'string') {
            throw new InvalidArgsError('bucket.endpoint must be a string');
        }

        const projectId = b.projectId.trim();
        const day = validateDayKey(b.day, nowMs);
        const totalCalls = sanitizeCount(b.totalCalls);
        const assetCalls = sanitizeCount(b.assetCalls);
        const successCalls = sanitizeCount(b.successCalls);
        const sumLatencyMs = sanitizeCount(b.sumLatencyMs);
        if (totalCalls <= 0) continue;

        if (b.endpoint) {
            endpoint.push({
                projectId,
                day,
                endpoint: b.endpoint,
                calls: totalCalls,
                successCalls,
                sumLatencyMs,
                latencyHistogram: normalizeLatencyHistogram(b.latencyHistogram ?? []),
            });
            continue;
        }

        daily.push({ projectId, day, totalCalls, assetCalls, successCalls, sumLatencyMs });
    }

    if (daily.length > 0 || endpoint.length > 0) {
        await repo.applyIngestBuckets({ daily, endpoint, updatedAtMs: nowMs });
    }

    return {
        ingested: daily.length + endpoint.length,
        dailyBuckets: daily.length,
        endpointBuckets: endpoint.length,
    };
}
