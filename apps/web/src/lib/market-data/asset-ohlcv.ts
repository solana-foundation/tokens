import 'server-only';

import { getAsset } from '@tokens/asset-registry';
import type { OHLCVData, TimeInterval } from '@/lib/birdeye';
import { loadCoinGeckoIndex, resolveCoinGeckoId } from './coingecko-index';
import { getSparkline, type Sparkline } from './coingecko-markets';
import { loadCoinGeckoQuotes } from './curated-fallback';
import { fetchPriceHistory, toCandles, type PricePoint } from './price-history';

/**
 * Candle lookup for the asset routes when the platform API is unavailable.
 *
 * Both `/api/v1/assets/[assetId]` (`?include=ohlcv`, used by the inline
 * sparklines) and `/api/v1/assets/[assetId]/price-chart` (used by the full
 * chart) need the same three steps — parse the window, resolve the asset onto a
 * CoinGecko id, fold the price series into candles — so they share them here.
 */

const VALID_INTERVALS: readonly TimeInterval[] = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];

export function parseInterval(raw: string | null): TimeInterval {
    return VALID_INTERVALS.includes(raw as TimeInterval) ? (raw as TimeInterval) : '1H';
}

export function parseEpochSeconds(raw: string | null): number | null {
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

/** The charts send an epoch-second window; CoinGecko wants a day count. */
export function daysFromWindow(fromSec: number | null, toSec: number | null): number {
    if (fromSec === null || toSec === null || toSec <= fromSec) return 7;
    return Math.max(1, Math.ceil((toSec - fromSec) / (24 * 60 * 60)));
}

/**
 * Categories whose tickers collide with unrelated coins on CoinGecko. Copper's
 * `COPPER` symbol resolves to a meme token quoted at $7.08e-6, and the bond
 * ETFs match by name onto $0.33 coins. For these an explicit `coingeckoId` is
 * honoured, but nothing is guessed from the symbol or name.
 */
const COLLISION_PRONE_CATEGORIES = new Set(['commodity', 'equity', 'etf', 'index']);

export async function resolveAssetCoinId(assetId: string): Promise<string | null> {
    const asset = getAsset(assetId) as
        | { assetId?: string; symbol?: string; aliases?: string[]; coingeckoId?: string; category?: string }
        | undefined;

    const index = await loadCoinGeckoIndex();
    const explicitId = asset?.coingeckoId ?? null;
    if (asset?.category && COLLISION_PRONE_CATEGORIES.has(asset.category)) {
        return explicitId && index.ids.has(explicitId) ? explicitId : null;
    }

    return resolveCoinGeckoId(
        {
            assetId: asset?.assetId ?? assetId,
            symbol: asset?.symbol ?? '',
            aliases: asset?.aliases ?? [],
            coingeckoId: explicitId,
        },
        index,
    );
}

export interface AssetCandlesRequest {
    assetId: string;
    interval: TimeInterval;
    days: number;
}

export interface AssetCandlesResult {
    candles: OHLCVData[];
    /** `unavailable` when the asset has no CoinGecko counterpart (most equities). */
    source: 'coingecko' | 'unavailable';
    coinId: string | null;
}

/** A sparkline covers a week of hourly closes; anything longer needs its own fetch. */
const SPARKLINE_MAX_DAYS = 7;
const SPARKLINE_STEP_SEC = 60 * 60;

/**
 * Stamps the batched sparkline with timestamps.
 *
 * CoinGecko sends the series without any, documented only as the last seven
 * days of hourly closes, so the last point is aligned to the hour the batch was
 * read and the rest are counted back from it.
 */
function toPricePoints(sparkline: Sparkline): PricePoint[] {
    const end = Math.floor(sparkline.fetchedAtSec / SPARKLINE_STEP_SEC) * SPARKLINE_STEP_SEC;
    const lastIndex = sparkline.prices.length - 1;
    return sparkline.prices.map((price, index) => ({
        timeSec: end - (lastIndex - index) * SPARKLINE_STEP_SEC,
        price,
    }));
}

export async function fetchAssetCandles(request: AssetCandlesRequest): Promise<AssetCandlesResult> {
    const coinId = await resolveAssetCoinId(request.assetId);
    if (!coinId) return { candles: [], source: 'unavailable', coinId: null };

    // The homepage asks for one of these per visible row. Serving them from the
    // batch the curated tables already fetched keeps that at a single upstream
    // call; `market_chart` per coin would be one keyless request per row.
    if (request.days <= SPARKLINE_MAX_DAYS) {
        const sparkline = (await loadSparkline(coinId)) ?? null;
        if (sparkline) {
            const cutoff = Math.floor(Date.now() / 1000) - request.days * 24 * 60 * 60;
            const points = toPricePoints(sparkline).filter(point => point.timeSec >= cutoff);
            if (points.length > 1) {
                return { candles: toCandles(points, request.interval), source: 'coingecko', coinId };
            }
        }
    }

    const candles = await fetchPriceHistory({ coinId, interval: request.interval, days: request.days });
    return { candles, source: 'coingecko', coinId };
}

/**
 * Reads `coinId`'s sparkline, warming the curated batch first if nothing has
 * fetched it yet this minute. The warm-up is bounded: a failure there just
 * falls through to the per-coin history below.
 */
async function loadSparkline(coinId: string): Promise<Sparkline | null> {
    const cached = getSparkline(coinId);
    if (cached) return cached;

    try {
        await loadCoinGeckoQuotes();
    } catch (error) {
        console.warn('[asset-ohlcv] curated market batch unavailable:', error);
        return null;
    }
    return getSparkline(coinId);
}
