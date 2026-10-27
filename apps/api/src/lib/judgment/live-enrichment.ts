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
 *   no stored security block.
 *
 * Cache: mirrors `app/api/v1/assets/_risk-live-fallback.ts` — Redis key
 * `judge-live:v1:<mint>` (hit 10 min, miss 15 min, error 60 s), a bounded
 * per-process tier, writes after the response. The two halves of an entry
 * carry their own fetch time and expiry, so filling the missing half of a
 * cached mint never re-stamps the half we already had (an old price must
 * not look freshly fetched, and its cache life must not restart). Cache
 * reads for a request run concurrently, each on its own Redis timeout, so
 * the wait is one timeout per request and a slow read costs only its own
 * mint.
 *
 * Deadline: lookups complete independently; whatever has landed when the
 * deadline passes is used now, the rest is judged on what we have
 * (`degraded`) and still warms the cache after the response.
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
    /** `undefined` = not held; `null` = provider has nothing for the mint. */
    market?: ProviderMarketOverview | null;
    /** ms epoch the market half was fetched. */
    marketAt?: number;
    security?: ProviderSecurity | null;
    /** ms epoch the security half was fetched. */
    securityAt?: number;
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
/** Provider calls in flight at once for one request (two endpoints per mint). */
const PROVIDER_CONCURRENCY = 8;

/** One half of a cache entry: its verdict, when it was fetched, and when it stops being servable. */
interface CachedHalf<T> {
    value: T | null;
    at: number;
    exp: number;
}

interface CachedFacts {
    v: 2;
    market?: CachedHalf<ProviderMarketOverview>;
    security?: CachedHalf<ProviderSecurity>;
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

/** Latest expiry across the halves an entry holds (0 when it holds none). */
function entryExpiry(entry: CachedFacts): number {
    return Math.max(entry.market?.exp ?? 0, entry.security?.exp ?? 0);
}

/** Drop halves that are past their own expiry; `null` when nothing is left. */
function pruneExpired(entry: CachedFacts, now: number): CachedFacts | null {
    const out: CachedFacts = { v: 2 };
    if (entry.market && entry.market.exp > now) out.market = entry.market;
    if (entry.security && entry.security.exp > now) out.security = entry.security;
    return out.market || out.security ? out : null;
}

function rememberInProcess(mint: string, entry: CachedFacts, now: number): void {
    const expiresAt = entryExpiry(entry);
    if (expiresAt <= now) return;
    processCache.delete(mint);
    if (processCache.size >= MAX_PROCESS_ENTRIES) {
        const oldest = processCache.keys().next().value;
        if (oldest !== undefined) processCache.delete(oldest);
    }
    processCache.set(mint, { entry, expiresAt });
}

function readFromProcess(mint: string, now: number): CachedFacts | null {
    const hit = processCache.get(mint);
    if (!hit) return null;
    if (now >= hit.expiresAt) {
        processCache.delete(mint);
        return null;
    }
    return pruneExpired(hit.entry, now);
}

function ttlSecondsFor(hasFacts: boolean, ok: boolean): number {
    if (!ok) return ERROR_TTL_SECONDS;
    // A miss (provider knows nothing) stays longer than a hit.
    return hasFacts ? HIT_TTL_SECONDS : MISS_TTL_SECONDS;
}

function parseHalf<T>(raw: unknown): CachedHalf<T> | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const half = raw as Partial<CachedHalf<T>>;
    if (typeof half.at !== 'number' || typeof half.exp !== 'number') return undefined;
    if (!('value' in half)) return undefined;
    return { value: (half.value as T | null | undefined) ?? null, at: half.at, exp: half.exp };
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
    // v1 entries (one timestamp for both halves) are ignored, not migrated.
    if (entry.v !== 2) return null;
    const out: CachedFacts = { v: 2 };
    const market = parseHalf<ProviderMarketOverview>(entry.market);
    const security = parseHalf<ProviderSecurity>(entry.security);
    if (market) out.market = market;
    if (security) out.security = security;
    return out.market || out.security ? out : null;
}

/** An entry covers a need when it carries a verdict (facts or a provider miss) for that part. */
function covers(entry: CachedFacts, need: LiveNeed): boolean {
    if (need.market && !entry.market) return false;
    if (need.security && !entry.security) return false;
    return true;
}

function toFacts(entry: CachedFacts): LiveFacts {
    return {
        ...(entry.market ? { market: entry.market.value, marketAt: entry.market.at } : {}),
        ...(entry.security ? { security: entry.security.value, securityAt: entry.security.at } : {}),
    };
}

type CacheDeps = {
    getRedis: () => Effect.Effect<RedisClient, unknown>;
    now: () => number;
    scheduleAfterResponse: (effect: Effect.Effect<void, never>) => void;
};

function readCache(deps: CacheDeps, mint: string): Effect.Effect<CachedFacts | null, never> {
    return Effect.suspend(() => {
        const now = deps.now();
        const local = readFromProcess(mint, now);
        if (local) return Effect.succeed<CachedFacts | null>(local);
        return Effect.gen(function* () {
            const redis = yield* deps.getRedis();
            const raw = yield* Effect.tryPromise(() => redis.get<unknown>(cacheKey(mint)));
            const parsed = parseCached(raw);
            if (!parsed) return null;
            const readAt = deps.now();
            const live = pruneExpired(parsed, readAt);
            if (!live) return null;
            rememberInProcess(mint, live, readAt);
            return live;
        }).pipe(
            // Each read has its own leash; a slow read is a miss for that mint only.
            Effect.timeout(REDIS_TIMEOUT),
            Effect.catch(() => Effect.succeed<CachedFacts | null>(null)),
        );
    });
}

/**
 * All cache reads for a request at once. Reads run concurrently, so the wait
 * is one Redis timeout for the whole request, and each read fails on its own:
 * a slow read for one mint never drops the hits (process or Redis) of the
 * others.
 */
function readCacheAll(deps: CacheDeps, mints: readonly string[]): Effect.Effect<Map<string, CachedFacts>, never> {
    return Effect.all(
        mints.map(mint => readCache(deps, mint).pipe(Effect.map(entry => [mint, entry] as const))),
        { concurrency: 'unbounded' },
    ).pipe(
        Effect.map(pairs => {
            const out = new Map<string, CachedFacts>();
            for (const [mint, entry] of pairs) if (entry) out.set(mint, entry);
            return out;
        }),
    );
}

function writeCache(deps: CacheDeps, mint: string, entry: CachedFacts): void {
    const now = deps.now();
    rememberInProcess(mint, entry, now);
    const ttlSeconds = Math.max(1, Math.ceil((entryExpiry(entry) - now) / 1_000));
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
    market?: { value: ProviderMarketOverview | null; ok: boolean };
    security?: { value: ProviderSecurity | null; ok: boolean };
};

/**
 * One mint's lookups. `Effect.suspend` matters: the provider clients create
 * their `AbortSignal.timeout` when called, so the clock must start when the
 * fetch actually runs (after it clears the concurrency queue), not when the
 * sweep is assembled.
 */
function fetchOne(need: LiveNeed, perCallDeadlineMs: number): Effect.Effect<Fetched, never> {
    const market = need.market
        ? Effect.suspend(() => fetchProviderMarketOverview(need.mint, { deadlineMs: perCallDeadlineMs })).pipe(
              Effect.map(value => ({ ok: true, value })),
              Effect.catch(() => Effect.succeed({ ok: false, value: null })),
          )
        : Effect.succeed(null);
    const security = need.security
        ? Effect.suspend(() => fetchProviderSecurity(need.mint, { deadlineMs: perCallDeadlineMs })).pipe(
              Effect.map(value => ({ ok: true, value })),
              Effect.catch(() => Effect.succeed({ ok: false, value: null })),
          )
        : Effect.succeed(null);
    return Effect.all([market, security], { concurrency: 2 }).pipe(
        Effect.map(([m, s]) => ({
            mint: need.mint,
            ...(m ? { market: m } : {}),
            ...(s ? { security: s } : {}),
        })),
    );
}

function fetchedOk(fetched: Fetched): boolean {
    return (fetched.market?.ok ?? true) && (fetched.security?.ok ?? true);
}

/**
 * Resolve live facts for the mints that need them. Cache first; then one
 * concurrent provider sweep. Each lookup lands in the result as soon as it
 * completes; the deadline only decides which of them this response waits
 * for. Late ones are written to the cache after the response.
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
        const deps: CacheDeps = {
            getRedis: options.getRedis ?? (() => getRedisClientEffect()),
            now,
            scheduleAfterResponse: options.scheduleAfterResponse ?? runAfterResponse,
        };
        const deadlineMs = options.deadlineMs ?? liveDeadlineMs();

        // 1. Cache, all mints at once.
        const cached = yield* readCacheAll(
            deps,
            wanted.map(n => n.mint),
        );
        const misses: LiveNeed[] = [];
        for (const need of wanted) {
            const entry = cached.get(need.mint);
            if (entry) byMint.set(need.mint, toFacts(entry));
            if (entry && covers(entry, need)) continue;
            // Partial coverage: keep what we have, fetch only the gap.
            misses.push({
                mint: need.mint,
                market: need.market && !entry?.market,
                security: need.security && !entry?.security,
            });
        }
        if (misses.length === 0) return { byMint, outcome: 'ok' as const, pending: [], liveLookups: 0 };

        // 2. Budget: one charge per request that reaches the provider.
        if (options.budget) yield* options.budget;

        // 3. Sweep on a detached fiber. Every lookup records itself the moment
        //    it finishes, so the deadline only trims what is still running.
        const completed = new Map<string, Fetched>();
        const absorbed = new Set<string>();
        const absorb = (fetched: Fetched): void => {
            if (absorbed.has(fetched.mint)) return;
            absorbed.add(fetched.mint);
            // The half we already held keeps its own fetch time and expiry;
            // only the half fetched now is stamped with now.
            const prior = cached.get(fetched.mint);
            const at = now();
            const entry: CachedFacts = { v: 2 };
            if (fetched.market) {
                entry.market = {
                    value: fetched.market.value,
                    at,
                    exp: at + ttlSecondsFor(Boolean(fetched.market.value), fetched.market.ok) * 1_000,
                };
            } else if (prior?.market) {
                entry.market = prior.market;
            }
            if (fetched.security) {
                entry.security = {
                    value: fetched.security.value,
                    at,
                    exp: at + ttlSecondsFor(Boolean(fetched.security.value), fetched.security.ok) * 1_000,
                };
            } else if (prior?.security) {
                entry.security = prior.security;
            }
            byMint.set(fetched.mint, toFacts(entry));
            writeCache(deps, fetched.mint, entry);
        };

        const perCallDeadlineMs = Math.min(Math.max(deadlineMs, 2_000), 10_000);
        const sweep = Effect.forEach(
            misses,
            need =>
                fetchOne(need, perCallDeadlineMs).pipe(Effect.tap(f => Effect.sync(() => completed.set(f.mint, f)))),
            { concurrency: PROVIDER_CONCURRENCY },
        );
        const fiber = yield* Effect.forkDetach(sweep);
        const raced = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(Duration.millis(deadlineMs)));

        for (const fetched of completed.values()) absorb(fetched);

        if (Option.isSome(raced)) {
            const failed = raced.value.filter(f => !fetchedOk(f)).map(f => f.mint);
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

        // Deadline passed: the finished ones are already in; warm the rest after the response.
        const pending = misses.map(m => m.mint).filter(mint => !absorbed.has(mint));
        deps.scheduleAfterResponse(
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
            landed: misses.length - pending.length,
            deadline_ms: deadlineMs,
        });
        return { byMint, outcome: 'degraded' as const, pending, liveLookups: misses.length };
    });
}

/** Test helper — clear the per-process tier. */
export function __resetLiveEnrichmentForTesting(): void {
    processCache.clear();
}
