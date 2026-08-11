/**
 * Coverage for the curated-list score floor in `computeMarketScore`.
 *
 * These assert current behaviour rather than a desired change: the floor at
 * index.ts:475-476 raises any token on TRUSTED_LAUNCH_LISTS that is <= 21 days
 * old to a score of 70, which is exactly the grade-B boundary, after all caps
 * have been applied. See the discussion on issue #30.
 */

import { describe, expect, test } from 'bun:test';

import { computeMarketScore, type MarketScoreInput } from './index';

/** Real member of the curated `rwas` list, which is in TRUSTED_LAUNCH_LISTS. */
const CURATED_RWA = '4MmJVdwYN8LwvbGeCowYjSx7KoEi6BJWg8XXnW4fDDp6';
const UNCURATED = 'Zzz11111111111111111111111111111111111111111';

/**
 * Metrics that trip four independent hard caps:
 *   whale-dominance (>80% top10), ghost-token (<20 holders),
 *   dead-token (<$100 7d volume), new-token (<1 week old).
 */
const AWFUL = {
    liquidityUsd: 5_000,
    marketCapUsd: 2_000_000,
    holderCount: 12,
    top10HoldersPercent: 95,
    volume24hUsd: 10,
    volume7dUsd: 50,
    tokenMintTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
} satisfies Omit<MarketScoreInput, 'tokenAddress'>;

describe('trusted-launch score floor', () => {
    test('control: an uncurated token with these metrics scores 17 / grade C', () => {
        const r = computeMarketScore({ ...AWFUL, tokenAddress: UNCURATED });

        expect(r.score).toBe(17);
        expect(r.grade).toBe('C');
        expect(r.tone).toBe('risk');
    });

    test('curated + age <= 21d: identical metrics are floored 17 -> 70, C -> B', () => {
        const r = computeMarketScore({ ...AWFUL, tokenAddress: CURATED_RWA });

        // +53 points, from curated-list membership alone.
        expect(r.score).toBe(70);
        expect(r.grade).toBe('B');
        expect(r.tone).toBe('warning'); // not 'risk'
        expect(r.isTrustedLaunch).toBe(true);
        expect(r.label).toBe('Trusted Launch');

        // Nothing in the payload explains the jump or flags the underlying risk:
        // the caps never "applied" because the raw score was already below every
        // cap ceiling, so a consumer sees a B with an empty caps array.
        expect(r.caps).toEqual([]);
        expect(r.borderlineSignals).toEqual([]);
    });

    test('one day past the window (22d) the same token collapses back to 17 / C', () => {
        const r = computeMarketScore({
            ...AWFUL,
            tokenAddress: CURATED_RWA,
            tokenMintTime: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
        });

        expect(r.score).toBe(17);
        expect(r.grade).toBe('C');
    });

    test('an unknown mint time disables the floor entirely', () => {
        const r = computeMarketScore({ ...AWFUL, tokenAddress: CURATED_RWA, tokenMintTime: null });

        expect(r.isTrustedLaunch).toBe(false);
        expect(r.score).toBe(17);
    });
});
