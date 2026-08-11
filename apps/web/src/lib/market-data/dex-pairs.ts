import 'server-only';

import { withKeyedTtl } from './cache';
import { CHAINS, sanitizeLiquidity, type ChainId } from './chains';
import { fetchGeckoTerminalJson } from './geckoterminal';
import { numberOrNull, stringOrNull } from './types';

/**
 * Pool-level market data — one row per trading pair on one DEX, the unit a
 * pair explorer works in.
 *
 * This is deliberately separate from `token-liquidity.ts`, which aggregates
 * every pool a token appears in. A token's total depth answers "how much can I
 * trade"; a pair answers "where, on which venue, at what price", and those are
 * different tables.
 */

/** Pools per page upstream, fixed by the API. */
const POOLS_PER_PAGE = 20;

/** Highest page the pools endpoint serves. */
const MAX_PAGE = 10;

/**
 * How long a chain's pair list is reused. GeckoTerminal serializes callers ~1.5s
 * apart, so a five-page sweep costs ~8s; anything shorter than this would spend
 * most of its life refetching.
 */
const PAIRS_TTL_MS = 60_000;

export interface DexPairToken {
    address: string;
    symbol: string;
    name: string;
    imageUrl: string | null;
}

export interface DexPairWindow {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
}

export interface DexPair {
    chain: ChainId;
    /** Pool address — unique per chain, and what an explorer link points at. */
    address: string;
    /** Pool label as reported upstream, e.g. `HOOD / SOL`. */
    name: string;
    dex: string | null;
    base: DexPairToken;
    quote: DexPairToken;
    priceUsd: number | null;
    priceChange: DexPairWindow;
    volume: DexPairWindow;
    liquidityUsd: number | null;
    fdvUsd: number | null;
    buys24h: number | null;
    sells24h: number | null;
    /** Pool creation time in epoch ms, or null when upstream omits it. */
    createdAt: number | null;
}

function parseWindow(raw: unknown): DexPairWindow {
    const source = (raw ?? {}) as Record<string, unknown>;
    const read = (key: string): number | null => {
        const value = source[key];
        const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
        return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
    };
    return { m5: read('m5'), h1: read('h1'), h6: read('h6'), h24: read('h24') };
}

function parseTimestamp(raw: unknown): number | null {
    const text = stringOrNull(raw);
    if (!text) return null;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Tokens and DEXes arrive in the response's `included` array rather than inline
 * on each pool, keyed by the ids the relationships point at.
 */
function indexIncluded(payload: unknown): Map<string, Record<string, unknown>> {
    const included = (payload as { included?: unknown })?.included;
    const byId = new Map<string, Record<string, unknown>>();
    if (!Array.isArray(included)) return byId;

    for (const entry of included) {
        if (typeof entry !== 'object' || entry === null) continue;
        const id = stringOrNull((entry as { id?: unknown }).id);
        const attributes = (entry as { attributes?: Record<string, unknown> }).attributes;
        if (!id || !attributes) continue;
        byId.set(id, attributes);
    }
    return byId;
}

function resolveToken(
    relationship: unknown,
    included: Map<string, Record<string, unknown>>,
): DexPairToken {
    const id = stringOrNull((relationship as { data?: { id?: unknown } })?.data?.id) ?? '';
    const attributes = included.get(id);

    return {
        // The relationship id is `<network>_<address>`; the address alone is what
        // links out to an explorer, so it is recovered when the token itself was
        // not included in the response.
        address: stringOrNull(attributes?.address) ?? id.slice(id.indexOf('_') + 1),
        symbol: stringOrNull(attributes?.symbol) ?? '—',
        name: stringOrNull(attributes?.name) ?? '',
        imageUrl: stringOrNull(attributes?.image_url),
    };
}

function toPair(chain: ChainId, raw: unknown, included: Map<string, Record<string, unknown>>): DexPair | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const attributes = (raw as { attributes?: Record<string, unknown> }).attributes;
    if (!attributes) return null;

    const address = stringOrNull(attributes.address);
    if (!address) return null;

    const relationships = (raw as { relationships?: Record<string, unknown> }).relationships ?? {};
    const transactions = (attributes.transactions ?? {}) as Record<string, { buys?: unknown; sells?: unknown }>;
    const h24 = transactions.h24 ?? {};

    return {
        chain,
        address,
        name: stringOrNull(attributes.name) ?? 'Unknown pool',
        dex: stringOrNull((relationships.dex as { data?: { id?: unknown } })?.data?.id),
        base: resolveToken(relationships.base_token, included),
        quote: resolveToken(relationships.quote_token, included),
        priceUsd: numberOrNull(Number(attributes.base_token_price_usd ?? Number.NaN)),
        priceChange: parseWindow(attributes.price_change_percentage),
        volume: parseWindow(attributes.volume_usd),
        liquidityUsd: sanitizeLiquidity(attributes.reserve_in_usd),
        fdvUsd: numberOrNull(Number(attributes.fdv_usd ?? Number.NaN)),
        buys24h: numberOrNull(h24.buys),
        sells24h: numberOrNull(h24.sells),
        createdAt: parseTimestamp(attributes.pool_created_at),
    };
}

async function loadPage(chain: ChainId, page: number): Promise<DexPair[]> {
    const network = CHAINS[chain].geckoterminalNetwork;
    const payload = await fetchGeckoTerminalJson(
        `/networks/${encodeURIComponent(network)}/pools` +
            `?page=${page}&sort=h24_volume_usd_desc&include=base_token,quote_token,dex`,
    );

    const rows = (payload as { data?: unknown })?.data;
    if (!Array.isArray(rows)) return [];

    const included = indexIncluded(payload);
    const pairs: DexPair[] = [];
    for (const row of rows) {
        const pair = toPair(chain, row, included);
        if (pair) pairs.push(pair);
    }
    return pairs;
}

/**
 * The chain's highest-volume pairs, ordered by 24h volume.
 *
 * Sorting on volume is not cosmetic: the endpoint's default ordering returns
 * trending and freshly created pools, which makes any cross-chain comparison
 * meaningless — the same mistake `fetchNetworkDexSnapshot` documents.
 */
interface LoadedPairs {
    pairs: DexPair[];
    pagesLoaded: number;
    pagesRequested: number;
}

const loadPairsCached = withKeyedTtl(PAIRS_TTL_MS, async (key: string): Promise<LoadedPairs> => {
    const [chain, rawPages] = key.split('|');
    const pagesRequested = Number.parseInt(rawPages, 10);

    // Every page is requested at once even though the transport runs them one
    // at a time. Awaiting page N before asking for N+1 leaves the queue empty
    // between them, and a background sweep call slips into each gap — measured
    // at 44s for a five-page read that takes ~11s when the pages are queued
    // together and drain back to back.
    //
    // `allSettled`, not `all`: the provider rejects individual calls often
    // enough that one refused page used to discard every page that did come
    // back, and the caller then waited out the whole retry budget for nothing.
    const settled = await Promise.allSettled(
        Array.from({ length: pagesRequested }, (_, index) => loadPage(chain as ChainId, index + 1)),
    );

    const pairs: DexPair[] = [];
    let pagesLoaded = 0;
    for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        pagesLoaded += 1;
        pairs.push(...result.value);
        // A short page means upstream ran out of pools; later pages are empty.
        if (result.value.length < POOLS_PER_PAGE) break;
    }

    if (pagesLoaded === 0) {
        const reason = settled.find(result => result.status === 'rejected');
        throw reason?.status === 'rejected' ? reason.reason : new Error('No pages loaded');
    }
    return { pairs, pagesLoaded, pagesRequested };
});

export interface DexPairsResult {
    chain: ChainId;
    pairs: DexPair[];
    /** True when the chain's pools could not be read at all this cycle. */
    degraded: boolean;
    /** Pages that answered, and how many were asked for. */
    pagesLoaded: number;
    pagesRequested: number;
}

/**
 * Pages read per chain by default.
 *
 * Two, because every page is one call against a provider whose keyless tier
 * rejects roughly half of them; five pages measured at over a minute cold. With
 * `COINGECKO_API_KEY` set the tier allows far more and callers can ask for up
 * to `MAX_PAGE`.
 */
const DEFAULT_PAGES = 2;

export async function fetchDexPairs(chain: ChainId, pages = DEFAULT_PAGES): Promise<DexPairsResult> {
    const bounded = Math.max(1, Math.min(MAX_PAGE, Math.floor(pages)));
    try {
        const loaded = await loadPairsCached(`${chain}|${bounded}`);
        return { chain, ...loaded, degraded: false };
    } catch (error) {
        console.warn(
            `[dex-pairs] ${chain} pools unavailable:`,
            error instanceof Error ? error.message : String(error),
        );
        return { chain, pairs: [], degraded: true, pagesLoaded: 0, pagesRequested: bounded };
    }
}
