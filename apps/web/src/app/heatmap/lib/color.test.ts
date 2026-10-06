import { describe, expect, test } from 'bun:test';

import { changeBin } from './color';

describe('changeBin', () => {
    test('bins by magnitude with the sign picking the arm', () => {
        expect(changeBin(0, '24h')!.step).toBe(0);
        expect(changeBin(0.01, '24h')!.step).toBe(1);
        expect(changeBin(-1.4, '24h')!.step).toBe(-1);
        expect(changeBin(1.5, '24h')!.step).toBe(2);
        expect(changeBin(-3.99, '24h')!.step).toBe(-2);
    });

    test('gray is exactly what prints as 0.00%; any visible move is coloured', () => {
        expect(changeBin(0.004, '24h')!.step).toBe(0);
        expect(changeBin(-0.004, '1h')!.step).toBe(0);
        expect(changeBin(0.04, '24h')!.step).toBe(1);
        expect(changeBin(-0.01, '24h')!.step).toBe(-1);
        expect(changeBin(0.01, '1h')!.step).toBe(1);
    });

    test('clamps beyond the last threshold', () => {
        expect(changeBin(4, '24h')!.step).toBe(3);
        expect(changeBin(480, '24h')!.step).toBe(3);
        expect(changeBin(-99, '24h')!.step).toBe(-3);
    });

    test('uses tighter upper steps for the 1h period', () => {
        expect(changeBin(0.7, '24h')!.step).toBe(1);
        expect(changeBin(0.7, '1h')!.step).toBe(2);
        expect(changeBin(-1.5, '1h')!.step).toBe(-3);
    });

    test('missing change is no bin at all, never the neutral midpoint', () => {
        expect(changeBin(null, '24h')).toBeNull();
        expect(changeBin(undefined, '24h')).toBeNull();
        expect(changeBin(Number.NaN, '24h')).toBeNull();
        expect(changeBin(Number.POSITIVE_INFINITY, '24h')).toBeNull();
    });
});
