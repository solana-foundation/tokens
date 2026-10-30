import { describe, expect, test } from 'bun:test';

import { applyLiveChangePercent } from './live-change';

describe('applyLiveChangePercent', () => {
    test('moves the change with the live price against the snapshot reference', () => {
        // Snapshot: $110 after a +10% day → reference $100. Live $121 → +21%.
        expect(applyLiveChangePercent(110, 10, 121)).toBeCloseTo(21, 9);
        // Snapshot: $90 after a -10% day → reference $100. Live $95 → -5%.
        expect(applyLiveChangePercent(90, -10, 95)).toBeCloseTo(-5, 9);
        // No movement keeps the snapshot change.
        expect(applyLiveChangePercent(94.24, -6.6, 94.24)).toBeCloseTo(-6.6, 9);
    });

    test('falls back to the snapshot change when inputs cannot support the math', () => {
        expect(applyLiveChangePercent(110, 10, null)).toBe(10);
        expect(applyLiveChangePercent(null, 10, 121)).toBe(10);
        expect(applyLiveChangePercent(0, 10, 121)).toBe(10);
        expect(applyLiveChangePercent(110, -100, 121)).toBe(-100);
        expect(applyLiveChangePercent(110, Number.NaN, 121)).toBeNull();
        expect(applyLiveChangePercent(110, undefined, 121)).toBeNull();
    });
});
