import { describe, expect, it } from 'bun:test';

import { normalizeClaim } from './claims';
import {
    DOMINANCE_MIN_LEADER_LIQUIDITY_USD,
    DOMINANCE_MIN_RATIO,
    dominanceDetail,
    withDynamicDominance,
} from './dominance';
import { buildIndexFromEntries, checkSymbolCollision } from './protected-symbols';
import type { EnrichedCandidate } from './types';

const NOW_MS = Date.parse('2026-07-24T00:00:00Z');

function candidate(overrides: Partial<EnrichedCandidate> & { mint: string }): EnrichedCandidate {
    return {
        symbol: 'WIF',
        name: 'dogwifhat',
        decimals: 6,
        logoURI: null,
        price: 1,
        liquidityUsd: 0,
        volume24hUsd: 0,
        marketCapUsd: null,
        priceChange24hPercent: null,
        holderCount: null,
        top10HoldersPercent: null,
        tokenMintTime: null,
        sources: ['provider'],
        registry: null,
        risk: null,
        fillQuality: null,
        tombstoned: false,
        dataAsOf: NOW_MS,
        ...overrides,
    };
}

const emptyIndex = buildIndexFromEntries([]);

describe('withDynamicDominance', () => {
    it('protects the dominant claimant of an unregistered symbol (the WIF case)', () => {
        const real = candidate({ mint: 'RealWif', symbol: '$WIF', liquidityUsd: 4_300_000 });
        const clone = candidate({ mint: 'CloneA', symbol: 'WIF', name: 'WIFCOIN', liquidityUsd: 23_000 });
        const clone2 = candidate({ mint: 'CloneB', symbol: 'Wif', name: 'Dog wif hat', liquidityUsd: 26_000 });

        const { index, leadersByMint } = withDynamicDominance(emptyIndex, [clone2, clone, real]);

        // $WIF normalizes to WIF, so all three are one group with a clear leader.
        expect(leadersByMint.get('RealWif')?.normalizedSymbol).toBe('WIF');
        expect(checkSymbolCollision(real, index, NOW_MS)).toEqual({ kind: 'protected_holder' });
        expect(checkSymbolCollision(clone, index, NOW_MS)).toEqual({
            kind: 'impersonation',
            protectedBy: ['dominance:liquidity'],
        });
    });

    it('protects no one when the symbol is contested', () => {
        const a = candidate({ mint: 'A', liquidityUsd: 2_000_000 });
        const b = candidate({ mint: 'B', liquidityUsd: 2_000_000 / (DOMINANCE_MIN_RATIO - 1) });
        const { index, leadersByMint } = withDynamicDominance(emptyIndex, [a, b]);
        expect(leadersByMint.size).toBe(0);
        expect(index.has('WIF')).toBe(false);
    });

    it('requires the leader to have real standing of its own', () => {
        const small = candidate({ mint: 'A', liquidityUsd: DOMINANCE_MIN_LEADER_LIQUIDITY_USD - 1 });
        const tiny = candidate({ mint: 'B', liquidityUsd: 10 });
        const { leadersByMint } = withDynamicDominance(emptyIndex, [small, tiny]);
        expect(leadersByMint.size).toBe(0);
    });

    it('never overrides a statically protected symbol', () => {
        const staticIndex = buildIndexFromEntries([
            { symbol: 'WIF', mints: ['RegistryWif'], protectedBy: ['registry:dogwifhat'] },
        ]);
        const usurper = candidate({ mint: 'Usurper', liquidityUsd: 50_000_000 });
        const other = candidate({ mint: 'Other', liquidityUsd: 100 });
        const { index, leadersByMint } = withDynamicDominance(staticIndex, [usurper, other]);
        expect(leadersByMint.size).toBe(0);
        expect(index.get(normalizeClaim('WIF').normalized)?.mints.has('RegistryWif')).toBe(true);
    });

    it('skips solo claimants and tombstoned leaders', () => {
        const solo = candidate({ mint: 'Solo', liquidityUsd: 9_000_000 });
        expect(withDynamicDominance(emptyIndex, [solo]).leadersByMint.size).toBe(0);

        const dead = candidate({ mint: 'Dead', liquidityUsd: 9_000_000, tombstoned: true });
        const clone = candidate({ mint: 'Clone', liquidityUsd: 1_000 });
        expect(withDynamicDominance(emptyIndex, [dead, clone]).leadersByMint.size).toBe(0);
    });

    it('handles a zero-liquidity runner-up (infinite ratio)', () => {
        const leader = candidate({ mint: 'L', liquidityUsd: 300_000 });
        const ghost = candidate({ mint: 'G', liquidityUsd: 0 });
        const { leadersByMint } = withDynamicDominance(emptyIndex, [leader, ghost]);
        expect(leadersByMint.get('L')?.ratio).toBe(Infinity);
        expect(dominanceDetail(leadersByMint.get('L')!)).toContain('>100x');
    });
});

describe('normalizeClaim $ prefix', () => {
    it('treats $WIF and WIF as the same claim, without flagging as suspicious', () => {
        const dollar = normalizeClaim('$WIF');
        expect(dollar.normalized).toBe('WIF');
        expect(dollar.hadSuspiciousCharacters).toBe(false);
        expect(normalizeClaim('$$wif').normalized).toBe('WIF');
        expect(normalizeClaim('WIF').normalized).toBe('WIF');
    });

    it('does not strip interior dollars', () => {
        expect(normalizeClaim('WI$F').normalized).toBe('WI$F');
    });
});
