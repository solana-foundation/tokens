import { describe, expect, it } from 'bun:test';

import { classifyQuery } from './intent';
import { USDC_MINT } from './fixtures';

describe('classifyQuery', () => {
    it('classifies a pasted mint as a lookup, never a search', () => {
        const interpretation = classifyQuery(USDC_MINT);
        expect(interpretation.intent).toBe('mint');
        expect(interpretation.normalizedQuery).toBe(USDC_MINT);
    });

    it('classifies short symbol-ish queries as ticker', () => {
        expect(classifyQuery('USDC').intent).toBe('ticker');
        expect(classifyQuery('bonk').intent).toBe('ticker');
        expect(classifyQuery('$WIF').intent).toBe('ticker');
        expect(classifyQuery('$WIF').normalizedQuery).toBe('WIF');
    });

    it('classifies multi-word or long queries as name', () => {
        expect(classifyQuery('dog wif hat').intent).toBe('name');
        expect(classifyQuery('averylongtokenname').intent).toBe('name');
    });

    it('flags homoglyph queries as suspicious but still normalizes them', () => {
        const interpretation = classifyQuery('USDС');
        expect(interpretation.intent).toBe('ticker');
        expect(interpretation.normalizedQuery).toBe('USDC');
        expect(interpretation.hadSuspiciousCharacters).toBe(true);
    });
});
