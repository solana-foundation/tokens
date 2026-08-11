import 'server-only';

import { COINGECKO_BASE_URL } from './coingecko-index';
import { numberOrNull, stringOrNull } from './types';

/**
 * CoinGecko's `/coins/markets` endpoint: price, cap, 24h volume and 24h change
 * for up to 250 ids per call.
 *
 * `sparkline=true` rides along on the same request and returns a week of hourly
 * closes per coin. That matters a lot here: the homepage draws an inline chart
 * on every row, and resolving those one coin at a time through `market_chart`
 * is ~30 keyless requests per render, which the rate limiter answers with 429s
 * and multi-second stalls. One batched call feeds every row instead.
 */

export interface Quote {
    price: number | null;
    changePercent: number | null;
    volume24h: number | null;
    marketCap: number | null;
}

export interface Sparkline {
    /** Hourly closes, oldest first. */
    prices: number[];
    /** When the batch was read — the series has no timestamps of its own. */
    fetchedAtSec: number;
}

/**
 * Sparklines from the most recent batch, keyed by CoinGecko id.
 *
 * Kept module-level rather than returned to the caller because the consumers
 * are different: the curated tables want the quotes, while the per-asset OHLCV
 * route wants the series for one coin and has no idea which batch carried it.
 */
const sparklines = new Map<string, Sparkline>();

/** Sparklines older than this are treated as absent — a stale chart is worse
 *  than none, and the per-coin `market_chart` path can still answer. */
const SPARKLINE_MAX_AGE_SEC = 15 * 60;

export function getSparkline(coinId: string): Sparkline | null {
    const hit = sparklines.get(coinId);
    if (!hit) return null;
    if (Math.floor(Date.now() / 1000) - hit.fetchedAtSec > SPARKLINE_MAX_AGE_SEC) return null;
    return hit;
}

function readSparkline(row: Record<string, unknown>): number[] | null {
    const container = row.sparkline_in_7d as { price?: unknown } | undefined;
    if (!container || !Array.isArray(container.price)) return null;

    const prices: number[] = [];
    for (const entry of container.price) {
        const price = numberOrNull(entry);
        if (price !== null) prices.push(price);
    }
    return prices.length > 1 ? prices : null;
}

/**
 * Fetches quotes for `ids`, recording each coin's sparkline as a side effect.
 */
export async function fetchCoinGeckoMarkets(ids: readonly string[]): Promise<Map<string, Quote>> {
    const quotes = new Map<string, Quote>();
    if (ids.length === 0) return quotes;

    for (let offset = 0; offset < ids.length; offset += 250) {
        if (offset > 0) await new Promise(resolve => setTimeout(resolve, 1_500));
        const batch = ids.slice(offset, offset + 250);
        const url =
            `${COINGECKO_BASE_URL}/coins/markets?vs_currency=usd&per_page=250&page=1&sparkline=true` +
            `&ids=${encodeURIComponent(batch.join(','))}`;

        const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
            cache: 'no-store',
        });
        if (!res.ok) {
            console.warn(`[coingecko-markets] HTTP ${res.status} for ${batch.length} ids`);
            continue;
        }

        const rows = (await res.json()) as Record<string, unknown>[];
        const fetchedAtSec = Math.floor(Date.now() / 1000);
        for (const row of rows) {
            const id = stringOrNull(row.id);
            if (!id) continue;
            quotes.set(id, {
                price: numberOrNull(row.current_price),
                changePercent: numberOrNull(row.price_change_percentage_24h),
                volume24h: numberOrNull(row.total_volume),
                marketCap: numberOrNull(row.market_cap),
            });

            const prices = readSparkline(row);
            if (prices) sparklines.set(id, { prices, fetchedAtSec });
        }
    }
    return quotes;
}
