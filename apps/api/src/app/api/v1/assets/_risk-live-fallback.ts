import { Effect } from 'effect';
import { emitEvent, type RateLimitedError } from '@tokens/effect';

import { getRedisClientEffect, type PlatformAuthContext } from '@/effect/next-route';
import { enforceProviderBudget } from '@/effect/provider-budget';
import { fetchProviderMarketOverview, type ProviderMarketOverview } from '@/lib/birdeye-overview';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import type { RedisClient } from '@/lib/redis';

/**
 * Live market read for risk scoring when a mint has no usable variant-market
 * snapshot — mints outside the registry (most new launches, and big names
 * that were never curated) never get one, because the cache warm only serves
 * registry variants.
 *
 * Deliberately a non-persisting read: writing a snapshot row would enrol the
 * mint in the stale-refresh cron forever, letting public traffic grow the
 * refresh set without bound. Results are cached in Redis instead, and the
 * provider spend is bounded per API key by the `risk` budget.
 *
 * Never fails and never produces data it didn't read: every failure mode
 * resolves to `market: null`, which callers report as unscored.
 */

export type LiveMarketOutcome =
    'cached_hit' | 'cached_miss' | 'live_hit' | 'live_miss' | 'budget_exhausted' | 'provider_error' | 'not_configured';

export interface LiveMarketResult {
    market: ProviderMarketOverview | null;
    outcome: LiveMarketOutcome;
    /** When `market` was read from the provider (ms epoch); `null` without a market. */
    fetchedAt: number | null;
}

export interface LiveMarketDeps {
    getRedis: () => Effect.Effect<RedisClient, unknown>;
    checkBudget: (auth: PlatformAuthContext) => Effect.Effect<void, RateLimitedError>;
    fetchOverview: (mint: string) => Effect.Effect<ProviderMarketOverview | null, unknown>;
    scheduleWarm: (mint: string) => Effect.Effect<void, never>;
    now: () => number;
}

const HIT_TTL_SECONDS = 5 * 60;
// A mint the provider doesn't know keeps not existing for a while.
const MISS_TTL_SECONDS = 15 * 60;
// Short, so a provider blip isn't pinned but a failing provider isn't hammered.
const ERROR_TTL_SECONDS = 60;

const REDIS_TIMEOUT = '500 millis';
const BUDGET_TIMEOUT = '1 second';
const DEADLINE = '5 seconds';

interface CachedLiveMarket {
    v: 1;
    market: ProviderMarketOverview | null;
    at: number;
}

function cacheKey(mint: string): string {
    return `risk-live:v1:${mint}`;
}

function toNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseCached(raw: unknown): CachedLiveMarket | null {
    // Upstash returns the parsed object; Memorystore returns the JSON string.
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object') return null;

    const entry = value as { v?: unknown; market?: unknown; at?: unknown };
    if (entry.v !== 1 || typeof entry.at !== 'number') return null;
    if (entry.market === null) return { v: 1, market: null, at: entry.at };
    if (!entry.market || typeof entry.market !== 'object') return null;

    const market = entry.market as Record<string, unknown>;
    const liquidity = toNumberOrNull(market.liquidity);
    const marketCap = toNumberOrNull(market.marketCap);
    // A hit always carries one of these; anything else is a corrupt entry.
    if (liquidity === null && marketCap === null) return null;

    return {
        v: 1,
        market: {
            liquidity,
            marketCap,
            holder: toNumberOrNull(market.holder),
            volume24hUSD: toNumberOrNull(market.volume24hUSD),
        },
        at: entry.at,
    };
}

function readCache(deps: LiveMarketDeps, mint: string): Effect.Effect<CachedLiveMarket | null, never> {
    return Effect.gen(function* () {
        const redis = yield* deps.getRedis();
        const raw = yield* Effect.tryPromise(() => redis.get<unknown>(cacheKey(mint)));
        return parseCached(raw);
    }).pipe(
        Effect.timeout(REDIS_TIMEOUT),
        Effect.catch(() => Effect.succeed(null)),
    );
}

function writeCache(
    deps: LiveMarketDeps,
    mint: string,
    market: ProviderMarketOverview | null,
    ttlSeconds: number,
): Effect.Effect<void, never> {
    return Effect.gen(function* () {
        const redis = yield* deps.getRedis();
        const entry: CachedLiveMarket = { v: 1, market, at: deps.now() };
        yield* Effect.tryPromise(() => redis.set(cacheKey(mint), JSON.stringify(entry), { ex: ttlSeconds }));
    }).pipe(
        Effect.timeout(REDIS_TIMEOUT),
        Effect.catch(() => Effect.void),
    );
}

function hasTag(error: unknown, tag: string): boolean {
    return !!error && typeof error === 'object' && (error as { _tag?: unknown })._tag === tag;
}

const defaultDeps: LiveMarketDeps = {
    getRedis: getRedisClientEffect,
    checkBudget: auth => enforceProviderBudget(auth, 'risk'),
    fetchOverview: mint => fetchProviderMarketOverview(mint),
    // Harmless for mints outside the registry (the warm skips them); for a
    // registry mint with a missing row it gets the real snapshot built.
    scheduleWarm: mint =>
        scheduleCacheWarm(null, {
            mint,
            variantMarket: true,
            markets: false,
            ohlcv: false,
            minAgeMs: 0,
            label: 'assets.risk.liveFallback.scheduleVariantWarm',
        }),
    now: () => Date.now(),
};

/** True when a snapshot can't feed the scorer: missing, or carrying neither liquidity nor market cap. */
export function needsLiveFallback(
    market: { liquidity?: number | null; marketCap?: number | null } | null | undefined,
): boolean {
    if (!market) return true;
    return market.liquidity == null && market.marketCap == null;
}

export function loadLiveMarketFallback(
    auth: PlatformAuthContext,
    mint: string,
    deps: LiveMarketDeps = defaultDeps,
): Effect.Effect<LiveMarketResult, never> {
    const started = deps.now();
    const unscored = (outcome: LiveMarketOutcome): LiveMarketResult => ({ market: null, outcome, fetchedAt: null });

    const load: Effect.Effect<LiveMarketResult, never> = Effect.gen(function* () {
        // Cached results cost nothing, so they aren't charged to the budget.
        const cached = yield* readCache(deps, mint);
        if (cached) {
            return cached.market
                ? { market: cached.market, outcome: 'cached_hit' as const, fetchedAt: cached.at }
                : unscored('cached_miss');
        }

        // Only an actual over-budget verdict blocks; a slow or broken budget
        // check fails open, like the other provider-backed endpoints.
        const overBudget = yield* deps.checkBudget(auth).pipe(
            Effect.timeout(BUDGET_TIMEOUT),
            Effect.as(false),
            Effect.catch(error => Effect.succeed(hasTag(error, 'RateLimitedError'))),
        );
        if (overBudget) return unscored('budget_exhausted');

        const fetched = yield* deps.fetchOverview(mint).pipe(
            Effect.map(market => ({ ok: true as const, market })),
            Effect.catch(error => Effect.succeed({ ok: false as const, error })),
        );

        // Debounced by the cache: at most one warm per mint per cache window.
        yield* deps.scheduleWarm(mint);

        if (!fetched.ok) {
            if (hasTag(fetched.error, 'MissingEnvError')) return unscored('not_configured');
            yield* writeCache(deps, mint, null, ERROR_TTL_SECONDS);
            return unscored('provider_error');
        }

        if (!fetched.market) {
            yield* writeCache(deps, mint, null, MISS_TTL_SECONDS);
            return unscored('live_miss');
        }

        yield* writeCache(deps, mint, fetched.market, HIT_TTL_SECONDS);
        return { market: fetched.market, outcome: 'live_hit' as const, fetchedAt: deps.now() };
    });

    return load.pipe(
        Effect.timeout(DEADLINE),
        // Timeouts and defects alike: this read must never fail the request.
        Effect.catchCause(() => Effect.succeed(unscored('provider_error'))),
        Effect.tap(result =>
            Effect.sync(() =>
                emitEvent({
                    event: 'risk_live_fallback',
                    mint,
                    outcome: result.outcome,
                    duration_ms: deps.now() - started,
                }),
            ),
        ),
    );
}
