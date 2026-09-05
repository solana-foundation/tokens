import { afterEach, describe, expect, it } from 'bun:test';

import type { CuratedMembershipSnapshot } from '@/lib/cloudrun';
import { __setCuratedMembershipSnapshotForTests } from '@/lib/curated-membership';

import { buildIndexFromEntries, checkSymbolCollision, getProtectedSymbolIndex, registryClaimedSymbol } from './protected-symbols';
import { NOW_MS, USDC_MINT, fakeUsdc, homoglyphUsdc, realUsdc, newDogToken } from './fixtures';

function membershipSnapshot(
    overrides: Partial<CuratedMembershipSnapshot> & { loadedAt: number },
): CuratedMembershipSnapshot {
    return { mintsByList: {}, allMints: [], entriesByMint: {}, ...overrides };
}

const index = buildIndexFromEntries([
    { symbol: 'USDC', mints: [USDC_MINT], protectedBy: ['curated:currencies'] },
]);

describe('checkSymbolCollision', () => {
    it('recognizes the protected mint itself as the holder', () => {
        expect(checkSymbolCollision(realUsdc(), index, NOW_MS)).toEqual({ kind: 'protected_holder' });
    });

    it('flags a young shallow unattested claimer as impersonation', () => {
        const verdict = checkSymbolCollision(fakeUsdc(), index, NOW_MS);
        expect(verdict.kind).toBe('impersonation');
    });

    it('catches homoglyph symbol claims (Cyrillic C)', () => {
        const verdict = checkSymbolCollision(homoglyphUsdc(), index, NOW_MS);
        expect(verdict.kind).toBe('impersonation');
    });

    it('ignores candidates whose symbols are not protected', () => {
        expect(checkSymbolCollision(newDogToken(), index, NOW_MS)).toEqual({ kind: 'none' });
    });

    it('treats an established different token sharing a symbol as collision, not impersonation', () => {
        const established = {
            ...fakeUsdc(),
            liquidityUsd: 5_000_000,
            tokenMintTime: '2023-01-01T00:00:00Z',
            curatedListIds: [],
            registry: {
                assetId: 'other-usdc-like',
                symbol: 'USDC',
                name: 'Other',
                kind: 'native',
                trustTier: 'tier2',
            },
        };
        const verdict = checkSymbolCollision(established, index, NOW_MS);
        expect(verdict.kind).toBe('collision');
    });
});

describe('getProtectedSymbolIndex', () => {
    afterEach(() => {
        __setCuratedMembershipSnapshotForTests(null);
    });

    it('builds a real index containing majors like SOL and USDC', async () => {
        // Note: the index is memoized per snapshot `loadedAt` — each injected
        // snapshot in this file uses a distinct value.
        __setCuratedMembershipSnapshotForTests(
            membershipSnapshot({
                loadedAt: 1,
                mintsByList: { currencies: [USDC_MINT] },
                allMints: [USDC_MINT],
                entriesByMint: {
                    [USDC_MINT]: { assetId: 'usd-coin', listSlugs: ['currencies'], symbol: 'USDC' },
                },
            }),
        );

        const realIndex = await getProtectedSymbolIndex();
        expect(realIndex.size).toBeGreaterThan(50);
        expect(realIndex.has('USDC')).toBe(true);
        expect(realIndex.has('SOL')).toBe(true);
        expect(realIndex.get('USDC')?.protectedBy).toContain('curated:currencies');
    });

    it('protects curated admin-only mints unknown to the compiled registry', async () => {
        const newcoMint = 'NewCoAdminOnlyMint11111111111111111111111111';
        __setCuratedMembershipSnapshotForTests(
            membershipSnapshot({
                loadedAt: 2,
                mintsByList: { community: [newcoMint] },
                allMints: [newcoMint],
                entriesByMint: {
                    [newcoMint]: { assetId: null, listSlugs: ['community'], symbol: 'NEWCO' },
                },
            }),
        );

        const realIndex = await getProtectedSymbolIndex();
        const entry = realIndex.get('NEWCO');
        expect(entry).toBeDefined();
        expect(entry?.mints.has(newcoMint)).toBe(true);
        expect(entry?.protectedBy).toContain('curated:community');

        // The curated admin-only mint itself is the protected holder.
        const holder = { ...newDogToken(), mint: newcoMint, symbol: 'NEWCO', curatedListIds: ['community'] };
        expect(checkSymbolCollision(holder, realIndex, NOW_MS)).toEqual({ kind: 'protected_holder' });

        // A fresh unattested claimer of NEWCO is flagged as impersonation.
        const impostor = { ...fakeUsdc(), symbol: 'NEWCO' };
        expect(checkSymbolCollision(impostor, realIndex, NOW_MS).kind).toBe('impersonation');
    });
});

describe('registryClaimedSymbol', () => {
    it('lets identity variants inherit the asset symbol', () => {
        expect(registryClaimedSymbol({ symbol: null, kind: 'native' }, { symbol: 'SOL' })).toBe('SOL');
        expect(registryClaimedSymbol({ symbol: null, kind: 'wrapped' }, { symbol: 'BTC' })).toBe('BTC');
        expect(registryClaimedSymbol({ symbol: null, kind: 'bridged' }, { symbol: 'USDC' })).toBe('USDC');
    });

    it('never lets derivative variants inherit — bSOL is not SOL', () => {
        expect(registryClaimedSymbol({ symbol: null, kind: 'yield' }, { symbol: 'SOL' })).toBeNull();
        expect(registryClaimedSymbol({ symbol: null, kind: 'lst' }, { symbol: 'SOL' })).toBeNull();
        expect(registryClaimedSymbol({ symbol: null, kind: 'etf' }, { symbol: 'BTC' })).toBeNull();
        expect(registryClaimedSymbol({ symbol: null, kind: 'tokenized_equity' }, { symbol: 'TSLA' })).toBeNull();
    });

    it('always prefers the variant own symbol', () => {
        expect(registryClaimedSymbol({ symbol: 'mSOL', kind: 'yield' }, { symbol: 'SOL' })).toBe('mSOL');
        expect(registryClaimedSymbol({ symbol: 'JitoSOL', kind: 'lst' }, { symbol: 'SOL' })).toBe('JitoSOL');
    });
});
