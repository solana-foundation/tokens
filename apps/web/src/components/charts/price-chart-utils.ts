import type { TimeInterval } from '@/lib/birdeye';
import type { PriceCandle } from './price-chart-types';

export const INTERVALS: { label: string; value: TimeInterval }[] = [
    { label: '1H', value: '1H' },
    { label: '4H', value: '4H' },
    { label: '1D', value: '1D' },
    { label: '1W', value: '1W' },
];

export const TIME_RANGES: { label: string; days: number }[] = [
    { label: '24H', days: 1 },
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: '1Y', days: 365 },
];

export const DEFAULT_CHART_COLOR = '#5c5753';

export function normalizeCandles<T extends Partial<PriceCandle>>(raw: readonly T[] | undefined): PriceCandle[] {
    const candles: PriceCandle[] = [];
    for (const d of raw ?? []) {
        if (
            Number.isFinite(d.time) &&
            Number.isFinite(d.open) &&
            Number.isFinite(d.high) &&
            Number.isFinite(d.low) &&
            Number.isFinite(d.close)
        ) {
            candles.push({
                time: d.time as number,
                open: d.open as number,
                high: d.high as number,
                low: d.low as number,
                close: d.close as number,
                volume: d.volume,
            });
        }
    }
    return candles.sort((a, b) => a.time - b.time);
}

export function normalizeQueryError(error: unknown): string | null {
    return error instanceof Error ? error.message : error ? String(error) : null;
}

export function formatUsdPrice(value: number): string {
    const maximumFractionDigits = Math.abs(value) < 1 ? 6 : 2;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits })}`;
}

export function formatEpochSeconds(epochSeconds: number): Date | null {
    if (!Number.isFinite(epochSeconds)) return null;
    return new Date(epochSeconds * 1000);
}

export function findClosestCandleIndex(candles: Array<{ time: number }>, timeSec: number): number | null {
    if (candles.length === 0 || !Number.isFinite(timeSec)) return null;
    let lo = 0;
    let hi = candles.length - 1;

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (candles[mid]!.time < timeSec) lo = mid + 1;
        else hi = mid;
    }

    const afterIdx = lo;
    const beforeIdx = Math.max(0, afterIdx - 1);
    const after = candles[afterIdx]!;
    const before = candles[beforeIdx]!;

    if (beforeIdx === afterIdx) return afterIdx;
    return Math.abs(after.time - timeSec) < Math.abs(timeSec - before.time) ? afterIdx : beforeIdx;
}

export function formatPointDateLabel(epochSeconds: number, rangeDays: number): string {
    const d = formatEpochSeconds(epochSeconds);
    if (!d) return '';
    if (rangeDays <= 1) {
        return d.toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export function formatAxisTimeLabel(epochSeconds: number, rangeDays: number): string {
    const d = formatEpochSeconds(epochSeconds);
    if (!d) return '';
    if (rangeDays <= 1) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (rangeDays >= 365) return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

/**
 * Picks the finest interval that keeps a range under `maxPoints`.
 *
 * The sub-hour candidates matter: starting at `1H` gave the 24H range only 24
 * points, which draws as a coarse polyline rather than an intraday chart. `5m`
 * puts it at 288, which is also exactly what CoinGecko returns natively for a
 * one-day window, so the request maps onto the upstream's own granularity
 * instead of being resampled.
 *
 * Requested interval per range: 24H 5m, 7D 15m, 30D 1H, 90D 4H, 1Y 1D. This is
 * a ceiling, not a guarantee — a source coarser than the request simply yields
 * fewer points (CoinGecko serves 7D hourly, so 7D draws 169 rather than 672).
 */
export function pickIntervalForDays(days: number): TimeInterval {
    const windowSecs = days * 24 * 60 * 60;
    const candidates: Array<{ interval: TimeInterval; secs: number }> = [
        { interval: '5m', secs: 5 * 60 },
        { interval: '15m', secs: 15 * 60 },
        { interval: '1H', secs: 60 * 60 },
        { interval: '4H', secs: 4 * 60 * 60 },
        { interval: '1D', secs: 24 * 60 * 60 },
        { interval: '1W', secs: 7 * 24 * 60 * 60 },
    ];
    const maxPoints = 800;
    for (const c of candidates) {
        if (windowSecs / c.secs <= maxPoints) return c.interval;
    }
    return '1W';
}
