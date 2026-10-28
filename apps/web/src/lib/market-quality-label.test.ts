import { describe, expect, it } from 'bun:test';

import { compareMarketInclusion, isMarketIncluded, marketQualityVerdict } from './market-quality-label';

describe('marketQualityVerdict', () => {
    it('names the most useful reason first', () => {
        expect(marketQualityVerdict([])).toBeNull();
        expect(marketQualityVerdict(['dust'])?.label).toBe('No active market');
        expect(marketQualityVerdict(['inactive', 'dust'])?.label).toBe('No active market');
        expect(marketQualityVerdict(['stale', 'price_outlier'])?.label).toBe('Price off reference');
        expect(marketQualityVerdict(['stale'])?.label).toBe('Stale data');
    });
});

describe('compareMarketInclusion', () => {
    it('keeps included rows ahead of excluded ones and leaves order alone otherwise', () => {
        const included = { market: { quality: { included: true, reasons: [] } } };
        const excluded = { market: { quality: { included: false, reasons: ['dust' as const] } } };
        const unknown = { market: null };
        expect(isMarketIncluded(unknown.market)).toBe(true);
        expect([excluded, unknown, included].sort(compareMarketInclusion)).toEqual([unknown, included, excluded]);
    });
});
