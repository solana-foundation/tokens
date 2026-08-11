import 'server-only';

import { Effect } from 'effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import type { OHLCVData, TimeInterval } from '@/lib/birdeye';
import { withKeyedTtl } from './cache';
import { numberOrNull } from './types';

/**
 * Price history for the asset chart when the platform API is unavailable.
 *
 * CoinGecko's `market_chart` returns a price series rather than candles, and
 * its native granularity already matches the chart's ranges: 5-minutely for a
 * one-day window, hourly for 2-90 days, daily beyond that. Requesting the
 * window the user picked therefore avoids any resampling on our side.
 */

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

/** CoinGecko only accepts certain day windows before it starts snapping. */
const SUPPORTED_DAY_WINDOWS = [1, 7, 14, 30, 90, 180, 365] as const;

function snapDays(days: number): number {
    for (const window of SUPPORTED_DAY_WINDOWS) {
        if (days <= window) return window;
    }
    return 365;
}

/** Bucket size in seconds for each interval the chart can request. */
const INTERVAL_SECONDS: Record<TimeInterval, number> = {
    '1m': 60,
    '5m': 5 * 60,
    '15m': 15 * 60,
    '1H': 60 * 60,
    '4H': 4 * 60 * 60,
    '1D': 24 * 60 * 60,
    '1W': 7 * 24 * 60 * 60,
};

export interface PricePoint {
    timeSec: number;
    price: number;
}

async function loadSeries(key: string): Promise<PricePoint[]> {
    const [coinId, days] = key.split('|');
    const url =
        `${COINGECKO_BASE_URL}/coins/${encodeURIComponent(coinId)}/market_chart` +
        `?vs_currency=usd&days=${encodeURIComponent(days)}`;

    // The keyless tier 429s readily, and each range switch is a fresh window.
    // fetchJsonWithRetry treats 429 as retryable and backs off, which turns a
    // burst of range clicks from hard failures into slightly slower loads.
    const payload = await Effect.runPromise(
        fetchJsonWithRetry<{ prices?: unknown }>({
            url,
            service: 'coingecko',
            init: { headers: { accept: 'application/json' }, cache: 'no-store' },
            maxRetries: 3,
            baseDelay: '600 millis',
        }),
    );

    if (!Array.isArray(payload.prices)) return [];

    const points: PricePoint[] = [];
    for (const entry of payload.prices) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const timeMs = numberOrNull(entry[0]);
        const price = numberOrNull(entry[1]);
        if (timeMs === null || price === null) continue;
        points.push({ timeSec: Math.floor(timeMs / 1000), price });
    }
    return points.sort((a, b) => a.timeSec - b.timeSec);
}

const loadSeriesCached = withKeyedTtl(60_000, loadSeries);

/**
 * Folds a price series into OHLC buckets.
 *
 * A price series carries no true high/low, so a bucket's extremes are taken
 * from the points that fall inside it. When the upstream granularity is coarser
 * than the requested interval each bucket holds a single point and the candle
 * degenerates to a flat one — correct for a line chart, and honest in that it
 * never invents a wick that was not observed.
 */
export function toCandles(points: readonly PricePoint[], interval: TimeInterval): OHLCVData[] {
    const bucketSecs = INTERVAL_SECONDS[interval];
    const candles: OHLCVData[] = [];

    let current: OHLCVData | null = null;
    let currentBucket = Number.NaN;

    for (const point of points) {
        const bucket = Math.floor(point.timeSec / bucketSecs) * bucketSecs;
        if (current === null || bucket !== currentBucket) {
            if (current) candles.push(current);
            currentBucket = bucket;
            current = {
                time: bucket,
                open: point.price,
                high: point.price,
                low: point.price,
                close: point.price,
                volume: 0,
            };
            continue;
        }
        current.high = Math.max(current.high, point.price);
        current.low = Math.min(current.low, point.price);
        current.close = point.price;
    }
    if (current) candles.push(current);

    return candles;
}

export interface PriceHistoryRequest {
    coinId: string;
    interval: TimeInterval;
    /** Window length in days; snapped to the nearest window CoinGecko serves. */
    days: number;
}

export async function fetchPriceHistory(request: PriceHistoryRequest): Promise<OHLCVData[]> {
    const days = snapDays(Math.max(1, Math.round(request.days)));
    const points = await loadSeriesCached(`${request.coinId}|${days}`);
    if (points.length === 0) return [];

    // A snapped window can be wider than what was asked for (a 60-day request
    // fetches 90); trim so the chart's axis matches the selected range.
    const cutoff = Math.floor(Date.now() / 1000) - request.days * 24 * 60 * 60;
    const inRange = points.filter(point => point.timeSec >= cutoff);

    return toCandles(inRange.length > 1 ? inRange : points, request.interval);
}
