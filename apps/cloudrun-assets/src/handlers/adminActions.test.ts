import { describe, expect, it } from 'bun:test';

import {
    adminAddCheckedVariant,
    adminCheckVariantMintForCanonical,
    adminRefreshChartData,
    adminSeedAsset,
    availableVariantId,
    cleanTokenName,
    MintConflictError,
    VariantIdConflictError,
    type AdminActionsDeps,
    type AdminActionsRepo,
    type AdminVariantInsert,
    type CheckedVariantPreview,
} from './adminActions';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './assets';
import type {
    AssetAggregateUpsert,
    BirdeyeOverview,
    CronDeps,
    JobsRepo,
    VariantMarketUpsertFromBirdeye,
} from './crons';
import type { MiscCronDeps, MiscJobsRepo } from './crons.misc';
import type {
    CanonicalAssetAliasUpsert,
    CanonicalAssetUpsert,
    CanonicalAssetVariantUpsert,
    SeedRepo,
} from './crons.seed';

const FIXED_NOW = 1_780_000_000_000;

// Mints deliberately absent from the @tokens/asset-registry compiled registry.
const MINT = 'AdminTestMint111111111111111111111111111111';
const MINT2 = 'AdminTestMint211111111111111111111111111111';

const ADMIN = { clerkUserId: 'user_admin' };
const NON_ADMIN = { clerkUserId: 'user_mortal' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['user_admin']);

const OVERVIEW: BirdeyeOverview = {
    symbol: 'WBTC',
    name: 'Wrapped BTC (Wormhole)',
    decimals: 8,
    price: 1.5,
    v24hUSD: 1000,
    liquidity: 500,
};

interface FakeState {
    assetsById?: Record<string, { assetId: string; category: string }>;
    collectionsByAssetId?: Record<string, string[]>;
    adminVariantByMint?: Record<string, { assetId: string; variantId: string }>;
    variantIdsByAssetId?: Record<string, string[]>;
    nextRankBySlug?: Record<string, number>;
    overview?: BirdeyeOverview | null;
    variantInsertConflictsRemaining?: number;
    rollupVariantsByAssetId?: Record<
        string,
        Array<{
            mint: string;
            assetId: string;
            chain: string;
            kind: string;
            trustTier: string;
            liquidity: number;
            volume24hUSD: number;
            lastFetchedAt: number | null;
        }>
    >;
    tokenMarketsFetchThrows?: boolean;
    ohlcvFetchThrows?: boolean;

    createdVariants: AdminVariantInsert[];
    createdVariantMarkets: VariantMarketUpsertFromBirdeye[];
    upsertedVariantMarkets: VariantMarketUpsertFromBirdeye[];
    upsertedMembers: Array<{ collectionSlug: string; assetId: string; rank: number }>;
    upsertedCollections: Array<{ slug: string; title: string }>;
    clearedRefs: string[][];
    aggregateUpserts: AssetAggregateUpsert[];
    seedAssets: CanonicalAssetUpsert[];
    seedVariants: CanonicalAssetVariantUpsert[];
    seedAliases: CanonicalAssetAliasUpsert[];
    seedTransactions: number;
    tokenMarketsFetches: string[];
    birdeyeOhlcvFetches: Array<{ address: string; interval: string }>;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
    return {
        createdVariants: [],
        createdVariantMarkets: [],
        upsertedVariantMarkets: [],
        upsertedMembers: [],
        upsertedCollections: [],
        clearedRefs: [],
        aggregateUpserts: [],
        seedAssets: [],
        seedVariants: [],
        seedAliases: [],
        seedTransactions: 0,
        tokenMarketsFetches: [],
        birdeyeOhlcvFetches: [],
        ...overrides,
    };
}

function makeAdminRepo(state: FakeState): AdminActionsRepo {
    return {
        async findAssetByAssetId(assetId) {
            return state.assetsById?.[assetId] ?? null;
        },
        async listCollectionSlugsForAssetId(assetId) {
            return state.collectionsByAssetId?.[assetId] ?? [];
        },
        async findVariantByMint(mint) {
            return state.adminVariantByMint?.[mint] ?? null;
        },
        async listVariantIdsByAssetId(assetId) {
            return [
                ...(state.variantIdsByAssetId?.[assetId] ?? []),
                ...state.createdVariants.filter(v => v.assetId === assetId).map(v => v.variantId),
            ];
        },
        async createVariantWithMarket(variant, market) {
            const existing = state.adminVariantByMint?.[variant.mint];
            if (existing) throw new MintConflictError(existing.assetId);
            if ((state.variantInsertConflictsRemaining ?? 0) > 0) {
                state.variantInsertConflictsRemaining! -= 1;
                throw new VariantIdConflictError();
            }
            state.createdVariants.push(variant);
            state.createdVariantMarkets.push(market);
        },
        async getNextCategoryRank(slug) {
            return state.nextRankBySlug?.[slug] ?? 0;
        },
        async upsertAssetCollectionMember(args) {
            state.upsertedMembers.push(args);
        },
        async upsertAssetCollectionTitle(slug, title) {
            state.upsertedCollections.push({ slug, title });
        },
        async clearDeletedRefs(refs) {
            state.clearedRefs.push([...refs]);
            return refs.length;
        },
    };
}

function makeSeedRepo(state: FakeState): SeedRepo {
    const repo: SeedRepo = {
        async upsertCanonicalAsset(args) {
            state.seedAssets.push(args);
        },
        async upsertCanonicalAssetVariant(args) {
            state.seedVariants.push(args);
        },
        async upsertCanonicalAssetAlias(args) {
            state.seedAliases.push(args);
        },
        async ensureVariantMarketRow() {},
        async insertCollectionIfMissing() {},
        async insertCollectionMembersIfMissing() {
            return 0;
        },
        async countCollectionMembers() {
            return 0;
        },
        async listTombstonedAssetIds() {
            return [];
        },
        async deleteCollectionCascade() {
            return 0;
        },
        async listTombstonedRefs() {
            return [];
        },
        async lowerCollectionMemberAddedAtByMint() {
            return 0;
        },
        async findIdentityAssetsByAssetIds() {
            return [];
        },
        async findIdentityVariantsByAssetIds() {
            return [];
        },
        async findIdentityMarketsByMints() {
            return [];
        },
        async setAssetIdentityFromMintIfMissing() {},
        async withTransaction(fn) {
            state.seedTransactions += 1;
            await fn(repo);
        },
    };
    return repo;
}

function makeJobsRepo(state: FakeState): JobsRepo {
    return {
        async upsertVariantMarketFromBirdeye(args) {
            state.upsertedVariantMarkets.push(args);
        },
        async touchVariantMarket() {},
        async getOverviewLastFetchedAtByMint() {
            return null;
        },
        async listStaleVariantMints() {
            return [];
        },
        async listCuratedAssetIds() {
            return [];
        },
        async listVariantsForRollup(assetIds) {
            return assetIds.map(assetId => ({
                assetId,
                variants: state.rollupVariantsByAssetId?.[assetId] ?? [],
            }));
        },
        async listVariantLastComputedByAssetIds() {
            return new Map();
        },
        async sumDailyOhlcvVolumeByAddresses() {
            return new Map();
        },
        async upsertAssetAggregate(args) {
            state.aggregateUpserts.push(args);
        },
        async listActiveSanctumLstCount() {
            return 0;
        },
        async listSanctumSourceRanks() {
            return new Map();
        },
        async upsertSanctumLstLatest() {},
        async deactivateMissingSanctumLsts() {
            return 0;
        },
        async findVariantByMint(mint) {
            const v = state.adminVariantByMint?.[mint];
            return v ? { assetId: v.assetId, chain: 'solana' } : null;
        },
        async getAssetRiskLastFetchedAtByMint() {
            return null;
        },
        async upsertAssetRiskLatest() {},
        async findVariantMarketForRiskByMint() {
            return null;
        },
        async upsertWebacyTokenLatest() {},
        async upsertWebacyTradingLiteLatest() {},
        async upsertWebacyHolderAnalysisLatest() {},
        async findRwaXyzAssetLatestByAssetId() {
            return null;
        },
        async findRwaXyzTokenLatestByNetworkAndAddress() {
            return null;
        },
        async upsertRwaXyzAssetLatest() {},
        async upsertRwaXyzTokenLatest() {},
        async listRecentActiveProjects() {
            return [];
        },
        async getRollupStateForProject() {
            return null;
        },
        async tryAcquireRollupLock() {
            return true;
        },
        async releaseRollupLock() {},
        async listProjectEventsForRollup() {
            return [];
        },
        async applyDailyRollupDelta() {},
        async applyEndpointDailyRollupDelta() {},
        async applyRollupBatchAtomic() {
            return true;
        },
        async listAllProjectIds() {
            return [];
        },
        async pruneApiRequestEventsForProject() {
            return 0;
        },
        async getOhlcvBounds() {
            return { minTime: null, maxTime: null };
        },
        async upsertOhlcvCandles(_address, _interval, candles) {
            return { inserted: candles.length, updated: 0, skipped: 0 };
        },
    };
}

function makeCronDeps(state: FakeState): CronDeps {
    return {
        repo: makeJobsRepo(state),
        curated: {
            warmup: async () => {},
            getSnapshot: async () => ({
                loadedAt: 0,
                mintsByList: { majors: [], lsts: [], currencies: [], rwas: [], etfs: [], metals: [], stocks: [] },
                allMints: [],
                entriesByMint: {},
            }),
            getAllCuratedMintsInOrder: () => [],
            getCuratedMintRank: () => new Map(),
            getListSlugsByMint: () => new Map(),
        },
        birdeye: {
            async fetchTokenOverview() {
                return state.overview === undefined ? OVERVIEW : state.overview;
            },
        },
        birdeyeOhlcv: {
            async fetchOhlcv(args) {
                if (state.ohlcvFetchThrows) throw new Error('ohlcv down');
                state.birdeyeOhlcvFetches.push({ address: args.address, interval: args.interval });
                return [];
            },
        },
        sanctum: {
            async fetchAndNormalizeLsts() {
                return { ok: false, reason: 'missing_env' };
            },
        },
        webacy: {
            isConfigured: () => false,
            async fetchAll() {
                return {
                    token: { ok: false, status: 500 },
                    trading: { ok: false, status: 500 },
                    holder: { ok: false, status: 500 },
                };
            },
        },
        now: () => FIXED_NOW,
    };
}

function makeMiscRepo(): MiscJobsRepo {
    return {
        async listStaleTokenAddresses() {
            return [];
        },
        async upsertTokenFromBirdeye() {},
        async getTokenMarketsLastFetchedAtByMint() {
            return null;
        },
        async upsertTokenMarketsLatest() {},
        async touchTokenMarketsLatest() {},
    };
}

function makeMiscDeps(state: FakeState, base: CronDeps): MiscCronDeps {
    return {
        base,
        repo: makeMiscRepo(),
        birdeyeMarkets: {
            async fetchTokenMarkets(args) {
                if (state.tokenMarketsFetchThrows) throw new Error('markets down');
                state.tokenMarketsFetches.push(args.address);
                return [];
            },
        },
    };
}

function makeDeps(state: FakeState): AdminActionsDeps {
    const cron = makeCronDeps(state);
    return {
        adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() },
        repo: makeAdminRepo(state),
        seedRepo: makeSeedRepo(state),
        cron,
        misc: makeMiscDeps(state, cron),
        now: () => FIXED_NOW,
    };
}

function makePreview(overrides: Partial<CheckedVariantPreview> = {}): CheckedVariantPreview {
    return {
        assetId: 'bitcoin',
        mint: MINT,
        checkedAt: FIXED_NOW - 1000,
        conflict: null,
        variantWrite: {
            assetId: 'bitcoin',
            chain: 'solana',
            mint: MINT,
            variantId: 'bitcoin:wbtc',
            kind: 'wrapped',
            trustTier: 'tier3',
            stockVariantTier: 'cash_redeemable',
            tags: ['category:crypto', 'curated:majors'],
            label: 'WBTC',
            isActive: true,
        },
        marketWrite: {
            mint: MINT,
            source: 'birdeye',
            symbol: 'WBTC',
            name: 'BTC',
            decimals: 8,
            logoURI: null,
            price: 1.5,
            priceChange24hPercent: null,
            priceChange1hPercent: null,
            volume24hUSD: 1000,
            liquidity: 500,
            marketCap: null,
            fdv: null,
            holder: null,
            totalSupply: null,
            circulatingSupply: null,
            lastTradeHumanTime: null,
            extensions: null,
            lastFetchedAt: FIXED_NOW - 1000,
        },
        ...overrides,
    };
}

const EXPECTED_SCHEDULED = ['markets', 'ohlcv:15m', 'ohlcv:1H', 'ohlcv:4H', 'ohlcv:1D'];

describe('adminActions authz', () => {
    const calls: Array<[string, (deps: AdminActionsDeps, args: unknown, identity: { clerkUserId: string } | null) => Promise<unknown>, unknown]> = [
        ['adminCheckVariantMintForCanonical', adminCheckVariantMintForCanonical, { assetId: 'bitcoin', mint: MINT }],
        ['adminAddCheckedVariant', adminAddCheckedVariant, { checkedPreview: makePreview(), overrides: {} }],
        ['adminSeedAsset', adminSeedAsset, { mint: MINT }],
        ['adminRefreshChartData', adminRefreshChartData, { mint: MINT }],
    ];

    for (const [name, handler, args] of calls) {
        it(`${name} rejects a missing identity with IdentityRequiredError`, async () => {
            const deps = makeDeps(makeState());
            await expect(handler(deps, args, null)).rejects.toBeInstanceOf(IdentityRequiredError);
        });

        it(`${name} rejects a non-admin identity with UnauthorizedError`, async () => {
            const deps = makeDeps(makeState());
            await expect(handler(deps, args, NON_ADMIN)).rejects.toBeInstanceOf(UnauthorizedError);
        });
    }

    it('rejects every caller when the allowlist is empty', async () => {
        const deps = { ...makeDeps(makeState()), adminAllowlist: { clerkUserIds: new Set<string>(), emails: new Set<string>() } };
        await expect(adminRefreshChartData(deps, { mint: MINT }, ADMIN)).rejects.toBeInstanceOf(UnauthorizedError);
    });
});

describe('adminCheckVariantMintForCanonical', () => {
    it('rejects an invalid mint', async () => {
        const state = makeState({ assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } } });
        await expect(
            adminCheckVariantMintForCanonical(makeDeps(state), { assetId: 'bitcoin', mint: 'not-a-mint' }, ADMIN),
        ).rejects.toThrow('Not a valid Solana mint address');
    });

    it('rejects when the canonical asset does not exist', async () => {
        await expect(
            adminCheckVariantMintForCanonical(makeDeps(makeState()), { assetId: 'bitcoin', mint: MINT }, ADMIN),
        ).rejects.toThrow('Canonical asset not found');
    });

    it('builds a preview without writing to the DB', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            collectionsByAssetId: { bitcoin: ['majors', 'not-a-curated-slug'] },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'bitcoin', mint: MINT },
            ADMIN,
        );

        expect(preview.assetId).toBe('bitcoin');
        expect(preview.mint).toBe(MINT);
        expect(preview.checkedAt).toBe(FIXED_NOW);
        expect(preview.conflict).toBeNull();
        expect(preview.variantWrite.variantId).toBe(`bitcoin:${MINT.slice(0, 8).toLowerCase()}`);
        expect(preview.variantWrite.kind).toBe('wrapped');
        expect(preview.variantWrite.trustTier).toBe('tier3');
        expect(preview.variantWrite.label).toBe('WBTC');
        expect(preview.variantWrite.tags).toEqual(['category:crypto', 'curated:majors']);
        // Birdeye name gets normalized ("Wrapped BTC (Wormhole)" → "BTC").
        expect(preview.marketWrite.name).toBe('BTC');
        expect(preview.marketWrite.symbol).toBe('WBTC');
        expect(preview.marketWrite.price).toBe(1.5);
        expect(preview.marketWrite.marketCap).toBeNull();
        expect(preview.marketWrite.lastFetchedAt).toBe(FIXED_NOW);

        // Preview only: nothing written, no warms.
        expect(state.createdVariants).toEqual([]);
        expect(state.upsertedVariantMarkets).toEqual([]);
        expect(state.tokenMarketsFetches).toEqual([]);
        expect(state.birdeyeOhlcvFetches).toEqual([]);
    });

    it('reports a same_canonical conflict', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            adminVariantByMint: { [MINT]: { assetId: 'bitcoin', variantId: 'bitcoin:existing' } },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'bitcoin', mint: MINT },
            ADMIN,
        );
        expect(preview.conflict).toEqual({
            type: 'same_canonical',
            assetId: 'bitcoin',
            variantId: 'bitcoin:existing',
        });
    });

    it('reports an other_canonical conflict', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            adminVariantByMint: { [MINT]: { assetId: 'ethereum', variantId: 'ethereum:weth' } },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'bitcoin', mint: MINT },
            ADMIN,
        );
        expect(preview.conflict).toEqual({
            type: 'other_canonical',
            assetId: 'ethereum',
            variantId: 'ethereum:weth',
        });
    });

    it('falls back to the next preferred suffix when the mint-based id is taken', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            variantIdsByAssetId: { bitcoin: [`bitcoin:${MINT.slice(0, 8).toLowerCase()}`] },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'bitcoin', mint: MINT },
            ADMIN,
        );
        expect(preview.variantWrite.variantId).toBe('bitcoin:wbtc');
    });

    it('appends a numeric suffix when every preferred candidate is taken', async () => {
        const mintSuffix = MINT.slice(0, 8).toLowerCase();
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            variantIdsByAssetId: {
                bitcoin: [`bitcoin:${mintSuffix}`, 'bitcoin:wbtc', 'bitcoin:btc', 'bitcoin:mint'],
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'bitcoin', mint: MINT },
            ADMIN,
        );
        expect(preview.variantWrite.variantId).toBe(`bitcoin:${mintSuffix}-2`);
    });
});

describe('adminAddCheckedVariant', () => {
    it('rejects a same_canonical conflict with the Convex message', async () => {
        const preview = makePreview({
            conflict: { type: 'same_canonical', assetId: 'bitcoin', variantId: 'bitcoin:x' },
        });
        await expect(
            adminAddCheckedVariant(makeDeps(makeState()), { checkedPreview: preview, overrides: {} }, ADMIN),
        ).rejects.toThrow('This mint is already attached to this canonical.');
    });

    it('rejects an other_canonical conflict with the Convex message', async () => {
        const preview = makePreview({
            conflict: { type: 'other_canonical', assetId: 'ethereum', variantId: 'ethereum:weth' },
        });
        await expect(
            adminAddCheckedVariant(makeDeps(makeState()), { checkedPreview: preview, overrides: {} }, ADMIN),
        ).rejects.toThrow('This mint already belongs to ethereum. Use Move variant to reassign it.');
    });

    it('rejects when the mint got attached after the check', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            adminVariantByMint: { [MINT]: { assetId: 'ethereum', variantId: 'ethereum:weth' } },
        });
        await expect(
            adminAddCheckedVariant(makeDeps(state), { checkedPreview: makePreview(), overrides: {} }, ADMIN),
        ).rejects.toThrow('Mint already belongs to ethereum');
    });

    it('rejects when the market mint does not match the variant mint', async () => {
        const preview = makePreview();
        preview.marketWrite = { ...preview.marketWrite, mint: MINT2 };
        await expect(
            adminAddCheckedVariant(makeDeps(makeState()), { checkedPreview: preview, overrides: {} }, ADMIN),
        ).rejects.toThrow('Checked market mint does not match variant mint');
    });

    it('inserts the variant, applies overrides, and awaits the chart warms', async () => {
        const state = makeState({ assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } } });
        const result = await adminAddCheckedVariant(
            makeDeps(state),
            {
                checkedPreview: makePreview(),
                overrides: {
                    label: 'Custom Label',
                    trustTier: 'tier1',
                    tags: ['a', 'a', 'b'],
                    stockVariantTier: null,
                },
            },
            ADMIN,
        );

        expect(result).toEqual({ assetId: 'bitcoin', mint: MINT, variantId: 'bitcoin:wbtc', scheduled: EXPECTED_SCHEDULED });

        expect(state.createdVariants).toHaveLength(1);
        const created = state.createdVariants[0]!;
        expect(created.label).toBe('Custom Label');
        expect(created.trustTier).toBe('tier1');
        expect(created.tags).toEqual(['a', 'b']);
        // stockVariantTier: null override clears the preview's value.
        expect(created.stockVariantTier).toBeUndefined();
        expect(created.isActive).toBe(true);

        expect(state.createdVariantMarkets).toHaveLength(1);
        expect(state.createdVariantMarkets[0]!.mint).toBe(MINT);
        expect(state.createdVariantMarkets[0]!.marketCap).toBeUndefined();
        expect(state.createdVariantMarkets[0]!.price).toBe(1.5);

        // Asset aggregate rollup (port of refreshAssetMarket) ran for the canonical.
        expect(state.aggregateUpserts.map(u => u.assetId)).toEqual(['bitcoin']);

        // Chart warms hit the right mint: markets once, OHLCV per interval.
        expect(state.tokenMarketsFetches).toEqual([MINT]);
        expect(state.birdeyeOhlcvFetches.map(f => f.interval)).toEqual(['15m', '1H', '4H', '1D']);
        expect(new Set(state.birdeyeOhlcvFetches.map(f => f.address))).toEqual(new Set([MINT]));
    });

    it('keeps the preview values when no overrides are provided', async () => {
        const state = makeState({ assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } } });
        await adminAddCheckedVariant(makeDeps(state), { checkedPreview: makePreview(), overrides: {} }, ADMIN);
        const created = state.createdVariants[0]!;
        expect(created.label).toBe('WBTC');
        expect(created.trustTier).toBe('tier3');
        expect(created.stockVariantTier).toBe('cash_redeemable');
        expect(created.tags).toEqual(['category:crypto', 'curated:majors']);
    });

    it('retries with the next suffix on a variantId unique violation', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            variantIdsByAssetId: { bitcoin: ['bitcoin:wbtc'] },
            variantInsertConflictsRemaining: 1,
        });
        const result = await adminAddCheckedVariant(
            makeDeps(state),
            { checkedPreview: makePreview(), overrides: {} },
            ADMIN,
        );
        expect(result.variantId).toBe('bitcoin:wbtc-2');
        expect(state.createdVariants[0]!.variantId).toBe('bitcoin:wbtc-2');
    });

    it('gives up with the Convex message when the unique violation persists', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            variantInsertConflictsRemaining: 100,
        });
        await expect(
            adminAddCheckedVariant(makeDeps(state), { checkedPreview: makePreview(), overrides: {} }, ADMIN),
        ).rejects.toThrow('variantId already exists for this canonical asset');
        expect(state.createdVariants).toEqual([]);
    });
});

describe('adminSeedAsset', () => {
    it('rejects an invalid mint', async () => {
        await expect(adminSeedAsset(makeDeps(makeState()), { mint: 'nope' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });

    it('seeds a new asset into a curated category', async () => {
        const state = makeState({ nextRankBySlug: { stocks: 5 } });
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT, slug: 'stocks' }, ADMIN);

        const assetId = `solana-${MINT}`;
        expect(result).toEqual({ assetId, mint: MINT, slug: 'stocks', rank: 5, seededAt: FIXED_NOW });

        expect(state.upsertedCollections).toEqual([{ slug: 'stocks', title: 'Stocks' }]);
        expect(state.seedTransactions).toBe(1);

        expect(state.seedAssets).toHaveLength(1);
        expect(state.seedAssets[0]!.assetId).toBe(assetId);
        expect(state.seedAssets[0]!.category).toBe('equity');
        expect(state.seedAssets[0]!.aliases).toEqual([assetId, MINT]);
        expect(state.seedAssets[0]!.isActive).toBe(true);

        expect(state.seedVariants).toHaveLength(1);
        expect(state.seedVariants[0]!.variantId).toBe(`${assetId}:mint`);
        expect(state.seedVariants[0]!.kind).toBe('tokenized_equity');
        expect(state.seedVariants[0]!.trustTier).toBe('tier3');
        expect(state.seedVariants[0]!.tags).toEqual(['curated:stocks']);

        // Tombstones cleared for all normalized refs.
        expect(state.clearedRefs).toHaveLength(1);
        expect(state.clearedRefs[0]).toContain(assetId.toLowerCase());
        expect(state.clearedRefs[0]).toContain(MINT.toLowerCase());
        expect(state.clearedRefs[0]).toContain(`solana-${MINT}`.toLowerCase());

        // Birdeye market snapshot written with the cleaned name.
        expect(state.upsertedVariantMarkets).toHaveLength(1);
        expect(state.upsertedVariantMarkets[0]!.mint).toBe(MINT);
        expect(state.upsertedVariantMarkets[0]!.name).toBe('BTC');
        expect(state.upsertedVariantMarkets[0]!.lastFetchedAt).toBe(FIXED_NOW);

        // Aggregate rollup + aliases + membership.
        expect(state.aggregateUpserts.map(u => u.assetId)).toEqual([assetId]);
        const aliasKinds = state.seedAliases.map(a => a.kind);
        expect(aliasKinds).toContain('assetId');
        expect(aliasKinds).toContain('name');
        expect(aliasKinds).toContain('symbol');
        expect(aliasKinds).toContain('mint');
        expect(aliasKinds).toContain('variantId');
        expect(state.seedAliases.find(a => a.kind === 'symbol')!.alias).toBe('WBTC');
        expect(state.upsertedMembers).toEqual([{ collectionSlug: 'stocks', assetId, rank: 5 }]);

        // Chart warms awaited.
        expect(state.tokenMarketsFetches).toEqual([MINT]);
        expect(state.birdeyeOhlcvFetches.map(f => f.interval)).toEqual(['15m', '1H', '4H', '1D']);
    });

    it('seeds without a slug using seeded:admin tags and no collection writes', async () => {
        const state = makeState();
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT }, ADMIN);

        expect(result).toEqual({ assetId: `solana-${MINT}`, mint: MINT, seededAt: FIXED_NOW });
        expect(state.seedAssets[0]!.category).toBe('crypto');
        expect(state.seedVariants[0]!.kind).toBe('wrapped');
        expect(state.seedVariants[0]!.tags).toEqual(['seeded:admin']);
        expect(state.upsertedCollections).toEqual([]);
        expect(state.upsertedMembers).toEqual([]);
    });

    it('honors an explicit assetId override', async () => {
        const state = makeState();
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT, assetId: 'my-asset' }, ADMIN);
        expect(result.assetId).toBe('my-asset');
        expect(state.seedVariants[0]!.variantId).toBe('my-asset:mint');
    });

    it('reuses the existing canonical when the mint is already seeded', async () => {
        const state = makeState({
            adminVariantByMint: { [MINT]: { assetId: 'bitcoin', variantId: 'bitcoin:wbtc' } },
        });
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT }, ADMIN);
        expect(result.assetId).toBe('bitcoin');
    });

    it('adds membership additively when the asset is already in another curated category', async () => {
        const state = makeState({
            collectionsByAssetId: { [`solana-${MINT}`]: ['majors'] },
        });
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT, slug: 'stocks' }, ADMIN);
        expect(result.assetId).toBe(`solana-${MINT}`);
        expect(state.upsertedMembers).toEqual([
            expect.objectContaining({ collectionSlug: 'stocks', assetId: `solana-${MINT}` }),
        ]);
    });

    it('rejects when Birdeye has no symbol', async () => {
        const state = makeState({ overview: { name: 'Something', decimals: 6 } });
        await expect(adminSeedAsset(makeDeps(state), { mint: MINT }, ADMIN)).rejects.toThrow(
            'Missing symbol from Birdeye',
        );
    });
});

describe('adminRefreshChartData', () => {
    it('rejects an invalid mint', async () => {
        await expect(adminRefreshChartData(makeDeps(makeState()), { mint: 'zzz' }, ADMIN)).rejects.toThrow(
            'Not a valid Solana mint address',
        );
    });

    it('rejects a mint that is not seeded yet', async () => {
        await expect(adminRefreshChartData(makeDeps(makeState()), { mint: MINT }, ADMIN)).rejects.toThrow(
            'Mint is not seeded yet',
        );
    });

    it('awaits the markets + OHLCV warms for the mint', async () => {
        const state = makeState({
            adminVariantByMint: { [MINT]: { assetId: 'bitcoin', variantId: 'bitcoin:wbtc' } },
        });
        const result = await adminRefreshChartData(makeDeps(state), { mint: MINT }, ADMIN);

        expect(result).toEqual({ mint: MINT, scheduled: EXPECTED_SCHEDULED });
        expect(state.tokenMarketsFetches).toEqual([MINT]);
        expect(state.birdeyeOhlcvFetches).toEqual([
            { address: MINT, interval: '15m' },
            { address: MINT, interval: '1H' },
            { address: MINT, interval: '4H' },
            { address: MINT, interval: '1D' },
        ]);
    });

    it('still reports the scheduled warms when the upstream fetches fail', async () => {
        const state = makeState({
            adminVariantByMint: { [MINT]: { assetId: 'bitcoin', variantId: 'bitcoin:wbtc' } },
            tokenMarketsFetchThrows: true,
            ohlcvFetchThrows: true,
        });
        const result = await adminRefreshChartData(makeDeps(state), { mint: MINT }, ADMIN);
        expect(result.scheduled).toEqual(EXPECTED_SCHEDULED);
    });
});

describe('helpers', () => {
    it('availableVariantId walks preferred suffixes then numeric suffixes', () => {
        expect(availableVariantId(new Set(), 'btc', ['AbCd-123', 'WBTC'])).toBe('btc:abcd-123');
        expect(availableVariantId(new Set(['btc:abcd-123']), 'btc', ['AbCd-123', 'WBTC'])).toBe('btc:wbtc');
        expect(availableVariantId(new Set(['btc:abcd-123', 'btc:wbtc']), 'btc', ['AbCd-123', 'WBTC'])).toBe(
            'btc:abcd-123-2',
        );
        expect(availableVariantId(new Set(), 'btc', ['***'])).toBe('btc:mint');
    });

    it('cleanTokenName strips bridge and wrapper markers', () => {
        expect(cleanTokenName('Wrapped BTC (Wormhole)')).toBe('BTC');
        expect(cleanTokenName('Tesla xStock')).toBe('Tesla');
        expect(cleanTokenName('Coinbase Wrapped BTC')).toBe('BTC');
        expect(cleanTokenName(undefined)).toBe('Unknown');
    });
});
