import { Effect } from 'effect';

import { RateLimitedError } from '@tokens/effect';

import type { PlatformAuthContext } from './next-route';
import { getRedisClientEffect } from './next-route';
import { slidingWindowLimit } from './sliding-window-rate-limit';

/**
 * Per-key window budget for the two endpoints that can burn provider (Birdeye)
 * lookups: list-member batch adds and curator search. The platform rate limits
 * bound requests/second but not provider cost over time — a key sending
 * batches of unknown mints at the allowed rate could sustain hundreds of
 * provider calls per second. Each *call* is charged (not each lookup — the API
 * cannot know how many mints will miss the local registry), so the worst-case
 * provider spend per key per window is `calls × per-call lookup cap`.
 *
 * Fail-open on Redis trouble: only an actual over-budget verdict blocks, so a
 * cache outage degrades to the per-call caps rather than a hard 500/429.
 */

export type ProviderBudgetKind = 'batch' | 'search';

function envInt(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const DEFAULT_CALLS: Record<ProviderBudgetKind, number> = {
    // 30 batch calls × 50 budgeted lookups = ≤1500 provider calls / window.
    batch: 30,
    // Searches spend ~1 provider lookup each when uncached.
    search: 120,
};

export function enforceProviderBudget(
    auth: PlatformAuthContext,
    kind: ProviderBudgetKind,
): Effect.Effect<void, RateLimitedError> {
    return Effect.gen(function* () {
        const calls =
            kind === 'batch'
                ? envInt('TOKEN_LIST_PROVIDER_BATCH_CALLS_PER_WINDOW', DEFAULT_CALLS.batch)
                : envInt('TOKEN_LIST_PROVIDER_SEARCH_CALLS_PER_WINDOW', DEFAULT_CALLS.search);
        const windowSeconds = envInt('TOKEN_LIST_PROVIDER_BUDGET_WINDOW_SECONDS', 600);

        const redis = yield* getRedisClientEffect();
        const result = yield* slidingWindowLimit({
            redis,
            identifier: `provider-budget:${kind}:${auth.apiKeyId}`,
            tokens: calls,
            windowSeconds,
        });
        if (!result.success) {
            return yield* Effect.fail(
                new RateLimitedError({
                    service: 'providerBudget',
                    message: 'Provider lookup budget exhausted for this key — retry after the window resets',
                    retryAfterMs: Math.max(0, result.reset - Date.now()),
                }),
            );
        }
    }).pipe(
        // Redis/env failures fail open (per-call lookup caps still bound cost).
        Effect.catch(error => (error instanceof RateLimitedError ? Effect.fail(error) : Effect.void)),
    );
}
