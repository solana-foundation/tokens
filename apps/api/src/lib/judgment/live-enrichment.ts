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
 * per-process tier, writes after the response. Entries carry their own
 * expiry so a process never keeps a short-lived error entry for the hit
 * window. Cache reads for a request run concurrently, each on its own Redis
 * timeout, so the wait is one timeout per request and a slow read costs only
 * its own mint.
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
/** Provider calls in flight at once for one request (two endpoints per mint). */
const PROVIDER_CONCURRENCY = 8;

interface CachedFacts {
    v: 1;
    market?: ProviderMarketOverview | null;
    security?: ProviderSecurity | null;
    at: number;
    /** ms epoch after which the entry must not be served from any tier. */
    exp: number;
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

function rememberInProcess(mint: string, entry: CachedFacts, now: number): void {
    if (entry.exp <= now) return;
    processCache.delete(mint);
    if (processCache.size >= MAX_PROCESS_ENTRIES) {
        const oldest = processCache.keys().next().value;
        if (oldest !== undefined) processCache.delete(oldest);
    }
    processCache.set(mint, { entry, expiresAt: entry.exp });
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

function ttlSecondsFor(entry: Pick<CachedFacts, 'market' | 'security'>, ok: boolean): number {
    if (!ok) return ERROR_TTL_SECONDS;
    // A full miss (provider knows nothing) stays longer than a hit.
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
    if (entry.v !== 1 || typeof entry.at !== 'number' || typeof entry.exp !== 'number') return null;
    const out: CachedFacts = { v: 1, at: entry.at, exp: entry.exp };
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
            if (parsed.exp <= readAt) return null;
            rememberInProcess(mint, parsed, readAt);
            return parsed;
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
    const ttlSeconds = Math.max(1, Math.ceil((entry.exp - now) / 1_000));
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

/**
 * One mint's lookups. `Effect.suspend` matters: the provider clients create
 * their `AbortSignal.timeout` when called, so the clock must start when the
 * fetch actually runs (after it clears the concurrency queue), not when the
 * sweep is assembled.
 */
function fetchOne(need: LiveNeed, perCallDeadlineMs: number): Effect.Effect<Fetched, never> {
    const market = need.market
        ? Effect.suspend(() => fetchProviderMarketOverview(need.mint, { deadlineMs: perCallDeadlineMs })).pipe(
              Effect.map(value => ({ ok: true as const, value })),
              Effect.catch(() => Effect.succeed({ ok: false as const, value: null })),
          )
        : Effect.succeed({ ok: true as const, value: undefined });
    const security = need.security
        ? Effect.suspend(() => fetchProviderSecurity(need.mint, { deadlineMs: perCallDeadlineMs })).pipe(
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
            if (entry) byMint.set(need.mint, { market: entry.market, security: entry.security, at: entry.at });
            if (entry && covers(entry, need)) continue;
            // Partial coverage: keep what we have, fetch only the gap.
            misses.push({
                mint: need.mint,
                market: need.market && entry?.market === undefined,
                security: need.security && entry?.security === undefined,
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
            const prior = byMint.get(fetched.mint);
            const at = now();
            const partial = {
                ...(prior?.market !== undefined ? { market: prior.market } : {}),
                ...(prior?.security !== undefined ? { security: prior.security } : {}),
                ...('market' in fetched ? { market: fetched.market ?? null } : {}),
                ...('security' in fetched ? { security: fetched.security ?? null } : {}),
            };
            const entry: CachedFacts = { v: 1, at, exp: at + ttlSecondsFor(partial, fetched.ok) * 1_000, ...partial };
            byMint.set(fetched.mint, { market: entry.market, security: entry.security, at });
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
