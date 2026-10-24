/**
 * Raw-candidate cache for the judged-search family (`/v2/search`,
 * `/v2/resolve`, `/v2/lists/search-tokens`).
 *
 * What is cached is the *raw* candidate set for a normalized query — the
 * output of the live provider search + the token-index search + the registry
 * alias lookup — not the enriched or judged result. Enrichment (market rows,
 * fill quality, tombstones, advisories, curated membership) is cheap, runs in
 * parallel, and keeps editorial state live: a mint that gets a `blocked`
 * advisory is suppressed on the next request, not when the cache expires.
 * The provider search is the slow, budgeted part, so that is what one cache
 * entry saves.
 *
 * The key is policy- and limit-independent (intent + normalized query), so
 * all three routes share one entry per query, and `bonk`, `BONK` and `$bonk`
 * share one too. A mint-address query keeps its case (base58).
 *
 * Tiers, mirroring `effect/stale-response-cache.ts`: a bounded per-process
 * map answers first; Redis is consulted on a process miss and back-fills the
 * process tier; writes go to Redis after the response. Redis being
 * unconfigured or failing degrades to the process tier alone.
 *
 * Kill switch: `TOKENS_JUDGED_CANDIDATE_CACHE=off` makes reads miss and
 * writes no-ops. Window: `TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS` (default 45).
 */

import { Effect } from 'effect';

import { runAfterResponse } from '@/effect/after-response';
import { getRedisClient, type RedisClient } from '@/lib/redis';
import { toApiErrorInfo } from '@tokens/effect';

import type { CandidateSource, QueryInterpretation } from './types';

/** A candidate as found by the sources, before enrichment. Serializable. */
export interface RawCandidate {
    mint: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    price: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    marketCapUsd: number | null;
    priceChange24hPercent: number | null;
    holderCount: number | null;
    tokenMintTime: string | null;
    sources: CandidateSource[];
}

export interface RawSourcesStatus {
    provider: 'ok' | 'degraded' | 'disabled';
    db: 'ok' | 'degraded';
}

export interface RawCandidateSet {
    raws: RawCandidate[];
    sources: RawSourcesStatus;
    /** When the set was produced (ms epoch). */
    cachedAt: number;
}

interface CacheEnvelope {
    v: 1;
    cachedAt: number;
    raws: RawCandidate[];
    sources: RawSourcesStatus;
}

export interface CandidateCacheOptions {
    /** Test injection for the Redis client. Defaults to `getRedisClient()`. */
    getClient?: () => RedisClient;
    /** Where the deferred Redis write runs. Defaults to `runAfterResponse`. */
    scheduleWrite?: (effect: Effect.Effect<void, never>) => void;
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;
}

const KEY_PREFIX = 'judged:raw:v1';
const DEFAULT_WINDOW_SECONDS = 45;
const MAX_WINDOW_SECONDS = 600;
const MAX_PROCESS_ENTRIES = 256;
/** Skip caching payloads larger than this many serialized bytes (40 candidates ≈ 20 KB). */
const MAX_CACHEABLE_CHARS = 200_000;

interface ProcessEntry {
    set: RawCandidateSet;
    expiresAt: number;
}

const processTier = new Map<string, ProcessEntry>();

/**
 * A degraded set (provider late or failed) is held in the process tier only
 * briefly. The instance that produced it rewrites Redis with the complete set
 * once the provider finishes; every *other* instance that back-filled the
 * degraded entry must re-read Redis soon to see that, instead of serving the
 * incomplete set for the whole window.
 */
const DEGRADED_PROCESS_TTL_MS = 5_000;

function processExpiry(set: RawCandidateSet, windowEnd: number, now: number): number {
    return set.sources.provider === 'degraded' ? Math.min(windowEnd, now + DEGRADED_PROCESS_TTL_MS) : windowEnd;
}

export function candidateCacheEnabled(): boolean {
    return process.env.TOKENS_JUDGED_CANDIDATE_CACHE?.trim().toLowerCase() !== 'off';
}

export function candidateCacheWindowSeconds(): number {
    const raw = Number(process.env.TOKENS_JUDGED_CANDIDATE_CACHE_SECONDS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WINDOW_SECONDS;
    return Math.min(Math.floor(raw), MAX_WINDOW_SECONDS);
}

/**
 * The query the sources are asked: trimmed, with a decorative leading `$`
 * removed (`$bonk` and `bonk` are the same question to every source). A mint
 * address is passed through exactly. This is deliberately NOT the pipeline's
 * homoglyph-normalized form: the cache key must describe what the sources
 * were actually asked, so a lookalike spelling never fills the entry a clean
 * spelling later reads.
 */
export function sourceQueryFor(query: string, interpretation: QueryInterpretation): string {
    const trimmed = query.trim();
    if (interpretation.intent === 'mint') return trimmed;
    return trimmed.replace(/^\$+/, '').trim() || trimmed;
}

/**
 * Cache key for a query: intent + the source query, lowercased for
 * ticker/name intents (every source matches case-insensitively) and exact
 * for a mint address.
 */
export function rawCandidateCacheKey(query: string, interpretation: QueryInterpretation): string {
    const source = sourceQueryFor(query, interpretation);
    const keyed = interpretation.intent === 'mint' ? source : source.toLowerCase();
    return `${KEY_PREFIX}:${interpretation.intent}:${keyed}`;
}

function redisOrNull(getClient?: () => RedisClient): RedisClient | null {
    try {
        return (getClient ?? getRedisClient)();
    } catch {
        return null;
    }
}

function isRawCandidate(value: unknown): value is RawCandidate {
    if (!value || typeof value !== 'object') return false;
    const raw = value as Partial<RawCandidate>;
    return typeof raw.mint === 'string' && Array.isArray(raw.sources);
}

function parseEnvelope(raw: unknown): CacheEnvelope | null {
    try {
        // Upstash's REST client auto-deserializes JSON values; Memorystore
        // returns the raw string. Handle both.
        const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object') return null;
        const envelope = value as Partial<CacheEnvelope>;
        if (envelope.v !== 1) return null;
        if (typeof envelope.cachedAt !== 'number' || !Number.isFinite(envelope.cachedAt)) return null;
        if (!Array.isArray(envelope.raws) || !envelope.raws.every(isRawCandidate)) return null;
        if (!envelope.sources || typeof envelope.sources !== 'object') return null;
        return envelope as CacheEnvelope;
    } catch {
        return null;
    }
}

function rememberInProcess(key: string, set: RawCandidateSet, expiresAt: number, now: number): void {
    processTier.delete(key);
    if (processTier.size >= MAX_PROCESS_ENTRIES) {
        for (const [existingKey, existing] of processTier) {
            if (now > existing.expiresAt) processTier.delete(existingKey);
        }
        if (processTier.size >= MAX_PROCESS_ENTRIES) {
            // Map order is insertion order, so the first key is the oldest.
            const oldest = processTier.keys().next().value;
            if (oldest !== undefined) processTier.delete(oldest);
        }
    }
    processTier.set(key, { set, expiresAt });
}

function readProcess(key: string, now: number): RawCandidateSet | null {
    const entry = processTier.get(key);
    if (!entry) return null;
    if (now > entry.expiresAt) {
        processTier.delete(key);
        return null;
    }
    return entry.set;
}

async function readRedis(key: string, getClient?: () => RedisClient): Promise<CacheEnvelope | null> {
    const redis = redisOrNull(getClient);
    if (!redis) return null;
    const raw = await redis.get<unknown>(key);
    if (raw === null || raw === undefined) return null;
    return parseEnvelope(raw);
}

/**
 * Read a cached raw set, process tier first, then Redis. A Redis hit that is
 * still inside the window back-fills the process tier with the *original*
 * `cachedAt`, so the window never restarts on a back-fill. Any Redis failure
 * is a miss.
 */
export function readRawCandidates(
    key: string,
    options: CandidateCacheOptions = {},
): Effect.Effect<RawCandidateSet | null, never> {
    if (!candidateCacheEnabled()) return Effect.succeed(null);
    const clock = options.now ?? Date.now;
    const windowMs = candidateCacheWindowSeconds() * 1_000;

    return Effect.suspend(() => {
        const now = clock();
        const local = readProcess(key, now);
        if (local) return Effect.succeed(local);

        return Effect.tryPromise(() => readRedis(key, options.getClient)).pipe(
            Effect.catch(() => Effect.succeed(null)),
            Effect.map(envelope => {
                if (!envelope) return null;
                const readAt = clock();
                if (readAt - envelope.cachedAt > windowMs) return null;
                const set: RawCandidateSet = {
                    raws: envelope.raws,
                    sources: envelope.sources,
                    cachedAt: envelope.cachedAt,
                };
                rememberInProcess(key, set, processExpiry(set, envelope.cachedAt + windowMs, readAt), readAt);
                return set;
            }),
        );
    });
}

/**
 * Store a raw set: synchronously in the process tier, deferred to Redis.
 * Safe to call off the request path (the provider-deadline warm-up uses it).
 */
export function storeRawCandidates(
    key: string,
    set: Omit<RawCandidateSet, 'cachedAt'> & { cachedAt?: number },
    options: CandidateCacheOptions = {},
): void {
    if (!candidateCacheEnabled()) return;
    const clock = options.now ?? Date.now;
    const now = clock();
    const cachedAt = set.cachedAt ?? now;
    const windowSeconds = candidateCacheWindowSeconds();
    const stored: RawCandidateSet = { raws: set.raws, sources: set.sources, cachedAt };
    rememberInProcess(key, stored, processExpiry(stored, cachedAt + windowSeconds * 1_000, now), now);

    const redis = redisOrNull(options.getClient);
    if (!redis) return;
    const envelope: CacheEnvelope = { v: 1, cachedAt, raws: stored.raws, sources: stored.sources };
    const body = JSON.stringify(envelope);
    if (body.length > MAX_CACHEABLE_CHARS) return;

    const schedule = options.scheduleWrite ?? runAfterResponse;
    schedule(
        Effect.tryPromise(async () => {
            await redis.set(key, body, { ex: windowSeconds });
        }).pipe(
            Effect.catch(error => {
                console.error(
                    JSON.stringify({
                        event: 'judged_candidate_cache_write_failed',
                        key,
                        error: toApiErrorInfo(error),
                    }),
                );
                return Effect.void;
            }),
        ),
    );
}

/** Test helper — clear the per-process tier. */
export function __resetCandidateCacheForTesting(): void {
    processTier.clear();
}

/** Test helper — number of entries in the per-process tier. */
export function __candidateCacheProcessSizeForTesting(): number {
    return processTier.size;
}
