/**
 * Live enrichment tier for the judged-search family: mints we hold no
 * stored row for get the same facts a curated mint has, from the provider,
 * so "any mint gets the same read-out" holds.
 *
 * Two Birdeye endpoints per uncovered mint, fetched concurrently for the
 * whole request under one soft deadline:
 * - `token_overview` (market: price, liquidity, volume, mcap, holders,
 *   unique wallets, supplies, last trade) — only when there is no
 *   `variant_markets_latest` row;
 * - `token_security` (top-10 holder share, creation time, mint/freeze
 *   authority, mutable metadata, transfer fee, LP lock) — only when there is
 *   no `asset_risk_latest` row.
 *
 * Cache: mirrors `app/api/v1/assets/_risk-live-fallback.ts` — Redis key
 * `judge-live:v1:<mint>` (hit 10 min, miss 15 min, error 60 s), a bounded
 * per-process tier, writes after the response. A deadline miss answers with
 * what we have (`degraded`) and the late result still warms the cache.
 *
 * Budget: the caller's effect runs once per request, only when at least one
 * live lookup is needed (a fully cached or fully covered request is free).
 */

import { Duration, Effect, Fiber, Option } from 'effect';

import { runAfterResponse } from '@/effect/after-response';
import { getRedisClientEffect } from '@/effect/next-route';
import { fetchProviderMarketOverview, type ProviderMarketOverview } from '@/lib/birdeye-overview';
import { fetchProviderSecurity, type ProviderSecurity } from '@/lib/birdeye-security';
import type { RedisClient } from '@/lib/redis';
import { emitEvent } from '@tokens/effect';

export interface LiveNeed {
    mint: string;
    market: boolean;
    security: boolean;
}

export interface LiveFacts {
    /** `undefined` = not requested; `null` = provider has nothing for the mint. */
    market?: ProviderMarketOverview | null;
    security?: ProviderSecurity | null;
    /** ms epoch the entry was produced. */
    at: number;
}

export type LiveOutcome = 'ok' | 'degraded' | 'disabled' | 'none';

export interface LiveEnrichmentResult {
    byMint: Map<string, LiveFacts>;
    outcome: LiveOutcome;
    /** Mints whose lookup missed the deadline or failed this request. */
    pending: string[];
    liveLookups: number;
}

export interface LiveEnrichmentOptions<E> {
    /** Charged once, before the provider is called, only when ≥1 lookup is needed. */
    budget?: Effect.Effect<void, E>;
    deadlineMs?: number;
    getRedis?: () => Effect.Effect<RedisClient, unknown>;
    scheduleAfterResponse?: (effect: Effect.Effect<void, never>) => void;
    now?: () => number;
}

const HIT_TTL_SECONDS = 10 * 60;
const MISS_TTL_SECONDS = 15 * 60;
const ERROR_TTL_SECONDS = 60;
const REDIS_TIMEOUT = '500 millis';
const DEFAULT_DEADLINE_MS = 1_500;
const MAX_DEADLINE_MS = 10_000;
const MAX_PROCESS_ENTRIES = 5_000;

interface CachedFacts {
    v: 1;
    market?: ProviderMarketOverview | null;
    security?: ProviderSecurity | null;
    at: number;
}

interface ProcessEntry {
    entry: CachedFacts;
    expiresAt: number;
}

const processCache = new Map<string, ProcessEntry>();

export function liveEnrichmentEnabled(): boolean {
    return process.env.TOKENS_JUDGE_LIVE_ENRICHMENT?.trim().toLowerCase() !== 'off';
}

export function liveDeadlineMs(): number {
    const raw = process.env.TOKENS_JUDGE_LIVE_DEADLINE_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_DEADLINE_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_DEADLINE_MS;
    return Math.min(Math.floor(value), MAX_DEADLINE_MS);
}

function cacheKey(mint: string): string {
    return `judge-live:v1:${mint}`;
}

function rememberInProcess(mint: string, entry: CachedFacts, ttlMs: number, now: number): void {
    if (ttlMs <= 0) return;
    processCache.delete(mint);
    if (processCache.size >= MAX_PROCESS_ENTRIES) {
        const oldest = processCache.keys().next().value;
        if (oldest !== undefined) processCache.delete(oldest);
    }
    processCache.set(mint, { entry, expiresAt: now + ttlMs });
}

function readFromProcess(mint: string, now: number): CachedFacts | null {
    const hit = processCache.get(mint);
    if (!hit) return null;
    if (now >= hit.expiresAt) {
        processCache.delete(mint);
        return null;
    }
    return hit.entry;
}

function ttlSecondsFor(entry: CachedFacts): number {
    // A full miss (provider knows nothing) stays longer than a partial/hit;
    // an entry with any facts refreshes on the hit window.
    const hasFacts = Boolean(entry.market) || Boolean(entry.security);
    return hasFacts ? HIT_TTL_SECONDS : MISS_TTL_SECONDS;
}

function parseCached(raw: unknown): CachedFacts | null {
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object') return null;
    const entry = value as Partial<CachedFacts>;
    if (entry.v !== 1 || typeof entry.at !== 'number') return null;
    const out: CachedFacts = { v: 1, at: entry.at };
    if ('market' in entry) out.market = (entry.market as ProviderMarketOverview | null | undefined) ?? null;
    if ('security' in entry) out.security = (entry.security as ProviderSecurity | null | undefined) ?? null;
    return out;
}

/** An entry covers a need when it carries a verdict (facts or a provider miss) for that part. */
function covers(entry: CachedFacts, need: LiveNeed): boolean {
    if (need.market && entry.market === undefined) return false;
    if (need.security && entry.security === undefined) return false;
    return true;
}

function readCache(deps: Required<Pick<LiveEnrichmentOptions<never>, 'getRedis' | 'now'>>, mint: string) {
    return Effect.suspend(() => {
        const local = readFromProcess(mint, deps.now());
        if (local) return Effect.succeed<CachedFacts | null>(local);
        return Effect.gen(function* () {
            const redis = yield* deps.getRedis();
            const raw = yield* Effect.tryPromise(() => redis.get<unknown>(cacheKey(mint)));
            const parsed = parseCached(raw);
            if (parsed) {
                const now = deps.now();
                const remaining = parsed.at + ttlSecondsFor(parsed) * 1_000 - now;
                rememberInProcess(mint, parsed, Math.min(remaining, ERROR_TTL_SECONDS * 1_000 * 10), now);
            }
            return parsed;
        }).pipe(
            Effect.timeout(REDIS_TIMEOUT),
            Effect.catch(() => Effect.succeed<CachedFacts | null>(null)),
        );
    });
}

function writeCache(
    deps: Required<Pick<LiveEnrichmentOptions<never>, 'getRedis' | 'now'>> & {
        scheduleAfterResponse: (effect: Effect.Effect<void, never>) => void;
    },
    mint: string,
    entry: CachedFacts,
    ttlSeconds: number,
): void {
    rememberInProcess(mint, entry, ttlSeconds * 1_000, deps.now());
    const persist = Effect.gen(function* () {
        const redis = yield* deps.getRedis();
        yield* Effect.tryPromise(() => redis.set(cacheKey(mint), JSON.stringify(entry), { ex: ttlSeconds }));
    }).pipe(
        Effect.timeout(REDIS_TIMEOUT),
        Effect.catch(() => Effect.void),
    );
    deps.scheduleAfterResponse(persist);
}

type Fetched = {
    mint: string;
    market?: ProviderMarketOverview | null;
    security?: ProviderSecurity | null;
    ok: boolean;
};

function fetchOne(need: LiveNeed, deadlineMs: number): Effect.Effect<Fetched, never> {
    const market = need.market
        ? fetchProviderMarketOverview(need.mint, { deadlineMs }).pipe(
              Effect.map(value => ({ ok: true as const, value })),
              Effect.catch(() => Effect.succeed({ ok: false as const, value: null })),
          )
        : Effect.succeed({ ok: true as const, value: undefined });
    const security = need.security
        ? fetchProviderSecurity(need.mint, { deadlineMs }).pipe(
              Effect.map(value => ({ ok: true as const, value })),
              Effect.catch(() => Effect.succeed({ ok: false as const, value: null })),
          )
        : Effect.succeed({ ok: true as const, value: undefined });
    return Effect.all([market, security], { concurrency: 2 }).pipe(
        Effect.map(([m, s]) => ({
            mint: need.mint,
            ...(need.market ? { market: m.value as ProviderMarketOverview | null } : {}),
            ...(need.security ? { security: s.value as ProviderSecurity | null } : {}),
            ok: m.ok && s.ok,
        })),
    );
}

/**
 * Resolve live facts for the mints that need them. Cache first; then one
 * concurrent provider sweep under the deadline; late results are written to
 * the cache after the response.
 */
export function liveEnrich<E>(
    needs: readonly LiveNeed[],
    options: LiveEnrichmentOptions<E> = {},
): Effect.Effect<LiveEnrichmentResult, E> {
    return Effect.gen(function* () {
        const byMint = new Map<string, LiveFacts>();
        const wanted = needs.filter(n => n.market || n.security);
        if (wanted.length === 0) return { byMint, outcome: 'none' as const, pending: [], liveLookups: 0 };
        if (!liveEnrichmentEnabled() || !(process.env.BIRDEYE_API_KEY ?? '').trim()) {
            return { byMint, outcome: 'disabled' as const, pending: [], liveLookups: 0 };
        }

        const now = options.now ?? Date.now;
        const getRedis = options.getRedis ?? (() => getRedisClientEffect());
        const scheduleAfterResponse = options.scheduleAfterResponse ?? runAfterResponse;
        const deps = { getRedis, now, scheduleAfterResponse };
        const deadlineMs = options.deadlineMs ?? liveDeadlineMs();

        // 1. Cache.
        const misses: LiveNeed[] = [];
        for (const need of wanted) {
            const cached = yield* readCache(deps, need.mint);
            if (cached && covers(cached, need)) {
                byMint.set(need.mint, { market: cached.market, security: cached.security, at: cached.at });
            } else {
                // Partial coverage: keep what we have, fetch only the gap.
                if (cached) byMint.set(need.mint, { market: cached.market, security: cached.security, at: cached.at });
                misses.push({
                    mint: need.mint,
                    market: need.market && cached?.market === undefined,
                    security: need.security && cached?.security === undefined,
                });
            }
        }
        if (misses.length === 0) return { byMint, outcome: 'ok' as const, pending: [], liveLookups: 0 };

        // 2. Budget: one charge per request that reaches the provider.
        if (options.budget) yield* options.budget;

        // 3. Concurrent sweep on a detached fiber, raced against the deadline.
        const sweep = Effect.all(
            misses.map(need => fetchOne(need, Math.min(deadlineMs + 2_000, 10_000))),
            { concurrency: 8 },
        );
        const fiber = yield* Effect.forkDetach(sweep);
        const raced = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(Duration.millis(deadlineMs)));

        const absorb = (fetched: Fetched): void => {
            const prior = byMint.get(fetched.mint);
            const entry: CachedFacts = {
                v: 1,
                at: now(),
                ...(prior?.market !== undefined ? { market: prior.market } : {}),
                ...(prior?.security !== undefined ? { security: prior.security } : {}),
                ...('market' in fetched ? { market: fetched.market ?? null } : {}),
                ...('security' in fetched ? { security: fetched.security ?? null } : {}),
            };
            byMint.set(fetched.mint, { market: entry.market, security: entry.security, at: entry.at });
            writeCache(deps, fetched.mint, entry, fetched.ok ? ttlSecondsFor(entry) : ERROR_TTL_SECONDS);
        };

        if (Option.isSome(raced)) {
            for (const fetched of raced.value) absorb(fetched);
            const failed = raced.value.filter(f => !f.ok).map(f => f.mint);
            emitEvent({
                event: 'judge_live_enrichment',
                outcome: failed.length ? 'degraded' : 'ok',
                lookups: misses.length,
                failed: failed.length,
            });
            return {
                byMint,
                outcome: failed.length ? ('degraded' as const) : ('ok' as const),
                pending: failed,
                liveLookups: misses.length,
            };
        }

        // Deadline missed: answer now, warm the cache when the sweep lands.
        scheduleAfterResponse(
            Fiber.join(fiber).pipe(
                Effect.map(results => {
                    for (const fetched of results) absorb(fetched);
                }),
                Effect.catch(() => Effect.void),
            ),
        );
        emitEvent({
            event: 'judge_live_enrichment',
            outcome: 'timeout',
            lookups: misses.length,
            deadline_ms: deadlineMs,
        });
        return { byMint, outcome: 'degraded' as const, pending: misses.map(m => m.mint), liveLookups: misses.length };
    });
}

/** Test helper — clear the per-process tier. */
export function __resetLiveEnrichmentForTesting(): void {
    processCache.clear();
}
