import { describe, expect, test } from 'bun:test';

import { formatLargeNumber, toEpochMs } from './format';

describe('formatLargeNumber', () => {
    test('has a trillion tier so a $4.1T market cap is not rendered as $4100.00B', () => {
        expect(formatLargeNumber(4_100_000_000_000)).toBe('$4.10T');
        expect(formatLargeNumber(1_640_000_000_000)).toBe('$1.64T');
        expect(formatLargeNumber(96_400_000_000)).toBe('$96.40B');
        expect(formatLargeNumber(null)).toBe('—');
    });
});

describe('toEpochMs', () => {
    test('passes millisecond stamps through and scales second stamps', () => {
        expect(toEpochMs(1_792_681_201_000)).toBe(1_792_681_201_000);
        expect(toEpochMs(1_792_681_201)).toBe(1_792_681_201_000);
        expect(toEpochMs(0)).toBeNull();
        expect(toEpochMs(null)).toBeNull();
    });
});
