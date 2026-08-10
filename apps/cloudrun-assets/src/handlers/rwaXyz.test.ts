import { describe, expect, it } from 'bun:test';

import {
    refreshCuratedVariantMarkets,
    refreshStaleVariantMarkets,
    computeRwaXyzAssetUpdates,
    computeRwaXyzTokenUpdates,
    shouldWriteRwaXyzRow,
    type BirdeyeClient,
    type BirdeyeOhlcvClient,
    type BirdeyeOverview,
    type CronDeps,
    type CuratedMintsSource,
    type JobsRepo,
    type RwaXyzAssetLatestExisting,
    type RwaXyzAssetLatestUpsert,
    type RwaXyzAssetSnapshot,
    type RwaXyzClient,
    type RwaXyzTokenLatestExisting,
    type RwaXyzTokenLatestUpsert,
    type RwaXyzTokenSnapshot,
    type SanctumClient,
    type WebacyClient,
} from './crons';

const FIXED_NOW = 1_780_000_000_000;

function emptyBirdeye(byMint: Record<string, BirdeyeOverview | null> = {}): BirdeyeClient {
    return { async fetchTokenOverview(mint) { return Object.hasOwn(byMint, mint) ? byMint[mint] ?? null : null; } };
}

function emptyBirdeyeOhlcv(): BirdeyeOhlcvClient {
    return { async fetchOhlcv() { return []; } };
}

function emptySanctum(): SanctumClient {
    return { async fetchAndNormalizeLsts() { return { ok: false, reason: 'missing_env' }; } };
}

function emptyWebacy(): WebacyClient {
    return { isConfigured: () => true, async fetchAll() { return { token: { ok: false, status: 0 }, trading: { ok: false, status: 0 }, holder: { ok: false, status: 0 } }; } };
}

function emptyCurated(mints: readonly string[] = []): CuratedMintsSource {
    const rank = new Map<string, number>();
    for (let i = 0; i < mints.length; i++) rank.set(mints[i]!, i);
    return {
        getAllCuratedMintsInOrder: () => Array.from(mints),
        getCuratedMintRank: () => rank,
    };
}

interface RecordingRepoState {
    upsertedAssets: RwaXyzAssetLatestUpsert[];
    upsertedTokens: RwaXyzTokenLatestUpsert[];
    existingAssetByAssetId: Map<number, RwaXyzAssetLatestExisting>;
    existingTokenByNetworkAndAddress: Map<string, RwaXyzTokenLatestExisting>;
    touched: { mint: string; lastFetchedAt: number }[];
    upsertedBirdeye: { mint: string }[];
}

function makeRecordingRepo(state: RecordingRepoState): JobsRepo {
    return {
        async upsertVariantMarketFromBirdeye(args) {
            state.upsertedBirdeye.push({ mint: args.mint });
        },
        async touchVariantMarket(mint, lastFetchedAt) {
            state.touched.push({ mint, lastFetchedAt });
        },
        async getOverviewLastFetchedAtByMint() { return null; },
        async listStaleVariantMints() { return []; },
        async listCuratedAssetIds() { return []; },
        async listVariantsForRollup() { return []; },
        async listVariantLastComputedByAssetIds() { return new Map(); },
        async sumDailyOhlcvVolumeByAddresses() { return new Map(); },
        async upsertAssetAggregate() {},
        async listActiveSanctumLstCount() { return 0; },
        async listSanctumSourceRanks() { return new Map(); },
        async upsertSanctumLstLatest() {},
        async deactivateMissingSanctumLsts() { return 0; },
        async findVariantByMint() { return null; },
        async getAssetRiskLastFetchedAtByMint() { return null; },
        async upsertAssetRiskLatest() {},
        async findVariantMarketForRiskByMint() { return null; },
        async upsertWebacyTokenLatest() {},
        async upsertWebacyTradingLiteLatest() {},
        async upsertWebacyHolderAnalysisLatest() {},
        async findRwaXyzAssetLatestByAssetId(assetId) {
            return state.existingAssetByAssetId.get(assetId) ?? null;
        },
        async findRwaXyzTokenLatestByNetworkAndAddress(network, address) {
            return state.existingTokenByNetworkAndAddress.get(`${network}\n${address}`) ?? null;
        },
        async upsertRwaXyzAssetLatest(args) {
            state.upsertedAssets.push(args);
        },
        async upsertRwaXyzTokenLatest(args) {
            state.upsertedTokens.push(args);
        },
        async listRecentActiveProjects() { return []; },
        async getRollupStateForProject() { return null; },
        async tryAcquireRollupLock() { return true; },
        async releaseRollupLock() {},
        async listProjectEventsForRollup() { return []; },
        async applyDailyRollupDelta() {},
        async applyEndpointDailyRollupDelta() {},
        async applyRollupBatchAtomic() { return true; },
        async listAllProjectIds() { return []; },
        async pruneApiRequestEventsForProject() { return 0; },
        async ensureApiRequestEventsPartition() { return 'created' as const; },
        async countApiRequestEventsDefaultRows() { return 0; },
        async getOhlcvBounds() { return { minTime: null, maxTime: null }; },
        async upsertOhlcvCandles() { return { inserted: 0, updated: 0, skipped: 0 }; },
    };
}

function snapshotToken(overrides: Partial<RwaXyzTokenSnapshot> = {}): RwaXyzTokenSnapshot {
    return {
        rwaId: 1,
        rwaTokenId: 2,
        assetId: 42,
        name: 'Ondo Treasury',
        decimals: 6,
        priceDollar: 1.01,
        marketValueDollar: 1_000_000,
        totalSupplyToken: 990_099,
        payloadJson: JSON.stringify({ network_slug: 'solana', name: 'Ondo Treasury' }),
        ...overrides,
    };
}

function snapshotAsset(overrides: Partial<RwaXyzAssetSnapshot> = {}): RwaXyzAssetSnapshot {
    return {
        assetId: 42,
        name: 'Ondo Treasury',
        ticker: 'OUSG',
        slug: 'ondo-treasury',
        iconUrl: 'https://cdn.example/icon.png',
        issuerId: 'issuer-7',
        issuerName: 'Ondo Finance',
        assetClassId: 1,
        assetClassName: 'Treasury',
        assetClassSlug: 'treasury',
        payloadJson: JSON.stringify({ id: 42, ticker: 'OUSG' }),
        ...overrides,
    };
}

function makeRwaXyzClient(
    bySolanaMint: Record<string, { token: RwaXyzTokenSnapshot; asset: RwaXyzAssetSnapshot | null } | null>,
): RwaXyzClient {
    return {
        async fetchSolanaTokenAndAssetByMint(mint) {
            if (!Object.hasOwn(bySolanaMint, mint)) return null;
            return bySolanaMint[mint] ?? null;
        },
    };
}

function makeDeps(args: {
    state: RecordingRepoState;
    rwaXyz?: RwaXyzClient;
    birdeye?: BirdeyeClient;
    curated?: readonly string[];
}): CronDeps {
    return {
        repo: makeRecordingRepo(args.state),
        curated: emptyCurated(args.curated ?? []),
        birdeye: args.birdeye ?? emptyBirdeye(),
        birdeyeOhlcv: emptyBirdeyeOhlcv(),
        sanctum: emptySanctum(),
        webacy: emptyWebacy(),
        ...(args.rwaXyz !== undefined ? { rwaXyz: args.rwaXyz } : {}),
        now: () => FIXED_NOW,
    };
}

function newState(): RecordingRepoState {
    return {
        upsertedAssets: [],
        upsertedTokens: [],
        existingAssetByAssetId: new Map(),
        existingTokenByNetworkAndAddress: new Map(),
        touched: [],
        upsertedBirdeye: [],
    };
}

describe('computeRwaXyzTokenUpdates', () => {
    it('returns full updates when no existing row', () => {
        const args: RwaXyzTokenLatestUpsert = {
            networkSlug: 'solana',
            address: 'mintA',
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW,
            name: 'Foo',
            priceDollar: 1.5,
            decimals: 6,
        };
        const updates = computeRwaXyzTokenUpdates(null, args);
        expect(updates.name).toBe('Foo');
        expect(updates.priceDollar).toBe(1.5);
        expect(updates.decimals).toBe(6);
        expect(updates.payloadJson).toBe('{"x":1}');
    });

    it('returns empty when nothing changed', () => {
        const existing: RwaXyzTokenLatestExisting = {
            networkSlug: 'solana',
            address: 'mintA',
            rwaId: null,
            rwaTokenId: null,
            assetId: null,
            name: 'Foo',
            decimals: 6,
            priceDollar: 1.5,
            marketValueDollar: null,
            netAssetValueDollar: null,
            totalAssetValueDollar: null,
            circulatingAssetValueDollar: null,
            circulatingMarketValueDollar: null,
            apy7Day: null,
            apy30Day: null,
            totalSupplyToken: null,
            circulatingSupplyToken: null,
            holdingAddressesCount: null,
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW - 10_000,
        };
        const args: RwaXyzTokenLatestUpsert = {
            networkSlug: 'solana',
            address: 'mintA',
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW,
            name: 'Foo',
            decimals: 6,
            priceDollar: 1.5,
        };
        const updates = computeRwaXyzTokenUpdates(existing, args);
        expect(Object.keys(updates)).toHaveLength(0);
    });

    it('returns only the changed fields', () => {
        const existing: RwaXyzTokenLatestExisting = {
            networkSlug: 'solana',
            address: 'mintA',
            rwaId: null,
            rwaTokenId: null,
            assetId: null,
            name: 'Foo',
            decimals: 6,
            priceDollar: 1.5,
            marketValueDollar: null,
            netAssetValueDollar: null,
            totalAssetValueDollar: null,
            circulatingAssetValueDollar: null,
            circulatingMarketValueDollar: null,
            apy7Day: null,
            apy30Day: null,
            totalSupplyToken: null,
            circulatingSupplyToken: null,
            holdingAddressesCount: null,
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW - 10_000,
        };
        const args: RwaXyzTokenLatestUpsert = {
            networkSlug: 'solana',
            address: 'mintA',
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW,
            name: 'Foo',
            decimals: 6,
            priceDollar: 1.75,
        };
        const updates = computeRwaXyzTokenUpdates(existing, args);
        expect(updates).toEqual({ priceDollar: 1.75 });
    });

    it('skips empty strings (matches Convex normalizeString)', () => {
        const existing: RwaXyzTokenLatestExisting = {
            networkSlug: 'solana',
            address: 'mintA',
            rwaId: null,
            rwaTokenId: null,
            assetId: null,
            name: 'Foo',
            decimals: null,
            priceDollar: null,
            marketValueDollar: null,
            netAssetValueDollar: null,
            totalAssetValueDollar: null,
            circulatingAssetValueDollar: null,
            circulatingMarketValueDollar: null,
            apy7Day: null,
            apy30Day: null,
            totalSupplyToken: null,
            circulatingSupplyToken: null,
            holdingAddressesCount: null,
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW - 10_000,
        };
        const args: RwaXyzTokenLatestUpsert = {
            networkSlug: 'solana',
            address: 'mintA',
            payloadJson: '{"x":1}',
            lastFetchedAt: FIXED_NOW,
            name: '   ',
        };
        const updates = computeRwaXyzTokenUpdates(existing, args);
        expect(updates.name).toBeUndefined();
    });
});

describe('computeRwaXyzAssetUpdates', () => {
    it('returns updates for INSERT when no existing', () => {
        const args: RwaXyzAssetLatestUpsert = {
            assetId: 1,
            payloadJson: '{"id":1}',
            lastFetchedAt: FIXED_NOW,
            name: 'Ondo',
            ticker: 'OUSG',
            assetClassId: 7,
        };
        const updates = computeRwaXyzAssetUpdates(null, args);
        expect(updates).toEqual({
            name: 'Ondo',
            ticker: 'OUSG',
            assetClassId: 7,
            payloadJson: '{"id":1}',
        });
    });

    it('returns empty when all fields unchanged', () => {
        const existing: RwaXyzAssetLatestExisting = {
            assetId: 1,
            name: 'Ondo',
            ticker: 'OUSG',
            slug: null,
            iconUrl: null,
            website: null,
            issuerId: null,
            issuerName: null,
            assetClassId: 7,
            assetClassName: null,
            assetClassSlug: null,
            payloadJson: '{"id":1}',
            lastFetchedAt: FIXED_NOW - 10_000,
        };
        const args: RwaXyzAssetLatestUpsert = {
            assetId: 1,
            payloadJson: '{"id":1}',
            lastFetchedAt: FIXED_NOW,
            name: 'Ondo',
            ticker: 'OUSG',
            assetClassId: 7,
        };
        expect(Object.keys(computeRwaXyzAssetUpdates(existing, args))).toHaveLength(0);
    });
});

describe('shouldWriteRwaXyzRow', () => {
    it('always writes when no existing row', () => {
        expect(shouldWriteRwaXyzRow(null, FIXED_NOW, {})).toBe(true);
    });

    it('writes when updates exist', () => {
        expect(
            shouldWriteRwaXyzRow({ lastFetchedAt: FIXED_NOW - 1_000 }, FIXED_NOW, { name: 'x' }),
        ).toBe(true);
    });

    it('skips when no updates and lastFetchedAt is fresh', () => {
        expect(
            shouldWriteRwaXyzRow({ lastFetchedAt: FIXED_NOW - 10_000 }, FIXED_NOW, {}),
        ).toBe(false);
    });

    it('writes when no updates but threshold elapsed', () => {
        expect(
            shouldWriteRwaXyzRow({ lastFetchedAt: FIXED_NOW - 90_000 }, FIXED_NOW, {}),
        ).toBe(true);
    });
});

describe('refreshCuratedVariantMarkets — RWA.xyz shadow writes', () => {
    it('upserts rwa_xyz_tokens_latest and rwa_xyz_assets_latest after birdeye success', async () => {
        const state = newState();
        const overview: BirdeyeOverview = {
            symbol: 'OUSG',
            name: 'Ondo Treasury',
            decimals: 6,
            price: 1.01,
            v24hUSD: 10_000,
        };
        const deps = makeDeps({
            state,
            curated: ['mintA'],
            birdeye: emptyBirdeye({ mintA: overview }),
            rwaXyz: makeRwaXyzClient({ mintA: { token: snapshotToken(), asset: snapshotAsset() } }),
        });
        await refreshCuratedVariantMarkets(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedTokens).toHaveLength(1);
        expect(state.upsertedTokens[0]!.address).toBe('mintA');
        expect(state.upsertedTokens[0]!.networkSlug).toBe('solana');
        expect(state.upsertedTokens[0]!.priceDollar).toBe(1.01);
        expect(state.upsertedAssets).toHaveLength(1);
        expect(state.upsertedAssets[0]!.assetId).toBe(42);
        expect(state.upsertedAssets[0]!.ticker).toBe('OUSG');
    });

    it('skips RWA shadow writes when no rwaXyz client is configured', async () => {
        const state = newState();
        const overview: BirdeyeOverview = { symbol: 'X', name: 'X', decimals: 9, v24hUSD: 1 };
        const deps = makeDeps({
            state,
            curated: ['mintA'],
            birdeye: emptyBirdeye({ mintA: overview }),
        });
        await refreshCuratedVariantMarkets(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedTokens).toHaveLength(0);
        expect(state.upsertedAssets).toHaveLength(0);
    });

    it('skips asset upsert when RWA.xyz returns no asset payload', async () => {
        const state = newState();
        const overview: BirdeyeOverview = { symbol: 'X', name: 'X', decimals: 9, v24hUSD: 1 };
        const deps = makeDeps({
            state,
            curated: ['mintA'],
            birdeye: emptyBirdeye({ mintA: overview }),
            rwaXyz: makeRwaXyzClient({ mintA: { token: snapshotToken(), asset: null } }),
        });
        await refreshCuratedVariantMarkets(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedTokens).toHaveLength(1);
        expect(state.upsertedAssets).toHaveLength(0);
    });

    it('still shadow-writes RWA.xyz on the birdeye-failure path', async () => {
        const state = newState();
        const deps = makeDeps({
            state,
            curated: ['mintA'],
            birdeye: {
                async fetchTokenOverview() {
                    throw new Error('birdeye down');
                },
            },
            rwaXyz: makeRwaXyzClient({ mintA: { token: snapshotToken(), asset: snapshotAsset() } }),
        });
        await refreshCuratedVariantMarkets(deps, { delayMs: 0, minAgeMs: 0 });
        expect(state.upsertedTokens).toHaveLength(1);
        expect(state.upsertedAssets).toHaveLength(1);
        expect(state.touched).toHaveLength(1);
    });

    it('swallows RWA.xyz client errors without failing the refresh', async () => {
        const state = newState();
        const overview: BirdeyeOverview = { symbol: 'X', name: 'X', decimals: 9, v24hUSD: 1 };
        const deps = makeDeps({
            state,
            curated: ['mintA'],
            birdeye: emptyBirdeye({ mintA: overview }),
            rwaXyz: {
                async fetchSolanaTokenAndAssetByMint() {
                    throw new Error('rwa down');
                },
            },
        });
        const res = await refreshCuratedVariantMarkets(deps, { delayMs: 0, minAgeMs: 0 });
        expect(res.refreshed).toBe(1);
        expect(state.upsertedTokens).toHaveLength(0);
    });
});

describe('refreshStaleVariantMarkets — RWA.xyz shadow writes', () => {
    it('upserts rwa_xyz tables after birdeye success', async () => {
        const state = newState();
        const overview: BirdeyeOverview = { symbol: 'X', name: 'X', decimals: 9, v24hUSD: 1 };
        const repo = makeRecordingRepo(state);
        const listStaleVariantMints = repo.listStaleVariantMints.bind(repo);
        void listStaleVariantMints;
        const deps: CronDeps = {
            repo: {
                ...repo,
                async listStaleVariantMints() { return ['mintZ']; },
            },
            curated: emptyCurated(),
            birdeye: emptyBirdeye({ mintZ: overview }),
            birdeyeOhlcv: emptyBirdeyeOhlcv(),
            sanctum: emptySanctum(),
            webacy: emptyWebacy(),
            rwaXyz: makeRwaXyzClient({ mintZ: { token: snapshotToken(), asset: snapshotAsset() } }),
            now: () => FIXED_NOW,
        };
        await refreshStaleVariantMarkets(deps, { delayMs: 0 });
        expect(state.upsertedTokens).toHaveLength(1);
        expect(state.upsertedTokens[0]!.address).toBe('mintZ');
        expect(state.upsertedAssets).toHaveLength(1);
    });
});
