import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { CanonicalAsset } from '@tokens/asset-registry';
import { CURATED_LIST_SLUGS } from '@tokens/asset-registry/curated-lists';

import { InvalidArgsError } from './assets';
import {
    backfillMissingAssetIdentity,
    cleanupMaterializedAllCollection,
    seedCanonicalAssetsRegistry,
    seedCuratedCollectionsFixture,
    buildAssetAliases,
    deriveFallbackName,
    deriveFallbackSymbol,
    type BirdeyeIdentityClient,
    type CanonicalAssetAliasUpsert,
    type CanonicalAssetCollectionMemberUpsert,
    type CanonicalAssetCollectionUpsert,
    type CanonicalAssetUpsert,
    type CanonicalAssetVariantUpsert,
    type IdentityAssetRow,
    type IdentityMarketRow,
    type IdentityVariantRow,
    type SeedRepo,
    type SetAssetIdentityArgs,
} from './crons.seed';

const FIXED_NOW = 1_780_000_000_000;

interface RecorderState {
    upsertedAssets: CanonicalAssetUpsert[];
    upsertedVariants: CanonicalAssetVariantUpsert[];
    upsertedAliases: CanonicalAssetAliasUpsert[];
    ensuredMarkets: string[];
    insertedCollections: CanonicalAssetCollectionUpsert[];
    insertedCollectionMembers: CanonicalAssetCollectionMemberUpsert[];
    /** (slug, assetId) pairs already present — insertCollectionMembersIfMissing skips them. */
    memberKeys: Set<string>;
    /** Pre-existing membership rows (before any fixture insert this run). */
    existingMemberCount: number;
    tombstonedAssetIds: Set<string>;
    deletedCollectionSlugs: string[];
    deleteCascadeRows: number;
    tombstonedRefs: Set<string>;
    loweredAddedAtCalls: Array<{ mint: string; addedAtMs: number }>;
    refreshedViewCount: number;
    identityAssetsByAssetId: Record<string, IdentityAssetRow>;
    identityVariantsByAssetId: Record<string, IdentityVariantRow[]>;
    identityMarketsByMint: Record<string, IdentityMarketRow>;
    identitySetCalls: SetAssetIdentityArgs[];
}

function makeRepo(): { repo: SeedRepo; state: RecorderState } {
    const state: RecorderState = {
        upsertedAssets: [],
        upsertedVariants: [],
        upsertedAliases: [],
        ensuredMarkets: [],
        insertedCollections: [],
        insertedCollectionMembers: [],
        memberKeys: new Set(),
        existingMemberCount: 0,
        tombstonedAssetIds: new Set(),
        deletedCollectionSlugs: [],
        deleteCascadeRows: 0,
        tombstonedRefs: new Set(),
        loweredAddedAtCalls: [],
        refreshedViewCount: 0,
        identityAssetsByAssetId: {},
        identityVariantsByAssetId: {},
        identityMarketsByMint: {},
        identitySetCalls: [],
    };
    const repo: SeedRepo = {
        async withTransaction(fn) { await fn(repo); },
        async upsertCanonicalAsset(args) { state.upsertedAssets.push(args); },
        async upsertCanonicalAssetVariant(args) { state.upsertedVariants.push(args); },
        async upsertCanonicalAssetAlias(args) { state.upsertedAliases.push(args); },
        async ensureVariantMarketRow(mint) { state.ensuredMarkets.push(mint); },
        async insertCollectionIfMissing(args) { state.insertedCollections.push(args); },
        async insertCollectionMembersIfMissing(members) {
            let inserted = 0;
            for (const member of members) {
                const key = `${member.collectionSlug}:${member.assetId}`;
                if (state.memberKeys.has(key)) continue;
                state.memberKeys.add(key);
                state.insertedCollectionMembers.push(member);
                inserted += 1;
            }
            return inserted;
        },
        async countCollectionMembers() {
            return state.existingMemberCount + state.insertedCollectionMembers.length;
        },
        async listTombstonedAssetIds(assetIds) {
            return assetIds.filter(id => state.tombstonedAssetIds.has(id));
        },
        async deleteCollectionCascade(slug) {
            state.deletedCollectionSlugs.push(slug);
            return state.deleteCascadeRows;
        },
        async listTombstonedRefs(normalizedRefs) {
            return normalizedRefs.filter(ref => state.tombstonedRefs.has(ref));
        },
        async lowerCollectionMemberAddedAtByMint(mint, addedAtMs) {
            state.loweredAddedAtCalls.push({ mint, addedAtMs });
            return 1;
        },
        async refreshSolanaDefaultVariantsView() { state.refreshedViewCount += 1; },
        async findIdentityAssetsByAssetIds(assetIds) {
            const out: IdentityAssetRow[] = [];
            for (const id of assetIds) {
                const row = state.identityAssetsByAssetId[id];
                if (row) out.push(row);
            }
            return out;
        },
        async findIdentityVariantsByAssetIds(assetIds) {
            const out: IdentityVariantRow[] = [];
            for (const id of assetIds) {
                const list = state.identityVariantsByAssetId[id];
                if (list) out.push(...list);
            }
            return out;
        },
        async findIdentityMarketsByMints(mints) {
            const out: IdentityMarketRow[] = [];
            for (const mint of mints) {
                const row = state.identityMarketsByMint[mint];
                if (row) out.push(row);
            }
            return out;
        },
        async setAssetIdentityFromMintIfMissing(args) { state.identitySetCalls.push(args); },
    };
    return { repo, state };
}

const sampleAsset: CanonicalAsset = {
    assetId: 'jup',
    category: 'token',
    name: 'Jupiter',
    symbol: 'JUP',
    aliases: ['jupiter-aggregator'],
    coingeckoId: 'jupiter-exchange-solana',
    variants: [
        {
            variantId: 'jup:solana:default',
            mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
            kind: 'default',
            trustTier: 'tier1',
            tags: [],
            symbol: 'JUP',
            name: 'Jupiter',
        },
    ],
} as unknown as CanonicalAsset;

describe('buildAssetAliases', () => {
    it('emits aliases for assetId, name, symbol, coingeckoId, free aliases, and variant fields', () => {
        const aliases = buildAssetAliases(sampleAsset);
        const kinds = aliases.map(a => a.kind);
        expect(kinds).toContain('assetId');
        expect(kinds).toContain('name');
        expect(kinds).toContain('symbol');
        expect(kinds).toContain('coingeckoId');
        expect(kinds).toContain('alias');
        expect(kinds).toContain('mint');
        expect(kinds).toContain('variantId');
        const assetIdAlias = aliases.find(a => a.kind === 'assetId');
        expect(assetIdAlias!.normalized).toBe('jup');
        expect(assetIdAlias!.priority).toBe(1000);
    });

    it('dedupes aliases by (kind, normalized)', () => {
        const dupAsset: CanonicalAsset = { ...sampleAsset, aliases: ['JUP', 'jup'] } as unknown as CanonicalAsset;
        const aliases = buildAssetAliases(dupAsset);
        const seen = new Set<string>();
        for (const a of aliases) {
            const key = `${a.kind}:${a.normalized}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });
});

describe('seedCanonicalAssetsRegistry', () => {
    function makeDeps(repo: SeedRepo) {
        return {
            repo,
            now: () => FIXED_NOW,
            listCanonicalAssets: () => [sampleAsset],
        };
    }

    it('upserts assets, variants, aliases, and ensures markets — never touching collections', async () => {
        const { repo, state } = makeRepo();
        const res = await seedCanonicalAssetsRegistry(makeDeps(repo), {});
        expect(res.ok).toBe(true);
        expect(res.assets).toBe(1);
        expect(res.variants).toBe(1);
        expect(state.upsertedAssets.length).toBe(1);
        expect(state.upsertedAssets[0]!.assetId).toBe('jup');
        expect(state.upsertedVariants.length).toBe(1);
        expect(state.ensuredMarkets).toEqual([sampleAsset.variants[0]!.mint]);
        expect(state.upsertedAliases.length).toBeGreaterThan(0);
        expect(state.insertedCollections.length).toBe(0);
        expect(state.insertedCollectionMembers.length).toBe(0);
        expect(state.refreshedViewCount).toBe(1);
    });

    it('skips tombstoned assets entirely (no upsert)', async () => {
        const { repo, state } = makeRepo();
        state.tombstonedRefs.add(sampleAsset.variants[0]!.mint.toLowerCase());
        const res = await seedCanonicalAssetsRegistry(makeDeps(repo), {});
        expect(res.ok).toBe(true);
        expect(res.tombstonedSkipped).toBe(1);
        expect(state.upsertedAssets.length).toBe(0);
        expect(state.upsertedVariants.length).toBe(0);
    });

    it('skips view refresh when not provided', async () => {
        const { repo, state } = makeRepo();
        const repoNoView: SeedRepo = { ...repo };
        delete repoNoView.refreshSolanaDefaultVariantsView;
        await seedCanonicalAssetsRegistry(
            {
                repo: repoNoView,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [],
            },
            {},
        );
        expect(state.refreshedViewCount).toBe(0);
    });
});

interface FixtureCollection {
    slug: string;
    title: string;
    description: string;
    members: Array<{ assetId: string; rank: number; addedAtMs: number }>;
}

const fixture = JSON.parse(
    readFileSync(new URL('../data/curated-collections-seed.json', import.meta.url), 'utf8'),
) as FixtureCollection[];
const fixtureMemberCount = fixture.reduce((sum, c) => sum + c.members.length, 0);

describe('seedCuratedCollectionsFixture', () => {
    it('bootstrap mode refuses to write when curated collections already have members', async () => {
        const { repo, state } = makeRepo();
        state.existingMemberCount = 3;
        const res = await seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, {});
        expect(res.ok).toBe(false);
        expect(res.error).toBe('collections_not_empty');
        expect(res.existingMembers).toBe(3);
        expect(state.insertedCollections.length).toBe(0);
        expect(state.insertedCollectionMembers.length).toBe(0);
    });

    it('recovery mode requires the explicit confirmation string', async () => {
        const { repo, state } = makeRepo();
        await expect(
            seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, { mode: 'recovery' }),
        ).rejects.toThrow(InvalidArgsError);
        await expect(
            seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, { mode: 'recovery', confirm: 'nope' }),
        ).rejects.toThrow(InvalidArgsError);
        expect(state.insertedCollectionMembers.length).toBe(0);
    });

    it('rejects unknown modes', async () => {
        const { repo } = makeRepo();
        await expect(
            seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, { mode: 'yolo' }),
        ).rejects.toThrow(InvalidArgsError);
    });

    it('bootstrap inserts every fixture collection and member into an empty database', async () => {
        const { repo, state } = makeRepo();
        const res = await seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, {});
        expect(res.ok).toBe(true);
        expect(res.mode).toBe('bootstrap');
        expect(res.processed).toBe(fixture.length);
        expect(res.membersInserted).toBe(fixtureMemberCount);
        expect(res.tombstonedSkipped).toBe(0);
        expect(state.insertedCollections.map(c => c.slug)).toEqual([...CURATED_LIST_SLUGS]);
        expect(state.insertedCollectionMembers.length).toBe(fixtureMemberCount);
        const majors = fixture.find(c => c.slug === 'majors')!;
        const insertedMajors = state.insertedCollectionMembers.filter(m => m.collectionSlug === 'majors');
        expect(insertedMajors).toEqual(
            majors.members.map(m => ({
                collectionSlug: 'majors',
                assetId: m.assetId,
                rank: m.rank,
                addedAt: m.addedAtMs,
            })),
        );
    });

    it('skips tombstoned asset ids without inserting their membership rows', async () => {
        const { repo, state } = makeRepo();
        const tombstonedAssetId = fixture[0]!.members[0]!.assetId;
        state.tombstonedAssetIds.add(tombstonedAssetId);
        const occurrences = fixture.reduce(
            (sum, c) => sum + c.members.filter(m => m.assetId === tombstonedAssetId).length,
            0,
        );
        const res = await seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, {});
        expect(res.ok).toBe(true);
        expect(res.tombstonedSkipped).toBe(occurrences);
        expect(res.membersInserted).toBe(fixtureMemberCount - occurrences);
        expect(state.insertedCollectionMembers.some(m => m.assetId === tombstonedAssetId)).toBe(false);
    });

    it('is idempotent: a recovery re-run inserts nothing when all rows already exist', async () => {
        const { repo, state } = makeRepo();
        const first = await seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, {});
        expect(first.ok).toBe(true);
        expect(first.membersInserted).toBe(fixtureMemberCount);
        // A second bootstrap run is refused outright (DB is no longer empty).
        const secondBootstrap = await seedCuratedCollectionsFixture({ repo, now: () => FIXED_NOW }, {});
        expect(secondBootstrap.ok).toBe(false);
        expect(secondBootstrap.error).toBe('collections_not_empty');
        // Recovery with the confirmation string runs, but ON CONFLICT DO NOTHING inserts 0.
        const recovery = await seedCuratedCollectionsFixture(
            { repo, now: () => FIXED_NOW },
            { mode: 'recovery', confirm: 'RESEED_CURATED_COLLECTIONS' },
        );
        expect(recovery.ok).toBe(true);
        expect(recovery.mode).toBe('recovery');
        expect(recovery.membersInserted).toBe(0);
        expect(state.insertedCollectionMembers.length).toBe(fixtureMemberCount);
    });
});

describe('cleanupMaterializedAllCollection', () => {
    it("cascades the materialized 'all' collection and reports rows removed", async () => {
        const { repo, state } = makeRepo();
        state.deleteCascadeRows = 12;
        const res = await cleanupMaterializedAllCollection({ repo, now: () => FIXED_NOW }, {});
        expect(res.ok).toBe(true);
        expect(state.deletedCollectionSlugs).toEqual(['all']);
        expect(res.rowsRemoved).toBe(12);
        expect(res.processed).toBe(12);
    });
});

describe('deriveFallbackSymbol/Name', () => {
    it('uppercases asset symbol when ticker-like', () => {
        const asset: CanonicalAsset = { ...sampleAsset, symbol: 'jup', variants: [] } as unknown as CanonicalAsset;
        expect(deriveFallbackSymbol(asset)).toBe('JUP');
    });

    it('falls back to last assetId segment when symbol is non-ticker and no variant gives a ticker', () => {
        const asset: CanonicalAsset = {
            assetId: 'equity-us-tsla',
            category: 'equity',
            symbol: 'Some Name',
            aliases: [],
            variants: [],
        } as unknown as CanonicalAsset;
        expect(deriveFallbackSymbol(asset)).toBe('TSLA');
    });

    it('uses asset name when set, otherwise falls back to symbol when no variant carries a name', () => {
        const asset: CanonicalAsset = {
            assetId: 'jup',
            category: 'token',
            name: 'Jupiter',
            aliases: [],
            variants: [],
        } as unknown as CanonicalAsset;
        expect(deriveFallbackName(asset, 'JUP')).toBe('Jupiter');
        const nameless: CanonicalAsset = {
            assetId: 'jup',
            category: 'token',
            aliases: [],
            variants: [],
        } as unknown as CanonicalAsset;
        expect(deriveFallbackName(nameless, 'JUP')).toBe('JUP');
    });
});

describe('backfillMissingAssetIdentity', () => {
    it('uses variant_markets symbol/name first when available', async () => {
        const { repo, state } = makeRepo();
        state.identityAssetsByAssetId['jup'] = { assetId: 'jup', category: 'token', symbol: null, name: null };
        state.identityVariantsByAssetId['jup'] = [{
            assetId: 'jup', mint: 'm1', variantId: 'jup:solana:default', trustTier: 'tier1',
            label: null, issuer: null, tags: [],
        }];
        state.identityMarketsByMint['m1'] = { mint: 'm1', symbol: 'JUP', name: 'Jupiter' };
        const res = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
            },
            { delayMs: 0 },
        );
        expect(res.updated).toBe(1);
        expect(state.identitySetCalls.length).toBe(1);
        expect(state.identitySetCalls[0]!).toEqual({ mint: 'm1', symbol: 'JUP', name: 'Jupiter', force: false });
    });

    it('falls back to birdeye when market identity is missing', async () => {
        const { repo, state } = makeRepo();
        state.identityAssetsByAssetId['jup'] = { assetId: 'jup', category: 'token', symbol: null, name: null };
        state.identityVariantsByAssetId['jup'] = [{
            assetId: 'jup', mint: 'm1', variantId: 'jup:solana:default', trustTier: 'tier1',
            label: null, issuer: null, tags: [],
        }];
        const birdeye: BirdeyeIdentityClient = {
            async fetchIdentityByMint() { return { symbol: 'BIRD', name: 'Birdeye Jupiter' }; },
        };
        const res = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
                birdeyeIdentity: birdeye,
            },
            { delayMs: 0 },
        );
        expect(res.updated).toBe(1);
        expect(state.identitySetCalls[0]!.symbol).toBe('BIRD');
        expect(state.identitySetCalls[0]!.name).toBe('Birdeye Jupiter');
    });

    it('falls back to registry-derived symbol/name when no external data', async () => {
        const { repo, state } = makeRepo();
        state.identityAssetsByAssetId['jup'] = { assetId: 'jup', category: 'token', symbol: null, name: null };
        state.identityVariantsByAssetId['jup'] = [{
            assetId: 'jup', mint: 'm1', variantId: 'jup:solana:default', trustTier: 'tier1',
            label: null, issuer: null, tags: [],
        }];
        const res = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
            },
            { delayMs: 0 },
        );
        expect(res.updated).toBe(1);
        expect(state.identitySetCalls[0]!.symbol).toBe('JUP');
        expect(state.identitySetCalls[0]!.name).toBe('Jupiter');
    });

    it('skips assets that already have symbol AND name unless force=true', async () => {
        const { repo, state } = makeRepo();
        state.identityAssetsByAssetId['jup'] = { assetId: 'jup', category: 'token', symbol: 'JUP', name: 'Jupiter' };
        state.identityVariantsByAssetId['jup'] = [{
            assetId: 'jup', mint: 'm1', variantId: 'jup:solana:default', trustTier: 'tier1',
            label: null, issuer: null, tags: [],
        }];
        state.identityMarketsByMint['m1'] = { mint: 'm1', symbol: 'NEW', name: 'New Name' };
        const res = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
            },
            { delayMs: 0 },
        );
        expect(res.skipped).toBe(1);
        expect(res.updated).toBe(0);
        expect(state.identitySetCalls.length).toBe(0);
        const forced = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
            },
            { delayMs: 0, force: true },
        );
        expect(forced.updated).toBe(1);
    });

    it('skips when asset has no variants', async () => {
        const { repo, state } = makeRepo();
        state.identityAssetsByAssetId['jup'] = { assetId: 'jup', category: 'token', symbol: null, name: null };
        const res = await backfillMissingAssetIdentity(
            {
                repo,
                now: () => FIXED_NOW,
                listCanonicalAssets: () => [sampleAsset],
            },
            { delayMs: 0 },
        );
        expect(res.skipped).toBe(1);
        expect(state.identitySetCalls.length).toBe(0);
    });
});
