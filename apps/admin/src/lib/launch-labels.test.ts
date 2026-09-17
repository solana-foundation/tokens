import { describe, expect, it } from 'bun:test';

import type { LaunchpadCandidateRow } from './admin-types';
import {
    UNSYNCED_GROUP_KEY,
    formatUsdCompact,
    groupLaunchCandidates,
    launchGroupLabel,
    launchGroupMatches,
    mergePairAssets,
    latestSyncTimestamp,
    launchApproverLabel,
    launchStatusLabel,
    looksLikeSolanaMintAddress,
    stonkfunTokenUrl,
    validateLaunchNote,
} from './launch-labels';

describe('validateLaunchNote', () => {
    it('treats blank as no note and trims otherwise', () => {
        expect(validateLaunchNote('   ')).toEqual({ ok: true, note: null });
        expect(validateLaunchNote('  team pick ')).toEqual({ ok: true, note: 'team pick' });
    });

    it('rejects notes over 500 characters', () => {
        const result = validateLaunchNote('x'.repeat(501));
        expect(result.ok).toBe(false);
    });
});

describe('launchStatusLabel', () => {
    it('maps sync/identity state to a label', () => {
        expect(launchStatusLabel({ synced: false, isActive: false, lastSyncedAt: null }, 100)).toBe('not synced yet');
        expect(launchStatusLabel({ synced: true, isActive: true, lastSyncedAt: 100 }, 100)).toBe('live');
        expect(launchStatusLabel({ synced: true, isActive: false, lastSyncedAt: 100 }, 100)).toBe('pending identity');
        expect(launchStatusLabel({ synced: true, isActive: false, lastSyncedAt: 50 }, 100)).toBe('not in last sync');
    });
});

describe('helpers', () => {
    it('finds the latest sync timestamp', () => {
        expect(latestSyncTimestamp([{ lastSyncedAt: null }, { lastSyncedAt: 5 }, { lastSyncedAt: 9 }])).toBe(9);
        expect(latestSyncTimestamp([{ lastSyncedAt: null }])).toBeNull();
    });

    it('labels approvers by email, else a shortened Clerk id', () => {
        expect(launchApproverLabel({ approvedBy: 'user_2abcdefghijklmnop', approvedByEmail: 'a@b.c' })).toBe('a@b.c');
        expect(launchApproverLabel({ approvedBy: 'user_2abcdefghijklmnop', approvedByEmail: null })).toBe(
            'user_2abcd…mnop',
        );
    });

    it('formats compact USD and validates mint shape', () => {
        expect(formatUsdCompact(null)).toBe('—');
        expect(formatUsdCompact(1_234)).toBe('$1.2K');
        expect(formatUsdCompact(3_804_599)).toBe('$3.80M');
        expect(looksLikeSolanaMintAddress('HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ')).toBe(true);
        expect(looksLikeSolanaMintAddress('0OIl')).toBe(false);
        expect(stonkfunTokenUrl('abc')).toBe('https://www.stonkfun.xyz/token/abc');
    });
});

function row(overrides: Partial<LaunchpadCandidateRow>): LaunchpadCandidateRow {
    return {
        launchpad: 'stonkfun',
        mint: 'M',
        synced: true,
        isActive: true,
        quoteMint: 'Q',
        quoteSymbol: 'GLDX',
        symbol: 'GP',
        name: 'RuneScape Gold',
        logoURI: null,
        marketCapUsd: 1,
        volume24hUsd: 10,
        launchedAt: null,
        lastSyncedAt: 100,
        quoteAsset: { assetId: 'gold', name: 'Gold', symbol: 'GLD', imageUrl: null },
        approval: null,
        ...overrides,
    };
}

describe('groupLaunchCandidates', () => {
    it('groups by quote asset, counts, and orders unsynced → approved → volume', () => {
        const groups = groupLaunchCandidates([
            row({ mint: 'a', volume24hUsd: 500 }),
            row({
                mint: 'b',
                volume24hUsd: 5,
                approval: { note: null, approvedBy: 'u', approvedByEmail: null, approvedAt: 1, updatedAt: 1 },
            }),
            row({
                mint: 'c',
                quoteMint: 'S',
                quoteSymbol: 'SPYX',
                quoteAsset: { assetId: 'sp500', name: 'S&P 500', symbol: 'SPYx', imageUrl: null },
                volume24hUsd: 9_000,
            }),
            row({
                mint: 'd',
                synced: false,
                isActive: false,
                quoteMint: null,
                quoteSymbol: null,
                quoteAsset: null,
                lastSyncedAt: null,
                approval: { note: 'x', approvedBy: 'u', approvedByEmail: null, approvedAt: 1, updatedAt: 1 },
            }),
            row({ mint: 'e', quoteMint: 'Z', quoteSymbol: 'ZZZ', quoteAsset: null, volume24hUsd: 1 }),
        ]);
        expect(groups.map(g => g.key)).toEqual([UNSYNCED_GROUP_KEY, 'gold', 'sp500', 'Z']);
        const gold = groups[1]!;
        expect(gold.counts).toEqual({ candidates: 2, approved: 1, live: 1 });
        expect(gold.rows.map(r => r.mint)).toEqual(['b', 'a']);
        expect(gold.quoteMints).toEqual(['Q']);
        expect(gold.lastSyncedAt).toBe(100);
        expect(launchGroupLabel(gold)).toEqual({ symbol: 'GLD', name: 'Gold' });
        expect(launchGroupLabel(groups[0]!).symbol).toBe('Not synced yet');
        expect(launchGroupLabel(groups[3]!)).toEqual({ symbol: 'ZZZ', name: 'Quote mint is not a curated asset' });
    });

    it('matches search against asset and coin identity', () => {
        const [gold] = groupLaunchCandidates([row({ mint: 'HTmQ', symbol: 'GP', name: 'RuneScape Gold' })]);
        expect(launchGroupMatches(gold!, 'gold')).toBe(true);
        expect(launchGroupMatches(gold!, 'htm')).toBe(true);
        expect(launchGroupMatches(gold!, 'nvda')).toBe(false);
        expect(launchGroupMatches(gold!, '  ')).toBe(true);
    });
});

describe('mergePairAssets', () => {
    it('adds empty rows for curated pairs without coins and keeps existing groups first', () => {
        const groups = groupLaunchCandidates([row({ mint: 'a', volume24hUsd: 5 })]);
        const merged = mergePairAssets(groups, [
            {
                assetId: 'nvidia',
                symbol: 'NVDA',
                name: 'NVIDIA',
                imageUrl: null,
                quoteMints: [{ mint: 'N1', symbol: 'NVDAX', category: 'xstock' }],
            },
            {
                assetId: 'gold',
                symbol: 'GLD',
                name: 'Gold',
                imageUrl: null,
                quoteMints: [
                    { mint: 'Q', symbol: 'GLDX', category: 'xstock' },
                    { mint: 'Q2', symbol: 'GLDX2', category: 'backpack' },
                ],
            },
            {
                assetId: 'apple',
                symbol: 'AAPL',
                name: 'Apple',
                imageUrl: null,
                quoteMints: [{ mint: 'A1', symbol: 'APPLX', category: 'xstock' }],
            },
        ]);
        expect(merged.map(g => g.key)).toEqual(['gold', 'apple', 'nvidia']);
        expect(merged[0]!.quoteMints).toEqual(['Q', 'Q2']);
        expect(merged[0]!.counts.candidates).toBe(1);
        expect(merged[2]).toMatchObject({
            key: 'nvidia',
            quoteSymbol: 'NVDAX',
            rows: [],
            counts: { candidates: 0, approved: 0, live: 0 },
        });
    });
});
