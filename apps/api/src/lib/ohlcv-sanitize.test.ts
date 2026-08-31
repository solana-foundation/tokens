import { describe, expect, test } from 'bun:test';

import { WICK_TOLERANCE, sanitizeOhlcvWicks } from './ohlcv-sanitize';

interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

function candle(partial: Partial<Candle> & { time: number }): Candle {
    const close = partial.close ?? 75;
    const open = partial.open ?? close;
    return {
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1_000_000,
        ...partial,
    };
}

describe('sanitizeOhlcvWicks', () => {
    test('returns clean candles unchanged (same object references)', () => {
        const input = [
            candle({ time: 1, open: 75.1, high: 75.4, low: 74.9, close: 75.2 }),
            candle({ time: 2, open: 75.2, high: 76.0, low: 75.0, close: 75.8 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]).toBe(input[0]!);
        expect(out[1]).toBe(input[1]!);
    });

    test('snaps a dust-pool high spike back to the candle body', () => {
        // Real WSOL data: high=1,296,359 on a ~$75 candle.
        const input = [
            candle({ time: 1, close: 74.9 }),
            candle({ time: 2, open: 75.02, high: 1_296_359.43, low: 74.93, close: 75.02 }),
            candle({ time: 3, close: 75.06 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.high).toBe(75.02);
        expect(out[1]!.low).toBe(74.93);
    });

    test('snaps a dust-pool low spike back to the candle body', () => {
        // Real WSOL data: low=0.001 on a ~$78 candle.
        const input = [
            candle({ time: 1, close: 78.66 }),
            candle({ time: 2, open: 78.66, high: 78.9, low: 0.001, close: 77.93 }),
            candle({ time: 3, close: 77.92 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.low).toBe(77.93);
        expect(out[1]!.high).toBe(78.9);
    });

    test('keeps genuine volatile wicks within the tolerance band', () => {
        // A real -20% flash-crash wick and +30% spike survive.
        const input = [
            candle({ time: 1, close: 100 }),
            candle({ time: 2, open: 100, high: 130, low: 80, close: 105 }),
            candle({ time: 3, close: 104 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.high).toBe(130);
        expect(out[1]!.low).toBe(80);
    });

    test('a genuine sustained pump lifts the reference via neighbor closes', () => {
        // Price 3x's across candles; each candle's wick stays near its own
        // body/neighbors, so nothing is clamped.
        const input = [
            candle({ time: 1, open: 100, high: 160, low: 100, close: 150 }),
            candle({ time: 2, open: 150, high: 260, low: 148, close: 240 }),
            candle({ time: 3, open: 240, high: 310, low: 235, close: 300 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out).toEqual(input);
    });

    test('trade-off: far-side wick of an extreme single-candle move is clipped to the body', () => {
        // Candle 1 opens at 100 and closes at 150 with next close 240: the
        // median reference (150) puts the low band at 100, so a genuine
        // low of 98 is snapped to the body low (100) — a ~2% visual clip.
        const input = [
            candle({ time: 1, open: 100, high: 160, low: 98, close: 150 }),
            candle({ time: 2, open: 150, high: 260, low: 148, close: 240 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]!.low).toBe(100);
        expect(out[0]!.high).toBe(160);
    });

    test('does not let a poisoned open drag the high up with it', () => {
        // Real WSOL 4H data: open=139.5 while close and neighbors sit at ~78.
        // The median reference ignores the single bad open, so the poisoned
        // high still gets snapped (to the body, which includes the bad open —
        // open/close are intentionally not rewritten).
        const input = [
            candle({ time: 1, close: 77.75 }),
            candle({ time: 2, open: 139.56, high: 499.99, low: 5.85, close: 78.05 }),
            candle({ time: 3, close: 78.28 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.high).toBe(139.56);
        expect(out[1]!.low).toBe(78.05);
    });

    test('handles first and last candles (missing neighbors)', () => {
        const input = [
            candle({ time: 1, open: 75, high: 75_000, low: 74, close: 75.5 }),
            candle({ time: 2, close: 75.4 }),
            candle({ time: 3, open: 75.4, high: 76, low: 0.02, close: 75.6 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]!.high).toBe(75.5);
        expect(out[2]!.low).toBe(75.4);
    });

    test('boundary: wick exactly at the tolerance edge is kept', () => {
        const ref = 100; // open=close=prev=next=100
        const input = [
            candle({ time: 1, close: 100 }),
            candle({ time: 2, open: 100, high: ref * WICK_TOLERANCE, low: ref / WICK_TOLERANCE, close: 100 }),
            candle({ time: 3, close: 100 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.high).toBe(ref * WICK_TOLERANCE);
        expect(out[1]!.low).toBe(ref / WICK_TOLERANCE);
    });

    test('repairs candles violating the OHLC invariant', () => {
        const input = [candle({ time: 1, open: 75, high: 74, low: 76, close: 75.2 })];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]!.high).toBe(75.2);
        expect(out[0]!.low).toBe(75);
    });

    test('snaps non-finite and non-positive wicks to the body', () => {
        const input = [
            candle({ time: 1, open: 75, high: Number.NaN, low: -5, close: 75.2 }),
            candle({ time: 2, open: 75.2, high: Number.POSITIVE_INFINITY, low: 0, close: 75.1 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]!.high).toBe(75.2);
        expect(out[0]!.low).toBe(75);
        expect(out[1]!.high).toBe(75.2);
        expect(out[1]!.low).toBe(75.1);
    });

    test('candle with no valid reference prices is returned unchanged', () => {
        const input = [candle({ time: 1, open: 0, high: 0, low: 0, close: 0 })];
        const out = sanitizeOhlcvWicks(input);
        expect(out[0]).toBe(input[0]!);
    });

    test('empty input', () => {
        expect(sanitizeOhlcvWicks([])).toEqual([]);
    });
    test('a poisoned open does not drag the snapped low to zero', () => {
        // A zero open is not a real price, and the reference prices already
        // reject it. Using it as the body floor would put the low back at 0,
        // which is the flat-zero y-axis this module exists to prevent.
        const input = [
            candle({ time: 1, open: 75, high: 75.4, low: 74.9, close: 75.2 }),
            candle({ time: 2, open: 0, high: 75.5, low: 75, close: 75.3 }),
            candle({ time: 3, open: 75.3, high: 75.6, low: 75.1, close: 75.4 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.low).toBe(75);
        expect(out[1]!.high).toBe(75.5);
    });

    test('a non-finite open does not spread to both wicks', () => {
        const input = [
            candle({ time: 1, open: 75, high: 75.4, low: 74.9, close: 75.2 }),
            candle({ time: 2, open: Number.NaN, high: 75.5, low: 75, close: 75.3 }),
            candle({ time: 3, open: 75.3, high: 75.6, low: 75.1, close: 75.4 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.high).toBe(75.5);
        expect(out[1]!.low).toBe(75);
    });

    test('a poisoned close falls back to the open for the body', () => {
        const input = [
            candle({ time: 1, open: 75, high: 75.4, low: 74.9, close: 75.2 }),
            candle({ time: 2, open: 75.2, high: 75.5, low: 75, close: 0 }),
            candle({ time: 3, open: 75.3, high: 75.6, low: 75.1, close: 75.4 }),
        ];
        const out = sanitizeOhlcvWicks(input);
        expect(out[1]!.low).toBe(75);
        expect(out[1]!.high).toBe(75.5);
    });
});
