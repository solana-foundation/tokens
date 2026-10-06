import { describe, expect, test } from 'bun:test';

import { changeBin, legendStops } from './color';

describe('changeBin', () => {
    test('bins by magnitude with the sign picking the arm', () => {
        expect(changeBin(0, '24h')!.step).toBe(0);
        expect(changeBin(0.09, '24h')!.step).toBe(0);
        expect(changeBin(-0.09, '24h')!.step).toBe(0);
        expect(changeBin(0.1, '24h')!.step).toBe(1);
        expect(changeBin(-1.4, '24h')!.step).toBe(-1);
        expect(changeBin(1.5, '24h')!.step).toBe(2);
        expect(changeBin(-3.99, '24h')!.step).toBe(-2);
    });

    test('any real move is coloured; only flat prices stay neutral', () => {
        expect(changeBin(0.12, '24h')!.step).toBe(1);
        expect(changeBin(-0.15, '24h')!.step).toBe(-1);
        expect(changeBin(0.004, '24h')!.step).toBe(0);
    });

    test('clamps beyond the last threshold', () => {
        expect(changeBin(4, '24h')!.step).toBe(3);
        expect(changeBin(480, '24h')!.step).toBe(3);
        expect(changeBin(-99, '24h')!.step).toBe(-3);
    });

    test('uses tighter thresholds for the 1h period', () => {
        expect(changeBin(0.07, '24h')!.step).toBe(0);
        expect(changeBin(0.07, '1h')!.step).toBe(1);
        expect(changeBin(-1.5, '1h')!.step).toBe(-3);
    });

    test('missing change is no bin at all, never the neutral midpoint', () => {
        expect(changeBin(null, '24h')).toBeNull();
        expect(changeBin(undefined, '24h')).toBeNull();
        expect(changeBin(Number.NaN, '24h')).toBeNull();
        expect(changeBin(Number.POSITIVE_INFINITY, '24h')).toBeNull();
    });
});

describe('legendStops', () => {
    test('runs from most negative to most positive through a single neutral midpoint', () => {
        const stops = legendStops('24h');

        expect(stops.map(stop => stop.bin.step)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
        expect(stops.map(stop => stop.label)).toEqual(['≤ −4%', '−1.5%', '−0.1%', '0%', '+0.1%', '+1.5%', '≥ +4%']);
        expect(new Set(stops.map(stop => stop.bin.fill)).size).toBe(7);
    });
});
