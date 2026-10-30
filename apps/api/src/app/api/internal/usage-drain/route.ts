import { timingSafeEqual } from 'node:crypto';

import { Effect } from 'effect';
import { NextResponse } from 'next/server';

import { getRedisClientEffect } from '@/effect/next-route';
import { drainUsageAggregates } from '@/effect/usage-drain';
import { syncUsageAggregates } from '@/lib/cloudrun';
import { loadEnv } from '@/lib/env';
import { logUsageDrain } from '@/lib/http-metrics';

/**
 * Scheduled usage drain. Requests already drain usage after their response,
 * but only while traffic keeps arriving; this route is the trigger that does
 * not depend on another request, so the last buckets of a quiet period are
 * synced before their Redis TTL runs out. Called by the Vercel cron in
 * `vercel.json` (which sends `Authorization: Bearer $CRON_SECRET`).
 *
 * Deliberate exception to the shared API-key wrapper: the caller is a
 * scheduler, not a project. Guarded by a shared secret instead.
 */

function secretMatches(provided: string, expected: string): boolean {
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(request: Request): boolean {
    const env = loadEnv();
    const header = request.headers.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!provided) return false;
    return [env.cronSecret, env.usageIngestSecret].some(secret => secret !== null && secretMatches(provided, secret));
}

async function drain(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'x-request-id': requestId };

    if (!isAuthorized(request)) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
    }

    try {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const redis = yield* getRedisClientEffect();
                return yield* drainUsageAggregates({ redis, sync: syncUsageAggregates });
            }),
        );
        logUsageDrain({ requestId, trigger: 'schedule', status: 'ok', ...result });
        return NextResponse.json({ ok: true, ...result }, { headers });
    } catch (error) {
        logUsageDrain({
            requestId,
            trigger: 'schedule',
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json({ ok: false, error: 'usage_drain_failed' }, { status: 502, headers });
    }
}

export const GET = drain;
export const POST = drain;
