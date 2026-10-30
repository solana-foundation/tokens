import 'server-only';

import {
    type PythFeedMode,
    type PythFeedSelection,
    type PythSymbolEntry,
    buildPythSymbolCandidates,
    isSupportedPythTicker,
    normalizePythTicker,
    selectPythFeed,
} from '@/lib/realtime-prices/pyth-feed-selection';
import { PYTH_PRO_CHANNEL, pythPriceToNumber } from '@/lib/realtime-prices/pyth-pro-protocol';

/**
 * Server-side Pyth Pro access. The long-lived API key never leaves this module:
 * browsers get a short-lived JWT minted here (see /api/realtime/pyth-token),
 * and feed resolution + OG-image prices run on the server.
 *
 * Docs: https://docs.pyth.network/pro/frontend-auth, /pro/price-feed-ids, /pro/api/rest
 */

const PYTH_AUTH_ORIGIN = 'https://pyth.dourolabs.app';
const PYTH_REST_ORIGIN = 'https://pyth-lazer.dourolabs.app';

const FEED_HIT_TTL_MS = 6 * 60 * 60 * 1000;
const FEED_MISS_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 6_000;

export function readPythApiKey(): string | null {
    const key = process.env.PYTH_API_KEY?.trim();
    return key ? key : null;
}

export function isPythConfigured(): boolean {
    return readPythApiKey() != null;
}

function authHeaders(key: string): HeadersInit {
    return { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

export interface PythAccessToken {
    accessToken: string;
    /** RFC 3339 expiry as returned by Pyth. */
    expiresAt: string;
}

/**
 * Mint a short-lived browser token. Pyth caps the TTL server-side (15 minutes at
 * the time of writing); omitting `ttl_seconds` asks for that maximum.
 */
export async function mintPythAccessToken(): Promise<PythAccessToken | null> {
    const key = readPythApiKey();
    if (!key) return null;
    try {
        const res = await fetch(`${PYTH_AUTH_ORIGIN}/auth/token`, {
            method: 'POST',
            headers: authHeaders(key),
            body: '{}',
            cache: 'no-store',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error('[pyth] token mint failed', res.status);
            return null;
        }
        const json = (await res.json()) as { access_token?: unknown; expires_at?: unknown };
        if (typeof json.access_token !== 'string' || typeof json.expires_at !== 'string') return null;
        return { accessToken: json.access_token, expiresAt: json.expires_at };
    } catch (error) {
        console.error('[pyth] token mint error', error);
        return null;
    }
}

export interface ResolvedPythFeed extends PythFeedSelection {
    /** Whether our API key's plan may subscribe to this feed. */
    entitled: boolean;
}

export type PythFeedResolution =
    | { status: 'ok'; feed: ResolvedPythFeed }
    | { status: 'not_entitled'; feed: ResolvedPythFeed }
    | { status: 'not_found'; candidates: string[] }
    | { status: 'unconfigured' };

interface FeedCacheEntry {
    value: PythFeedResolution;
    expiresAtMs: number;
}

const feedCache = new Map<string, FeedCacheEntry>();
const inFlight = new Map<string, Promise<PythFeedResolution>>();

async function searchPythSymbols(query: string, entitledOnly: boolean): Promise<PythSymbolEntry[] | null> {
    const params = new URLSearchParams({ query });
    if (entitledOnly) params.set('entitled_only', 'true');
    const key = readPythApiKey();
    try {
        const res = await fetch(`${PYTH_AUTH_ORIGIN}/v1/symbols?${params.toString()}`, {
            method: 'GET',
            headers: key ? { Authorization: `Bearer ${key}` } : undefined,
            cache: 'no-store',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as unknown;
        return Array.isArray(json) ? (json as PythSymbolEntry[]) : null;
    } catch {
        return null;
    }
}

/**
 * Resolve an asset ticker to a Pyth feed. Two cheap symbol searches: the full
 * directory tells us whether a feed exists, the entitled-only view tells us
 * whether this plan can stream it. Results are cached per (mode, category, ticker).
 */
export async function resolvePythFeed(args: {
    ticker: string;
    category?: string | null;
    mode: PythFeedMode;
}): Promise<PythFeedResolution> {
    const tickerUpper = normalizePythTicker(args.ticker);
    if (!tickerUpper || !isSupportedPythTicker(tickerUpper)) return { status: 'not_found', candidates: [] };
    if (!isPythConfigured()) return { status: 'unconfigured' };

    const category = (args.category ?? '').trim().toLowerCase();
    const cacheKey = `${args.mode}:${category}:${tickerUpper}`;
    const now = Date.now();
    const cached = feedCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) return cached.value;

    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const promise = (async (): Promise<PythFeedResolution> => {
        try {
            const [all, entitled] = await Promise.all([
                searchPythSymbols(tickerUpper, false),
                searchPythSymbols(tickerUpper, true),
            ]);
            const selection = all ? selectPythFeed({ ticker: tickerUpper, category, mode: args.mode }, all) : null;
            let value: PythFeedResolution;
            if (!selection) {
                value = {
                    status: 'not_found',
                    candidates: buildPythSymbolCandidates(tickerUpper, category, args.mode),
                };
            } else {
                const isEntitled = (entitled ?? []).some(entry => entry?.pyth_lazer_id === selection.feedId);
                const feed: ResolvedPythFeed = { ...selection, entitled: isEntitled };
                value = isEntitled ? { status: 'ok', feed } : { status: 'not_entitled', feed };
            }
            // Only cache answers we actually got from upstream; a failed search should retry soon.
            if (all) {
                feedCache.set(cacheKey, {
                    value,
                    expiresAtMs: Date.now() + (value.status === 'ok' ? FEED_HIT_TTL_MS : FEED_MISS_TTL_MS),
                });
            }
            return value;
        } finally {
            inFlight.delete(cacheKey);
        }
    })();

    inFlight.set(cacheKey, promise);
    return promise;
}

// ---------------------------------------------------------------------------
// Batch resolution against the entitled directory (home tables).
// ---------------------------------------------------------------------------

const ENTITLED_DIRECTORY_TTL_MS = 60 * 60 * 1000;
const ENTITLED_DIRECTORY_MISS_TTL_MS = 60 * 1000;
let entitledDirectory: { entries: PythSymbolEntry[]; expiresAtMs: number } | null = null;
let entitledDirectoryInFlight: Promise<PythSymbolEntry[] | null> | null = null;

/**
 * The feeds our key may subscribe to (~500 entries, ~430 KB) — enough to resolve a
 * whole table in one pass without a per-symbol search. Cached per instance for an hour.
 */
export async function loadEntitledPythDirectory(): Promise<PythSymbolEntry[] | null> {
    const key = readPythApiKey();
    if (!key) return null;
    const now = Date.now();
    if (entitledDirectory && entitledDirectory.expiresAtMs > now) return entitledDirectory.entries;
    if (entitledDirectoryInFlight) return entitledDirectoryInFlight;

    entitledDirectoryInFlight = (async () => {
        try {
            const res = await fetch(`${PYTH_AUTH_ORIGIN}/v1/symbols?entitled_only=true`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${key}` },
                cache: 'no-store',
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS * 2),
            });
            if (!res.ok) throw new Error(`symbols ${res.status}`);
            const json = (await res.json()) as unknown;
            if (!Array.isArray(json)) throw new Error('symbols: not an array');
            entitledDirectory = {
                entries: json as PythSymbolEntry[],
                expiresAtMs: Date.now() + ENTITLED_DIRECTORY_TTL_MS,
            };
            return entitledDirectory.entries;
        } catch (error) {
            console.error('[pyth] entitled directory load failed', error);
            // Keep serving a stale copy if we have one; otherwise back off briefly.
            if (entitledDirectory) {
                entitledDirectory.expiresAtMs = Date.now() + ENTITLED_DIRECTORY_MISS_TTL_MS;
                return entitledDirectory.entries;
            }
            return null;
        } finally {
            entitledDirectoryInFlight = null;
        }
    })();
    return entitledDirectoryInFlight;
}

/** Resolve many tickers at once against the entitled directory. `null` = no feed this plan can stream. */
export async function resolveEntitledPythFeeds(
    items: readonly { ticker: string; category: string | null; mode: PythFeedMode }[],
): Promise<Map<string, PythFeedSelection | null> | null> {
    const entries = await loadEntitledPythDirectory();
    if (!entries) return null;
    const out = new Map<string, PythFeedSelection | null>();
    for (const item of items) {
        const key = `${item.mode}:${(item.category ?? '').trim().toLowerCase()}:${normalizePythTicker(item.ticker)}`;
        out.set(key, selectPythFeed({ ticker: item.ticker, category: item.category, mode: item.mode }, entries));
    }
    return out;
}

export interface PythLatestPrice {
    feedId: number;
    symbol: string;
    priceUsd: number;
    publishTimeMs: number | null;
}

/** One-shot price for server renders (OG images). Returns null for feeds this plan cannot read. */
export async function fetchPythLatestPrice(args: {
    ticker: string;
    category?: string | null;
    mode: PythFeedMode;
}): Promise<PythLatestPrice | null> {
    const key = readPythApiKey();
    if (!key) return null;
    const resolution = await resolvePythFeed(args);
    if (resolution.status !== 'ok') return null;
    const { feed } = resolution;

    try {
        const res = await fetch(`${PYTH_REST_ORIGIN}/v1/latest_price`, {
            method: 'POST',
            headers: authHeaders(key),
            body: JSON.stringify({
                priceFeedIds: [feed.feedId],
                properties: ['price', 'exponent', 'feedUpdateTimestamp'],
                formats: [],
                channel: PYTH_PRO_CHANNEL,
                parsed: true,
            }),
            cache: 'no-store',
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { parsed?: { timestampUs?: unknown; priceFeeds?: unknown[] } | null };
        const entries = Array.isArray(json?.parsed?.priceFeeds) ? json.parsed!.priceFeeds : [];
        const match = entries.find(
            entry =>
                entry && typeof entry === 'object' && (entry as { priceFeedId?: unknown }).priceFeedId === feed.feedId,
        ) as { price?: unknown; exponent?: unknown; feedUpdateTimestamp?: unknown } | undefined;
        if (!match) return null;
        const priceUsd = pythPriceToNumber(match.price, match.exponent);
        if (priceUsd == null) return null;
        const micros = Number(match.feedUpdateTimestamp ?? json.parsed?.timestampUs);
        return {
            feedId: feed.feedId,
            symbol: feed.symbol,
            priceUsd,
            publishTimeMs: Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) : null,
        };
    } catch {
        return null;
    }
}
