import { describe, expect, it } from 'bun:test';

import { normalizeEmail, resolveEffectiveClerkUserId, type IdentityRepo } from './clerkIdentity';

interface FakeUser {
    clerkUserId: string;
    primaryEmail?: string;
    memberships?: number;
    keys?: number;
    activeKeys?: number;
}

function makeRepo(users: FakeUser[]): IdentityRepo & { scoreCalls: string[] } {
    const scoreCalls: string[] = [];
    return {
        scoreCalls,
        listClerkUserIdsByEmail: async email => {
            const ids = users
                .filter(u => (u.primaryEmail ?? '').trim().toLowerCase() === email)
                .map(u => u.clerkUserId);
            return Array.from(new Set(ids));
        },
        getIdentityScoreInputs: async clerkUserId => {
            scoreCalls.push(clerkUserId);
            const u = users.find(x => x.clerkUserId === clerkUserId);
            return {
                memberships: u?.memberships ?? 0,
                keys: u?.keys ?? 0,
                activeKeys: u?.activeKeys ?? 0,
            };
        },
    };
}

describe('normalizeEmail', () => {
    it('trims and lowercases', () => {
        expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co');
    });
    it('returns null for non-strings and empties', () => {
        expect(normalizeEmail(undefined)).toBeNull();
        expect(normalizeEmail(42)).toBeNull();
        expect(normalizeEmail('   ')).toBeNull();
    });
});

describe('resolveEffectiveClerkUserId', () => {
    it('returns caller when no email is resolvable', async () => {
        const repo = makeRepo([{ clerkUserId: 'user_a' }]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a')).toBe('user_a');
        expect(repo.scoreCalls).toHaveLength(0);
    });

    it('never aliases on the stored email when the session carries none (GHSA-6xq9-9vh4-jr57)', async () => {
        // user_a's row claims x@y.co (e.g. written by a poisoned upsert), and user_b
        // is the busier account with that address. Without a session email the
        // caller must stay themselves, with no candidate lookup at all.
        const repo = makeRepo([
            { clerkUserId: 'user_a', primaryEmail: 'x@y.co' },
            { clerkUserId: 'user_b', primaryEmail: 'x@y.co', activeKeys: 2 },
        ]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a')).toBe('user_a');
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', null)).toBe('user_a');
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', '  ')).toBe('user_a');
        expect(repo.scoreCalls).toHaveLength(0);
    });

    it('returns caller when no candidates share the email', async () => {
        const repo = makeRepo([{ clerkUserId: 'user_a', primaryEmail: 'only@me.co' }]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'nobody@else.co')).toBe('user_a');
    });

    it('returns the single candidate without scoring', async () => {
        const repo = makeRepo([{ clerkUserId: 'user_b', primaryEmail: 'x@y.co' }]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'x@y.co')).toBe('user_b');
        expect(repo.scoreCalls).toHaveLength(0);
    });

    it('picks the highest-scoring candidate (activeKeys dominate)', async () => {
        const repo = makeRepo([
            { clerkUserId: 'user_a', primaryEmail: 'x@y.co', memberships: 50, keys: 5 }, // 50 + 500 = 550
            { clerkUserId: 'user_b', primaryEmail: 'x@y.co', activeKeys: 1 }, // 1000
            { clerkUserId: 'user_c', primaryEmail: 'x@y.co', keys: 9 }, // 900
        ]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'x@y.co')).toBe('user_b');
    });

    it('keys beat memberships at the 100x weight', async () => {
        const repo = makeRepo([
            { clerkUserId: 'user_a', primaryEmail: 'x@y.co', memberships: 99 }, // 99
            { clerkUserId: 'user_b', primaryEmail: 'x@y.co', keys: 1 }, // 100
        ]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'x@y.co')).toBe('user_b');
    });

    it('caller wins ties (strict > comparison)', async () => {
        const repo = makeRepo([
            { clerkUserId: 'user_a', primaryEmail: 'x@y.co', activeKeys: 1 },
            { clerkUserId: 'user_b', primaryEmail: 'x@y.co', activeKeys: 1 },
        ]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'x@y.co')).toBe('user_a');
        // And symmetric: caller b keeps b.
        expect(await resolveEffectiveClerkUserId(repo, 'user_b', 'x@y.co')).toBe('user_b');
    });

    it('caller not among candidates can still win on score', async () => {
        // Caller's user row has a different email (identity email passed explicitly),
        // but the caller's own activity beats all candidates.
        const repo = makeRepo([
            { clerkUserId: 'user_a', primaryEmail: 'other@z.co', activeKeys: 5 },
            { clerkUserId: 'user_b', primaryEmail: 'x@y.co', activeKeys: 1 },
            { clerkUserId: 'user_c', primaryEmail: 'x@y.co' },
        ]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', 'x@y.co')).toBe('user_a');
    });

    it('normalizes the identity email before lookup', async () => {
        const repo = makeRepo([{ clerkUserId: 'user_b', primaryEmail: 'x@y.co' }]);
        expect(await resolveEffectiveClerkUserId(repo, 'user_a', '  X@Y.CO ')).toBe('user_b');
    });
});
