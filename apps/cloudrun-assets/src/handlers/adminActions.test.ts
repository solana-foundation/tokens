import { describe, expect, it } from 'bun:test';

import {
    adminAddCheckedVariant,
    adminCheckVariantMintForCanonical,
    adminRefreshChartData,
    adminRefreshV2VariantMarket,
    adminSeedAsset,
    adminSyncV2SolanaVariants,
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
import type {
    V2AdminVariantUpsert,
    V2AssetsCronDeps,
    V2AssetsJobsRepo,
    V2CoinPlatformsRow,
    V2VariantMarketUpsert,
} from './crons.v2Assets';
import type { V2AssetsReadsRepo, V2VariantDbRow } from './v2AssetsReads';

const FIXED_NOW = 1_780_000_000_000;

// Mints deliberately absent from the @tokens/asset-registry compiled registry.
const MINT = 'AdminTestMint111111111111111111111111111111';
const MINT2 = 'AdminTestMint211111111111111111111111111111';
const USDC_ETH_MIXED = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ETH = USDC_ETH_MIXED.toLowerCase();

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
    assetsById?: Record<string, { assetId: string; category: string; coingeckoId?: string | null }>;
    /** v2 rows keyed `<chain>:<address>` (owner lookups for EVM checks). */
    v2RowsByKey?: Record<string, V2VariantDbRow[]>;
    coinPlatformsById?: Record<string, V2CoinPlatformsRow>;
    /** Per-chain Birdeye overview; absent chain = no client; null = Birdeye had nothing. */
    evmOverviewByChain?: Partial<Record<string, BirdeyeOverview | null>>;
    mirrorThrows?: boolean;
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
    mirrorRuns: number[];
    adminVariantUpserts: V2AdminVariantUpsert[];
    v2MarketUpserts: V2VariantMarketUpsert[];
    v2MarketUpsertOptions: Array<{ onlyIfNewer?: boolean } | undefined>;
    v2Touches: Array<{ chain: string; address: string }>;
    v2DecimalsSets: Array<{ chain: string; address: string; decimals: number }>;
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
        mirrorRuns: [],
        adminVariantUpserts: [],
        v2MarketUpserts: [],
        v2MarketUpsertOptions: [],
        v2Touches: [],
        v2DecimalsSets: [],
        ...overrides,
    };
}

function makeAdminRepo(state: FakeState): AdminActionsRepo {
    return {
        async findAssetByAssetId(assetId) {
            const asset = state.assetsById?.[assetId];
            return asset ? { assetId: asset.assetId, category: asset.category, coingeckoId: asset.coingeckoId ?? null } : null;
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
        async ensureAssetCollection(slug, title) {
            // Mirrors the repo's INSERT ... ON CONFLICT (slug) DO NOTHING:
            // an existing row keeps its admin-owned title.
            if (state.upsertedCollections.some(c => c.slug === slug)) return;
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
        async listAssetIdRenames() {
            return [];
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
        async upsertTokenFromBirdeye() {},
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
        async listStaleOhlcvMints() {
            return [];
        },
        async touchOhlcvRefreshState() {},
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

function makeV2JobsRepo(state: FakeState): V2AssetsJobsRepo {
    return {
        async mirrorSolanaVariants(nowMs) {
            if (state.mirrorThrows) throw new Error('mirror down');
            state.mirrorRuns.push(nowMs);
            return { inserted: 1, updated: 0, replaced: 0 };
        },
        async deactivateUnseenSolanaVariants() {
            return 0;
        },
        async mirrorSolanaMarkets() {
            return 1;
        },
        async mirrorSolanaRollups() {
            return 1;
        },
        async resolveVariantCoinIds() {
            return {};
        },
        async listAssetCoinSources() {
            return [];
        },
        async listActiveAssets() {
            return [];
        },
        async findCoinPlatformsByCoinIds(coinIds) {
            return coinIds.flatMap(id => {
                const row = state.coinPlatformsById?.[id];
                return row ? [row] : [];
            });
        },
        async listDerivedVariants() {
            return [];
        },
        async upsertDerivedVariant() {
            return 'inserted';
        },
        async upsertAdminVariant(args) {
            state.adminVariantUpserts.push(args);
            const existing = state.v2RowsByKey?.[`${args.chain}:${args.address}`]?.find(
                row => row.asset_id === args.assetId,
            );
            if (!existing) return 'inserted';
            return existing.origin === 'admin' ? 'updated' : 'adopted';
        },
        async deactivateDerivedVariants() {
            return 0;
        },
        async listStaleActiveVariantsByChains() {
            return [];
        },
        async upsertVariantMarketFromBirdeye(args, options) {
            state.v2MarketUpserts.push(args);
            state.v2MarketUpsertOptions.push(options);
        },
        async touchVariantMarket(chain, address) {
            state.v2Touches.push({ chain, address });
        },
        async setVariantDecimalsIfNull(chain, address, decimals) {
            state.v2DecimalsSets.push({ chain, address, decimals });
        },
        async rollupChainVolume30d() {
            return { assetsWritten: 0, rowsWritten: 0 };
        },
        async pruneVolumeDaily() {
            return 0;
        },
    };
}

function makeV2Deps(state: FakeState): V2AssetsCronDeps {
    const birdeyeByChain: V2AssetsCronDeps['birdeyeByChain'] = {};
    for (const [chain, overview] of Object.entries(state.evmOverviewByChain ?? {})) {
        birdeyeByChain[chain as keyof V2AssetsCronDeps['birdeyeByChain']] = {
            async fetchTokenOverview() {
                return overview ?? null;
            },
        };
    }
    return { repo: makeV2JobsRepo(state), birdeyeByChain, now: () => FIXED_NOW };
}

function makeV2Reads(state: FakeState): V2AssetsReadsRepo {
    return {
        async chainSummary() {
            return [];
        },
        async findVariantsByAssetIds() {
            return [];
        },
        async findVariantsByKey(chain, address) {
            return state.v2RowsByKey?.[`${chain}:${address}`] ?? [];
        },
        async findVariantsByKeys() {
            return [];
        },
        async findMarketsByKeys() {
            return [];
        },
        async findRollupsByAssetIds() {
            return [];
        },
    };
}

function v2Row(overrides: Partial<V2VariantDbRow> & { asset_id: string }): V2VariantDbRow {
    return {
        chain: 'ethereum',
        address: USDC_ETH,
        variant_id: `ethereum:${USDC_ETH}`,
        kind: 'stablecoin',
        trust_tier: 'tier3',
        stock_variant_tier: null,
        tags: ['coingecko-derived'],
        label: 'USDC',
        issuer: null,
        issuer_url: null,
        decimals: 6,
        origin: 'coingecko',
        source: 'coingecko',
        is_active: true,
        ...overrides,
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
        v2: makeV2Deps(state),
        v2Reads: makeV2Reads(state),
        now: () => FIXED_NOW,
    };
}

function makePreview(overrides: Partial<CheckedVariantPreview> = {}): CheckedVariantPreview {
    return {
        assetId: 'bitcoin',
        chain: 'solana',
        address: MINT,
        mint: MINT,
        checkedAt: FIXED_NOW - 1000,
        conflict: null,
        decimalsSource: 'birdeye',
        variantWrite: {
            assetId: 'bitcoin',
            chain: 'solana',
            address: MINT,
            mint: MINT,
            variantId: 'bitcoin:wbtc',
            kind: 'wrapped',
            trustTier: 'tier3',
            stockVariantTier: 'cash_redeemable',
            tags: ['category:crypto', 'curated:majors'],
            label: 'WBTC',
            isActive: true,
            decimals: 8,
        },
        marketWrite: {
            chain: 'solana',
            address: MINT,
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
        expect(preview.chain).toBe('solana');
        expect(preview.address).toBe(MINT);
        expect(preview.decimalsSource).toBe('birdeye');
        expect(preview.variantWrite.decimals).toBe(8);
        expect(preview.marketWrite!.name).toBe('BTC');
        expect(preview.marketWrite!.symbol).toBe('WBTC');
        expect(preview.marketWrite!.price).toBe(1.5);
        expect(preview.marketWrite!.marketCap).toBeNull();
        expect(preview.marketWrite!.lastFetchedAt).toBe(FIXED_NOW);

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
            origin: 'v1',
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
            conflict: { type: 'same_canonical', assetId: 'bitcoin', variantId: 'bitcoin:x', origin: 'v1' },
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
        preview.marketWrite = { ...preview.marketWrite!, address: MINT2, mint: MINT2 };
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

        expect(result).toEqual({
            assetId: 'bitcoin',
            chain: 'solana',
            address: MINT,
            mint: MINT,
            variantId: 'bitcoin:wbtc',
            scheduled: EXPECTED_SCHEDULED,
            v2Synced: true,
            adopted: false,
        });
        // The v2 Solana mirror ran inline, after the v1 write.
        expect(state.mirrorRuns).toEqual([FIXED_NOW]);

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
        expect(result).toEqual({ assetId, mint: MINT, slug: 'stocks', rank: 5, seededAt: FIXED_NOW, v2Synced: true });
        expect(state.mirrorRuns).toEqual([FIXED_NOW]);

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

    it('uses the public list vocabulary, not admin-only names', async () => {
        // `asset_collections.title` is what /api/v2/lists and
        // /api/v1/assets/curated/lists serve, so the seed must not write the
        // old admin-internal names ("Majors"/"RWAs") into the public column.
        const majors = makeState();
        await adminSeedAsset(makeDeps(majors), { mint: MINT, slug: 'majors' }, ADMIN);
        expect(majors.upsertedCollections).toEqual([{ slug: 'majors', title: 'Crypto' }]);

        const rwas = makeState();
        await adminSeedAsset(makeDeps(rwas), { mint: MINT, slug: 'rwas' }, ADMIN);
        expect(rwas.upsertedCollections).toEqual([{ slug: 'rwas', title: 'Treasuries' }]);
    });

    it('never rewrites an existing list title (ensureAssetCollection is insert-if-missing)', async () => {
        // Regression: this used to be an unconditional upsert, so seeding a
        // token reverted any admin-edited title on the next add.
        const state = makeState();
        state.upsertedCollections.push({ slug: 'stocks', title: 'Tokenized Equities' });

        await adminSeedAsset(makeDeps(state), { mint: MINT, slug: 'stocks' }, ADMIN);

        expect(state.upsertedCollections).toEqual([{ slug: 'stocks', title: 'Tokenized Equities' }]);
    });

    it('seeds without a slug using seeded:admin tags and no collection writes', async () => {
        const state = makeState();
        const result = await adminSeedAsset(makeDeps(state), { mint: MINT }, ADMIN);

        expect(result).toEqual({ assetId: `solana-${MINT}`, mint: MINT, seededAt: FIXED_NOW, v2Synced: true });
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

describe('v2 mirror after Solana admin writes', () => {
    it('reports v2Synced:false and still succeeds when the mirror throws', async () => {
        const state = makeState({
            assetsById: { bitcoin: { assetId: 'bitcoin', category: 'crypto' } },
            mirrorThrows: true,
        });
        const result = await adminAddCheckedVariant(
            makeDeps(state),
            { checkedPreview: makePreview(), overrides: {} },
            ADMIN,
        );
        expect(result.v2Synced).toBe(false);
        expect(state.createdVariants).toHaveLength(1);
        expect(state.mirrorRuns).toEqual([]);
        // Chart warms still ran.
        expect(state.tokenMarketsFetches).toEqual([MINT]);
    });

    it('adminSyncV2SolanaVariants runs the mirror on demand', async () => {
        const state = makeState();
        const result = await adminSyncV2SolanaVariants(makeDeps(state), {}, ADMIN);
        expect(result.ok).toBe(true);
        expect(state.mirrorRuns).toEqual([FIXED_NOW]);
    });

    it('adminSyncV2SolanaVariants requires an admin', async () => {
        await expect(adminSyncV2SolanaVariants(makeDeps(makeState()), {}, NON_ADMIN)).rejects.toBeInstanceOf(
            UnauthorizedError,
        );
    });
});

describe('adminCheckVariantMintForCanonical (EVM)', () => {
    const USDC_OVERVIEW: BirdeyeOverview = {
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        price: 1,
        liquidity: 1_000_000,
    };

    it('rejects an address that is not valid for the chain', async () => {
        const state = makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } });
        await expect(
            adminCheckVariantMintForCanonical(makeDeps(state), { assetId: 'usdc', chain: 'ethereum', address: MINT }, ADMIN),
        ).rejects.toThrow('Not a valid Ethereum contract address');
    });

    it('rejects an unknown chain', async () => {
        await expect(
            adminCheckVariantMintForCanonical(makeDeps(makeState()), { assetId: 'usdc', chain: 'tron', address: USDC_ETH }, ADMIN),
        ).rejects.toThrow('chain must be one of');
    });

    it('rejects the EIP-7528 native address', async () => {
        const state = makeState({ assetsById: { ethereum: { assetId: 'ethereum', category: 'crypto' } } });
        await expect(
            adminCheckVariantMintForCanonical(
                makeDeps(state),
                { assetId: 'ethereum', chain: 'ethereum', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' },
                ADMIN,
            ),
        ).rejects.toThrow('native coin address');
    });

    it('lowercases the address, takes decimals from Birdeye, and builds a v2 market write', async () => {
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } },
            collectionsByAssetId: { usdc: ['currencies'] },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'usdc', chain: 'ethereum', address: USDC_ETH_MIXED },
            ADMIN,
        );
        expect(preview.chain).toBe('ethereum');
        expect(preview.address).toBe(USDC_ETH);
        expect(preview.mint).toBe(USDC_ETH);
        expect(preview.conflict).toBeNull();
        expect(preview.decimalsSource).toBe('birdeye');
        expect(preview.variantWrite).toMatchObject({
            chain: 'ethereum',
            address: USDC_ETH,
            variantId: `ethereum:${USDC_ETH}`,
            kind: 'stablecoin',
            trustTier: 'tier3',
            tags: ['category:stablecoin', 'curated:currencies'],
            label: 'USDC',
            decimals: 6,
        });
        expect(preview.marketWrite).toMatchObject({
            chain: 'ethereum',
            address: USDC_ETH,
            mint: USDC_ETH,
            source: 'birdeye',
            symbol: 'USDC',
            decimals: 6,
            price: 1,
            lastFetchedAt: FIXED_NOW,
        });
        // Nothing written by the check.
        expect(state.adminVariantUpserts).toEqual([]);
        expect(state.v2MarketUpserts).toEqual([]);
    });

    it('does not default decimals to 9 when Birdeye omits them; falls back to CoinGecko detail_platforms', async () => {
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin', coingeckoId: 'usd-coin' } },
            evmOverviewByChain: { ethereum: { symbol: 'USDC', name: 'USD Coin', price: 1 } },
            coinPlatformsById: {
                'usd-coin': {
                    coinId: 'usd-coin',
                    symbol: 'usdc',
                    platforms: { ethereum: USDC_ETH, solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
                    decimalsByPlatform: { ethereum: 6 },
                    assetPlatformId: null,
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'usdc', chain: 'ethereum', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.decimalsSource).toBe('coingecko');
        expect(preview.variantWrite.decimals).toBe(6);
        expect(preview.marketWrite!.decimals).toBeNull();
    });

    it('returns a null market and null decimals when the chain has no Birdeye client and no CoinGecko data', async () => {
        const state = makeState({
            assetsById: { wbtc: { assetId: 'wbtc', category: 'crypto', coingeckoId: 'wrapped-bitcoin' } },
            coinPlatformsById: {
                'wrapped-bitcoin': {
                    coinId: 'wrapped-bitcoin',
                    symbol: 'wbtc',
                    platforms: { ethereum: USDC_ETH, base: USDC_ETH },
                    decimalsByPlatform: {},
                    assetPlatformId: null,
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'wbtc', chain: 'base', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.marketWrite).toBeNull();
        expect(preview.decimalsSource).toBeNull();
        expect(preview.variantWrite.decimals).toBeNull();
        // Label falls back to the CoinGecko symbol (the coin's base deployment IS
        // this address); kind derives from the platforms map (two non-Solana
        // deployments → spot).
        expect(preview.variantWrite.label).toBe('WBTC');
        expect(preview.variantWrite.kind).toBe('spot');
    });

    it('ignores CoinGecko decimals/symbol when the coin deploys a DIFFERENT contract on this chain', async () => {
        const other = '0x2222222222222222222222222222222222222222';
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin', coingeckoId: 'usd-coin' } },
            // Birdeye answers but without decimals, so the fallback would be consulted.
            evmOverviewByChain: { ethereum: { symbol: 'USDC.e', name: 'Bridged USDC', price: 1 } },
            coinPlatformsById: {
                'usd-coin': {
                    coinId: 'usd-coin',
                    symbol: 'usdc',
                    platforms: { ethereum: USDC_ETH },
                    decimalsByPlatform: { ethereum: 6 },
                    assetPlatformId: null,
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'usdc', chain: 'ethereum', address: other },
            ADMIN,
        );
        // A different wrapper must not inherit the canonical deployment's decimals.
        expect(preview.decimalsSource).toBeNull();
        expect(preview.variantWrite.decimals).toBeNull();
        expect(preview.variantWrite.label).toBe('USDC.e');
    });

    it('reports same_canonical with the row origin (adopt) and keeps its variant id', async () => {
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
            v2RowsByKey: { [`ethereum:${USDC_ETH}`]: [v2Row({ asset_id: 'usdc', variant_id: 'usdc:eth-custom' })] },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'usdc', chain: 'ethereum', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.conflict).toEqual({
            type: 'same_canonical',
            assetId: 'usdc',
            variantId: 'usdc:eth-custom',
            origin: 'coingecko',
        });
        expect(preview.variantWrite.variantId).toBe('usdc:eth-custom');
    });

    it('adopting keeps the derived row\'s kind instead of re-deriving it', async () => {
        // Without asset_platform_id the platforms map (coin listed on Solana)
        // would say `bridged`; the derivation knew the coin is native here, and a
        // `bridged` kind drops the row from v2 supply and market cap.
        const state = makeState({
            assetsById: { wbtc: { assetId: 'wbtc', category: 'crypto', coingeckoId: 'wrapped-bitcoin' } },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
            coinPlatformsById: {
                'wrapped-bitcoin': {
                    coinId: 'wrapped-bitcoin',
                    symbol: 'wbtc',
                    platforms: { ethereum: USDC_ETH, solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
                    decimalsByPlatform: { ethereum: 8 },
                    assetPlatformId: null,
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
            v2RowsByKey: { [`ethereum:${USDC_ETH}`]: [v2Row({ asset_id: 'wbtc', kind: 'native' })] },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'wbtc', chain: 'ethereum', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.conflict?.type).toBe('same_canonical');
        expect(preview.variantWrite.kind).toBe('native');
    });

    it('a fresh add derives the kind with the coin\'s asset_platform_id (home chain → native)', async () => {
        const state = makeState({
            assetsById: { wbtc: { assetId: 'wbtc', category: 'crypto', coingeckoId: 'wrapped-bitcoin' } },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
            coinPlatformsById: {
                'wrapped-bitcoin': {
                    coinId: 'wrapped-bitcoin',
                    symbol: 'wbtc',
                    platforms: { ethereum: USDC_ETH, solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
                    decimalsByPlatform: { ethereum: 8 },
                    assetPlatformId: 'ethereum',
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'wbtc', chain: 'ethereum', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.conflict).toBeNull();
        expect(preview.variantWrite.kind).toBe('native');
    });

    it('a different wrapper on the home chain does not inherit native from asset_platform_id', async () => {
        const other = '0x2222222222222222222222222222222222222222';
        const state = makeState({
            assetsById: { wbtc: { assetId: 'wbtc', category: 'crypto', coingeckoId: 'wrapped-bitcoin' } },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
            coinPlatformsById: {
                'wrapped-bitcoin': {
                    coinId: 'wrapped-bitcoin',
                    symbol: 'wbtc',
                    platforms: { ethereum: USDC_ETH, solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
                    decimalsByPlatform: { ethereum: 8 },
                    assetPlatformId: 'ethereum',
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'wbtc', chain: 'ethereum', address: other },
            ADMIN,
        );
        // Not the coin's deployment on its home chain: a wrapper, left out of supply.
        expect(preview.variantWrite.kind).toBe('wrapped');
    });

    it('a different contract off the home chain stays bridged (never spot)', async () => {
        const other = '0x2222222222222222222222222222222222222222';
        const state = makeState({
            assetsById: { wbtc: { assetId: 'wbtc', category: 'crypto', coingeckoId: 'wrapped-bitcoin' } },
            coinPlatformsById: {
                'wrapped-bitcoin': {
                    coinId: 'wrapped-bitcoin',
                    symbol: 'wbtc',
                    platforms: { ethereum: USDC_ETH, base: USDC_ETH },
                    decimalsByPlatform: { ethereum: 8 },
                    assetPlatformId: 'ethereum',
                    coinLastSyncedAt: FIXED_NOW,
                },
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'wbtc', chain: 'base', address: other },
            ADMIN,
        );
        expect(preview.variantWrite.kind).toBe('bridged');
    });

    it('reports other owners as a non-blocking shared_with', async () => {
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } },
            evmOverviewByChain: { ethereum: USDC_OVERVIEW },
            v2RowsByKey: {
                [`ethereum:${USDC_ETH}`]: [
                    v2Row({ asset_id: 'usd', origin: 'coingecko' }),
                    v2Row({ asset_id: 'other', origin: 'admin', source: 'admin' }),
                ],
            },
        });
        const preview = await adminCheckVariantMintForCanonical(
            makeDeps(state),
            { assetId: 'usdc', chain: 'ethereum', address: USDC_ETH },
            ADMIN,
        );
        expect(preview.conflict).toEqual({
            type: 'shared_with',
            owners: [
                { assetId: 'usd', variantId: `ethereum:${USDC_ETH}`, origin: 'coingecko' },
                { assetId: 'other', variantId: `ethereum:${USDC_ETH}`, origin: 'admin' },
            ],
        });
    });
});

describe('adminAddCheckedVariant (EVM)', () => {
    function makeEvmPreview(overrides: Partial<CheckedVariantPreview> = {}): CheckedVariantPreview {
        const base = makePreview();
        return {
            ...base,
            assetId: 'usdc',
            chain: 'ethereum',
            address: USDC_ETH,
            mint: USDC_ETH,
            conflict: null,
            decimalsSource: 'birdeye',
            variantWrite: {
                ...base.variantWrite,
                assetId: 'usdc',
                chain: 'ethereum',
                address: USDC_ETH,
                mint: USDC_ETH,
                variantId: `ethereum:${USDC_ETH}`,
                kind: 'stablecoin',
                tags: ['category:stablecoin'],
                label: 'USDC',
                decimals: 6,
            },
            marketWrite: {
                ...base.marketWrite!,
                chain: 'ethereum',
                address: USDC_ETH,
                mint: USDC_ETH,
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 6,
                price: 1,
            },
            ...overrides,
        };
    }

    it('writes the v2 variant (origin admin) and market, and skips aggregate + chart warms', async () => {
        const state = makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } });
        const result = await adminAddCheckedVariant(
            makeDeps(state),
            { checkedPreview: makeEvmPreview(), overrides: { label: 'USDC (Ethereum)', trustTier: 'tier1' } },
            ADMIN,
        );
        expect(result).toEqual({
            assetId: 'usdc',
            chain: 'ethereum',
            address: USDC_ETH,
            mint: USDC_ETH,
            variantId: `ethereum:${USDC_ETH}`,
            scheduled: [],
            v2Synced: true,
            adopted: false,
        });
        expect(state.adminVariantUpserts).toEqual([
            {
                chain: 'ethereum',
                address: USDC_ETH,
                assetId: 'usdc',
                variantId: `ethereum:${USDC_ETH}`,
                kind: 'stablecoin',
                trustTier: 'tier1',
                stockVariantTier: 'cash_redeemable',
                tags: ['category:stablecoin'],
                label: 'USDC (Ethereum)',
                decimals: 6,
                nowMs: FIXED_NOW,
            },
        ]);
        expect(state.v2MarketUpserts).toHaveLength(1);
        expect(state.v2MarketUpserts[0]).toMatchObject({ chain: 'ethereum', address: USDC_ETH, symbol: 'USDC', decimals: 6 });
        // The preview snapshot never overwrites a fresher row the refresh cron wrote meanwhile.
        expect(state.v2MarketUpsertOptions[0]).toEqual({ onlyIfNewer: true });
        expect(state.v2DecimalsSets).toEqual([{ chain: 'ethereum', address: USDC_ETH, decimals: 6 }]);
        // No v1 write, no aggregate, no mirror, no chart warms.
        expect(state.createdVariants).toEqual([]);
        expect(state.aggregateUpserts).toEqual([]);
        expect(state.mirrorRuns).toEqual([]);
        expect(state.tokenMarketsFetches).toEqual([]);
        expect(state.birdeyeOhlcvFetches).toEqual([]);
    });

    it('accepts an uppercase address on the wire and stores it lowercased', async () => {
        const state = makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } });
        const preview = makeEvmPreview();
        const raw = {
            ...preview,
            address: USDC_ETH_MIXED,
            mint: USDC_ETH_MIXED,
            variantWrite: { ...preview.variantWrite, address: USDC_ETH_MIXED, mint: USDC_ETH_MIXED },
            marketWrite: { ...preview.marketWrite!, address: USDC_ETH_MIXED, mint: USDC_ETH_MIXED },
        };
        const result = await adminAddCheckedVariant(makeDeps(state), { checkedPreview: raw, overrides: {} }, ADMIN);
        expect(result.address).toBe(USDC_ETH);
        expect(state.adminVariantUpserts[0]!.address).toBe(USDC_ETH);
    });

    it('writes no market when the preview had none, and requires decimals', async () => {
        const state = makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } });
        const preview = makeEvmPreview({ marketWrite: null, decimalsSource: null });
        preview.variantWrite.decimals = null;
        await expect(
            adminAddCheckedVariant(makeDeps(state), { checkedPreview: preview, overrides: {} }, ADMIN),
        ).rejects.toThrow('decimals is required for Ethereum variants');
        expect(state.adminVariantUpserts).toEqual([]);

        await adminAddCheckedVariant(makeDeps(state), { checkedPreview: preview, overrides: { decimals: 18 } }, ADMIN);
        expect(state.adminVariantUpserts).toHaveLength(1);
        expect(state.adminVariantUpserts[0]!.decimals).toBe(18);
        expect(state.v2MarketUpserts).toEqual([]);
        expect(state.v2DecimalsSets).toEqual([{ chain: 'ethereum', address: USDC_ETH, decimals: 18 }]);
    });

    it('rejects non-integer decimals overrides', async () => {
        const state = makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } });
        await expect(
            adminAddCheckedVariant(makeDeps(state), { checkedPreview: makeEvmPreview(), overrides: { decimals: 6.5 } }, ADMIN),
        ).rejects.toThrow('decimals must be an integer');
    });

    it('proceeds on same_canonical (adopting the derived row) and on shared_with', async () => {
        const state = makeState({
            assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } },
            v2RowsByKey: { [`ethereum:${USDC_ETH}`]: [v2Row({ asset_id: 'usdc' }), v2Row({ asset_id: 'usd' })] },
        });
        const adopted = await adminAddCheckedVariant(
            makeDeps(state),
            {
                checkedPreview: makeEvmPreview({
                    conflict: {
                        type: 'same_canonical',
                        assetId: 'usdc',
                        variantId: `ethereum:${USDC_ETH}`,
                        origin: 'coingecko',
                    },
                }),
                overrides: {},
            },
            ADMIN,
        );
        expect(adopted.adopted).toBe(true);

        const shared = await adminAddCheckedVariant(
            makeDeps(makeState({ assetsById: { usdc: { assetId: 'usdc', category: 'stablecoin' } } })),
            {
                checkedPreview: makeEvmPreview({
                    conflict: {
                        type: 'shared_with',
                        owners: [{ assetId: 'usd', variantId: `ethereum:${USDC_ETH}`, origin: 'coingecko' }],
                    },
                }),
                overrides: {},
            },
            ADMIN,
        );
        expect(shared.adopted).toBe(false);
    });

    it('rejects when the canonical asset does not exist', async () => {
        await expect(
            adminAddCheckedVariant(makeDeps(makeState()), { checkedPreview: makeEvmPreview(), overrides: {} }, ADMIN),
        ).rejects.toThrow('Canonical asset not found');
    });
});

describe('adminRefreshV2VariantMarket', () => {
    it('rejects Solana and chains without a Birdeye client', async () => {
        await expect(
            adminRefreshV2VariantMarket(makeDeps(makeState()), { chain: 'solana', address: MINT }, ADMIN),
        ).rejects.toThrow('Use Refresh charts for Solana variants');
        await expect(
            adminRefreshV2VariantMarket(makeDeps(makeState()), { chain: 'ethereum', address: USDC_ETH }, ADMIN),
        ).rejects.toThrow('Birdeye does not cover Ethereum');
    });

    it('upserts the snapshot and decimals when Birdeye answers', async () => {
        const state = makeState({
            evmOverviewByChain: { ethereum: { symbol: 'USDC', name: 'USD Coin', decimals: 6, price: 1 } },
        });
        const result = await adminRefreshV2VariantMarket(
            makeDeps(state),
            { chain: 'ethereum', address: USDC_ETH_MIXED },
            ADMIN,
        );
        expect(result).toEqual({ chain: 'ethereum', address: USDC_ETH, refreshed: true });
        expect(state.v2MarketUpserts).toHaveLength(1);
        expect(state.v2DecimalsSets).toEqual([{ chain: 'ethereum', address: USDC_ETH, decimals: 6 }]);
        expect(state.v2Touches).toEqual([]);
    });

    it('touches the row when Birdeye has nothing', async () => {
        const state = makeState({ evmOverviewByChain: { ethereum: null } });
        const result = await adminRefreshV2VariantMarket(makeDeps(state), { chain: 'ethereum', address: USDC_ETH }, ADMIN);
        expect(result.refreshed).toBe(false);
        expect(state.v2MarketUpserts).toEqual([]);
        expect(state.v2Touches).toEqual([{ chain: 'ethereum', address: USDC_ETH }]);
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
