import { describe, expect, it } from 'bun:test';

import { InvalidArgsError, IdentityRequiredError, UnauthorizedError } from './errors';
import {
    buildDeletionTombstoneRows,
    hardDeleteAsset,
    type HardDeleteCounters,
    type HardDeleteRepo,
} from './hardDelete';

const ADMIN = { clerkUserId: 'admin_1' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);

const COUNTERS: HardDeleteCounters = {
    membershipsDeleted: 1,
    aliasesDeleted: 2,
    v2VariantsDeleted: 2,
    variantsDeleted: 3,
    variantMarketsDeleted: 4,
    tokenMarketsDeleted: 5,
    tokenDocsDeleted: 6,
    tokenDescriptionSummariesDeleted: 7,
    assetRiskDeleted: 8,
    ohlcvDeleted: 9,
    webacyDeleted: 10,
    rwaTokenCacheDeleted: 11,
    rwaAssetCacheDeleted: 12,
    assetMarketDeleted: 1,
    coingeckoPricesDeleted: 1,
    coingeckoTickersDeleted: 1,
    coingeckoOhlcvDeleted: 13,
    tombstonesCreated: 14,
};

function makeRepo(result: HardDeleteCounters | null): { repo: HardDeleteRepo; calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        repo: {
            hardDeleteAsset: async args => {
                calls.push(args);
                return result;
            },
        },
        calls,
    };
}

describe('hardDeleteAsset handler', () => {
    it('requires identity (401) and admin allowlist (403)', async () => {
        const { repo } = makeRepo(COUNTERS);
        const deps = { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() } };
        await expect(hardDeleteAsset(deps, { assetId: 'bitcoin' }, null)).rejects.toBeInstanceOf(
            IdentityRequiredError,
        );
        await expect(
            hardDeleteAsset(deps, { assetId: 'bitcoin' }, { clerkUserId: 'user_9' }),
        ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('mirrors Convex validation errors', async () => {
        const { repo } = makeRepo(null);
        const deps = { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() } };
        await expect(hardDeleteAsset(deps, { assetId: '  ' }, ADMIN)).rejects.toThrow('assetId is required');
        await expect(hardDeleteAsset(deps, { assetId: 'ghost' }, ADMIN)).rejects.toThrow('Asset not found');
        await expect(hardDeleteAsset(deps, { assetId: 'ghost' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
    });

    it('returns the exact Convex counter shape with deleted:true / pendingOhlcvDelete:false', async () => {
        const { repo, calls } = makeRepo(COUNTERS);
        const deps = { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() }, now: () => 1_750_000_000_000 };
        const result = await hardDeleteAsset(deps, { assetId: ' bitcoin ' }, ADMIN);
        expect(calls[0]).toEqual({ assetId: 'bitcoin', nowMs: 1_750_000_000_000 });
        expect(result).toEqual({
            deleted: true,
            assetId: 'bitcoin',
            ...COUNTERS,
            pendingOhlcvDelete: false,
        });
        // The admin dialog loops while !deleted — the PG cascade is single-shot.
        expect(result.deleted).toBe(true);
        expect(result.pendingOhlcvDelete).toBe(false);
        expect(Object.keys(result).sort()).toEqual(
            [
                'deleted',
                'assetId',
                'membershipsDeleted',
                'aliasesDeleted',
                'variantsDeleted',
                'v2VariantsDeleted',
                'variantMarketsDeleted',
                'tokenMarketsDeleted',
                'tokenDocsDeleted',
                'tokenDescriptionSummariesDeleted',
                'assetRiskDeleted',
                'ohlcvDeleted',
                'webacyDeleted',
                'rwaTokenCacheDeleted',
                'rwaAssetCacheDeleted',
                'assetMarketDeleted',
                'coingeckoPricesDeleted',
                'coingeckoTickersDeleted',
                'coingeckoOhlcvDeleted',
                'tombstonesCreated',
                'pendingOhlcvDelete',
            ].sort(),
        );
    });
});

describe('buildDeletionTombstoneRows', () => {
    const MINT = 'So11111111111111111111111111111111111111112';

    it('classifies refs with Convex precedence', () => {
        // assetId deliberately differs from the lowercase name so the name ref
        // is not deduped away by the normalized-ref check.
        const rows = buildDeletionTombstoneRows({
            assetId: 'asset-btc',
            name: 'Bitcoin',
            symbol: 'BTC',
            coingeckoId: 'bitcoin-cg',
            assetAliases: ['btc coin'],
            aliasRowAliases: ['digital gold'],
            mints: [MINT],
        });
        const byRef = new Map(rows.map(row => [row.ref, row.kind]));
        expect(byRef.get('asset-btc')).toBe('assetId');
        expect(byRef.get('bitcoin-cg')).toBe('coingeckoId');
        expect(byRef.get('Bitcoin')).toBe('name');
        expect(byRef.get('BTC')).toBe('symbol');
        expect(byRef.get(MINT)).toBe('mint');
        expect(byRef.get(`solana-${MINT}`)).toBe('singletonAssetId');
        expect(byRef.get('btc coin')).toBe('alias');
        expect(byRef.get('digital gold')).toBe('alias');
    });

    it('dedupes on the lowercase normalized ref keeping the first occurrence', () => {
        const rows = buildDeletionTombstoneRows({
            assetId: 'bitcoin',
            name: 'BTC',
            symbol: 'btc',
            coingeckoId: null,
            assetAliases: [],
            aliasRowAliases: [' BTC '],
            mints: [],
        });
        const btcRows = rows.filter(row => row.normalizedRef === 'btc');
        expect(btcRows).toEqual([{ ref: 'BTC', normalizedRef: 'btc', kind: 'name' }]);
    });

    it('skips blank refs and trims whitespace', () => {
        const rows = buildDeletionTombstoneRows({
            assetId: 'x',
            name: '   ',
            symbol: null,
            coingeckoId: null,
            assetAliases: ['  ', ' alias-a '],
            aliasRowAliases: [],
            mints: [],
        });
        expect(rows).toEqual([
            { ref: 'x', normalizedRef: 'x', kind: 'assetId' },
            { ref: 'alias-a', normalizedRef: 'alias-a', kind: 'alias' },
        ]);
    });
});
