'use client';

import type { PythFeedMode, PythFeedSelection } from '@/lib/realtime-prices/pyth-feed-selection';
import { isSupportedPythTicker, normalizePythTicker } from '@/lib/realtime-prices/pyth-feed-selection';

/** Browser-side resolver for /api/realtime/pyth-feed with a localStorage cache. */

// Bump when selection heuristics or the response shape change so stale cache entries are ignored.
const LOCAL_CACHE_PREFIX = 'TOKENS_PYTH_FEED_V3:';
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;

export type ResolvedPythFeedStatus = 'ok' | 'not_entitled' | 'not_found' | 'unconfigured' | 'error';

export interface ResolvedPythFeedResult {
    status: ResolvedPythFeedStatus;
    feed: (PythFeedSelection & { entitled: boolean }) | null;
}

interface CachedResolution {
    result: ResolvedPythFeedResult;
    expiresAtMs: number;
}

export interface ResolvePythFeedArgs {
    symbol: string;
    category?: string | null;
    mode: PythFeedMode;
}

function cacheKey(args: ResolvePythFeedArgs, tickerUpper: string): string {
    const category = (args.category ?? '').trim().toLowerCase();
    return `${LOCAL_CACHE_PREFIX}${args.mode}:${category}:${tickerUpper}`;
}

function readCache(key: string): ResolvedPythFeedResult | null {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedResolution;
        if (!parsed || typeof parsed.expiresAtMs !== 'number' || parsed.expiresAtMs <= Date.now()) return null;
        return parsed.result ?? null;
    } catch {
        return null;
    }
}

function writeCache(key: string, result: ResolvedPythFeedResult): void {
    try {
        const ttl = result.status === 'ok' ? HIT_TTL_MS : MISS_TTL_MS;
        const entry: CachedResolution = { result, expiresAtMs: Date.now() + ttl };
        window.localStorage.setItem(key, JSON.stringify(entry));
    } catch {
        // Ignore storage failures (private mode, quota, etc.).
    }
}

const inFlight = new Map<string, Promise<ResolvedPythFeedResult>>();

export async function resolvePythFeed(args: ResolvePythFeedArgs): Promise<ResolvedPythFeedResult> {
    if (typeof window === 'undefined') return { status: 'error', feed: null };
    const tickerUpper = normalizePythTicker(args.symbol);
    if (!tickerUpper || !isSupportedPythTicker(tickerUpper)) return { status: 'not_found', feed: null };

    const key = cacheKey(args, tickerUpper);
    const cached = readCache(key);
    if (cached) return cached;

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<ResolvedPythFeedResult> => {
        try {
            const params = new URLSearchParams({ symbol: tickerUpper, mode: args.mode });
            const category = (args.category ?? '').trim().toLowerCase();
            if (category) params.set('category', category);
            const res = await fetch(`/api/realtime/pyth-feed?${params.toString()}`, { method: 'GET' });

            if (res.status === 503) return { status: 'unconfigured', feed: null };
            if (res.status === 404) {
                const result: ResolvedPythFeedResult = { status: 'not_found', feed: null };
                writeCache(key, result);
                return result;
            }
            if (!res.ok) return { status: 'error', feed: null };

            const json = (await res.json()) as { status?: unknown; feed?: unknown };
            const feed = (json.feed ?? null) as ResolvedPythFeedResult['feed'];
            if (!feed || typeof feed.feedId !== 'number') return { status: 'error', feed: null };
            const status: ResolvedPythFeedStatus = json.status === 'ok' ? 'ok' : 'not_entitled';
            const result: ResolvedPythFeedResult = { status, feed };
            writeCache(key, result);
            return result;
        } catch {
            return { status: 'error', feed: null };
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, promise);
    return promise;
}
