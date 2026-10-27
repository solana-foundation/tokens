import { describe, expect, test } from 'bun:test';

import { buildPrefixTsQuery } from './db';

describe('buildPrefixTsQuery', () => {
    test('returns null for empty, whitespace and punctuation-only input', () => {
        expect(buildPrefixTsQuery('')).toBeNull();
        expect(buildPrefixTsQuery('   ')).toBeNull();
        expect(buildPrefixTsQuery('$$ -- !!')).toBeNull();
    });

    test('prefix-matches every alphanumeric token and ANDs them', () => {
        expect(buildPrefixTsQuery('sol')).toBe('sol:*');
        expect(buildPrefixTsQuery('  Wrapped   Bitcoin ')).toBe('Wrapped:* & Bitcoin:*');
        expect(buildPrefixTsQuery('usd-coin (USDC)')).toBe('usdcoin:* & USDC:*');
    });

    test('stop words are passed through unchanged; the query layer handles them', () => {
        // Postgres drops "the" and raises a NOTICE; the CTE in each search
        // query makes that one notice per query, and the client drops it.
        expect(buildPrefixTsQuery('the')).toBe('the:*');
    });
});
