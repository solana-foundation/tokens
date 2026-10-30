import {
    type PythFeedMode,
    isSupportedPythTicker,
    normalizePythTicker,
} from '@/lib/realtime-prices/pyth-feed-selection';

/** Pure helpers shared by the batch feed route, the browser resolver and the table hook. */

export const PYTH_FEED_BATCH_MAX_ITEMS = 200;

export interface PythFeedRequestItem {
    ticker: string;
    category: string | null;
    mode: PythFeedMode;
}

/** Cache / response key for one resolution: `${mode}:${category}:${TICKER}`. */
export function pythFeedResolutionKey(item: PythFeedRequestItem): string {
    return `${item.mode}:${(item.category ?? '').trim().toLowerCase()}:${normalizePythTicker(item.ticker)}`;
}

export function normalizePythFeedRequestItem(raw: {
    symbol?: unknown;
    category?: unknown;
    mode?: unknown;
}): PythFeedRequestItem | null {
    const ticker = normalizePythTicker(typeof raw.symbol === 'string' ? raw.symbol : '');
    if (!ticker || !isSupportedPythTicker(ticker)) return null;
    const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() || null : null;
    const mode: PythFeedMode = raw.mode === 'variant' ? 'variant' : 'canonical';
    return { ticker, category, mode };
}

/** Parse a batch request body; drops malformed items, dedupes by key, caps the batch size. */
export function parsePythFeedBatchBody(body: unknown): PythFeedRequestItem[] {
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    const out: PythFeedRequestItem[] = [];
    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = normalizePythFeedRequestItem(raw as Record<string, unknown>);
        if (!item) continue;
        const key = pythFeedResolutionKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= PYTH_FEED_BATCH_MAX_ITEMS) break;
    }
    return out;
}

/**
 * Key under which a row's live price is stored. Mirrors the asset page chart
 * (`coingeckoId`, else `assetId`) so a table row and the page it opens share one
 * live value; rows with neither fall back to their address.
 */
export function buildLiveQuoteKey(token: {
    coingeckoId?: string | null;
    assetId?: string | null;
    address?: string | null;
}): string {
    return (token.coingeckoId ?? '').trim() || (token.assetId ?? '').trim() || (token.address ?? '').trim();
}
