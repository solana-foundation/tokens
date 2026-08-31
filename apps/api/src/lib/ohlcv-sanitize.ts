/**
 * On-chain per-mint OHLCV candles are aggregated from raw swaps across ALL
 * pools (the `tokens_ohlcv` ClickHouse preset does a plain max/min over trade
 * prices). Dust trades in illiquid pools produce absurd wicks — e.g. WSOL
 * candles with high=1,296,359 and low=0.001 while closes sit at ~$75 — which
 * blow out chart y-axis autoscaling so the price line renders as a flat zero.
 *
 * This module sanitizes wicks at read time: a candle's high/low must stay
 * within WICK_TOLERANCE of a robust local reference price (median of the
 * candle's own open/close and the neighboring closes). Wicks outside the band
 * carry no trustworthy information about the true extreme, so they are
 * snapped back to the candle body rather than clamped to the band edge
 * (clamping would draw an artificial plateau of same-height wicks).
 *
 * Open/close are intentionally left untouched: they are occasionally poisoned
 * too, but they are bounded by the same last-trade data every consumer already
 * displays, and rewriting them would silently alter the series charts draw.
 */

interface OhlcvCandleLike {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Max allowed ratio between a wick and the local reference price.
 * Observed dust-pool poison starts around 1.5x–2x (e.g. low=45.45 — a 500/11
 * dust reciprocal — or high=153.84 on a $75 candle) and runs to 17,000x. A
 * genuine wick 50% beyond the candle's own body AND both neighboring closes
 * within one bucket is vanishingly rare — and during real violent moves the
 * neighbor closes move with it, shifting the reference. When such a wick does
 * occur, it is snapped to the body: a small visual clip, never data loss for
 * close-based (line) charts.
 */
export const WICK_TOLERANCE = 1.5;

function isValidPrice(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Median of a non-empty list (average of the two middle values when even). */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const upper = sorted[mid] as number;
    if (sorted.length % 2 === 1) return upper;
    return ((sorted[mid - 1] as number) + upper) / 2;
}

/**
 * Snap implausible high/low wicks back to the candle body. Pure; returns a
 * new array, reusing untouched candle objects. Order of `candles` is
 * expected to be time-ascending (neighbor closes are used as references),
 * but the function degrades gracefully if it is not.
 */
export function sanitizeOhlcvWicks<T extends OhlcvCandleLike>(candles: readonly T[]): T[] {
    return candles.map((candle, i) => {
        const refs: number[] = [];
        if (isValidPrice(candle.open)) refs.push(candle.open);
        if (isValidPrice(candle.close)) refs.push(candle.close);
        const prevClose = candles[i - 1]?.close;
        if (isValidPrice(prevClose)) refs.push(prevClose);
        const nextClose = candles[i + 1]?.close;
        if (isValidPrice(nextClose)) refs.push(nextClose);
        if (refs.length === 0) return candle;

        const ref = median(refs);
        const maxHigh = ref * WICK_TOLERANCE;
        const minLow = ref / WICK_TOLERANCE;

        // Open/close are only trusted here if they pass the same validity check
        // used for the reference prices. A poisoned open of 0 would otherwise
        // become the snapped low and reintroduce the flat-zero y-axis this
        // module exists to prevent, and a NaN would spread to both wicks.
        // When neither is usable the body collapses to the reference price.
        const bodyPrices = [candle.open, candle.close].filter(isValidPrice);
        const bodyHigh = bodyPrices.length > 0 ? Math.max(...bodyPrices) : ref;
        const bodyLow = bodyPrices.length > 0 ? Math.min(...bodyPrices) : ref;

        // Snap untrusted wicks to the body; always re-establish the OHLC
        // invariant (high >= body >= low) in case stored data violates it.
        const high = Math.max(isValidPrice(candle.high) && candle.high <= maxHigh ? candle.high : bodyHigh, bodyHigh);
        const low = Math.min(isValidPrice(candle.low) && candle.low >= minLow ? candle.low : bodyLow, bodyLow);

        if (high === candle.high && low === candle.low) return candle;
        return { ...candle, high, low };
    });
}
