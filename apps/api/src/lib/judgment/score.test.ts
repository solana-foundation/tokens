import { describe, expect, it } from 'bun:test';

import { classifyMatch } from './score';
import { realUsdc } from './fixtures';

describe('classifyMatch', () => {
    it('an empty query (judge without q) never matches, even against a missing symbol', () => {
        const noQuery = { intent: 'name' as const, normalizedQuery: '', hadSuspiciousCharacters: false };
        expect(classifyMatch(realUsdc(), noQuery)).toBe('weak');
        expect(classifyMatch({ ...realUsdc(), symbol: null, name: null, registry: null }, noQuery)).toBe('weak');
    });

    it('a ticker query still matches the exact symbol', () => {
        expect(
            classifyMatch(realUsdc(), { intent: 'ticker', normalizedQuery: 'USDC', hadSuspiciousCharacters: false }),
        ).toBe('exact_symbol');
    });
});
