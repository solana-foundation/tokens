import { describe, expect, it } from 'bun:test';

import { bearerTokenCandidates, isValidBearerToken, timingSafeEqualString } from './index';

describe('timingSafeEqualString', () => {
    it('compares equal and unequal strings', () => {
        expect(timingSafeEqualString('abc', 'abc')).toBe(true);
        expect(timingSafeEqualString('abc', 'abd')).toBe(false);
        expect(timingSafeEqualString('abc', 'ab')).toBe(false);
        expect(timingSafeEqualString('', '')).toBe(true);
    });
});

describe('isValidBearerToken', () => {
    it('accepts the exact bearer and rejects everything else for a single token', () => {
        expect(isValidBearerToken('Bearer tok', 'tok')).toBe(true);
        expect(isValidBearerToken('Bearer tok ', 'tok')).toBe(false);
        expect(isValidBearerToken('bearer tok', 'tok')).toBe(false);
        expect(isValidBearerToken('Bearer other', 'tok')).toBe(false);
        expect(isValidBearerToken('tok', 'tok')).toBe(false);
        expect(isValidBearerToken(undefined, 'tok')).toBe(false);
        expect(isValidBearerToken('Bearer ', '')).toBe(false);
    });

    it('accepts any token in the candidate list during a rotation', () => {
        expect(isValidBearerToken('Bearer new', ['new', 'old'])).toBe(true);
        expect(isValidBearerToken('Bearer old', ['new', 'old'])).toBe(true);
        expect(isValidBearerToken('Bearer other', ['new', 'old'])).toBe(false);
        expect(isValidBearerToken(undefined, ['new', 'old'])).toBe(false);
    });

    it('never matches an empty candidate', () => {
        expect(isValidBearerToken('Bearer ', ['new', ''])).toBe(false);
        expect(isValidBearerToken('Bearer ', [])).toBe(false);
    });
});

describe('bearerTokenCandidates', () => {
    it('returns the current token alone unless a previous one is set', () => {
        expect(bearerTokenCandidates('cur')).toBe('cur');
        expect(bearerTokenCandidates('cur', undefined)).toBe('cur');
        expect(bearerTokenCandidates('cur', '   ')).toBe('cur');
        expect(bearerTokenCandidates('cur', ' old ')).toEqual(['cur', 'old']);
    });
});
