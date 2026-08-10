import { describe, expect, it } from 'bun:test';

import {
    cacheWarmRequest,
    cacheWarmRequestAssetRisk,
    cacheWarmRequestCoingeckoOhlcv,
    cacheWarmRequestCoingeckoTickers,
    cacheWarmRequestCoinMetadata,
    cacheWarmRequestCoinPrice,
    cacheWarmRequestCuratedListWarm,
    cacheWarmRequestMintsWarm,
    cacheWarmRequestRegistrySeed,
    cacheWarmRequestStockOhlcv,
    cacheWarmRequestStockPrice,
    cacheWarmSetAssetLogoUrl,
    __testing,
    type CacheWarmDeps,
} from './cacheWarm';
import { InvalidArgsError, type BirdeyeOverview, type CronDeps, type JobsRepo } from './crons';
import type { MiscCronDeps, MiscJobsRepo } from './crons.misc';
import type { CoingeckoRepo } from './crons.coingecko';
import type { ClickhouseClient, ClickhouseCronDeps, ClickhouseRepo } from './crons.clickhouse';
import type { ClickhouseExtrasCronDeps, ClickhouseExtrasRepo } from './crons.clickhouse.extras';
import type { SeedCronDeps } from './crons.seed';
import type { StockInstrumentRow, StockPriceRow, StockReadsRepo } from './stockReads';

const FIXED_NOW = 1_780_000_000_000;

const OVERVIEW: BirdeyeOverview = { symbol: 'JUP', name: 'Jupiter', decimals: 6, price: 1.5 };

interface FakeState {
    variantByMint?: Record<string, { assetId: string; chain: string }>;
    overviewLastByMint?: Record<string, number>;
    tokenMarketsLastByMint?: Record<string, number>;
    assetRiskLastByMint?: Record<string, number>;
    ohlcvBoundsByKey?: Record<string, { minTime: number | null; maxTime: number | null }>;
    cgOhlcvBoundsByKey?: Record<string, { minTime: number | null; maxTime: number | null }>;
    cgPriceLastByCoinId?: Record<string, number>;
    cgMetadataLastByCoinId?: Record<string, number>;
    cgTickersLastByCoinId?: Record<string, number>;
    stockInstrumentsByAssetId?: Record<string, Partial<StockInstrumentRow>>;
    stockPricesByAssetId?: Record<string, Partial<StockPriceRow>>;
    stockOhlcvBoundsByKey?: Record<string, { minTime: number | null; maxTime: number | null }>;
    birdeyeThrows?: boolean;
    env?: Record<string, string>;

    upsertedBirdeye: string[];
    upsertedTokenMarkets: string[];
    upsertedWebacy: string[];
    birdeyeOhlcvFetches: Array<{ address: string; interval: string }>;
    cgSimplePriceFetches: string[][];
    cgMetadataFetches: string[];
    cgTickersFetches: string[];
    cgMarketChartFetches: string[];
    stockSnapshotFetches: string[];
    solanaOhlcvBoundsCalls: Array<{ address: string; interval: string }>;
    stockOhlcvBoundsCalls: Array<{ assetId: string; interval: string }>;
    setImageUrlCalls: Array<{ assetId: string; imageUrl: string }>;
    seedRuns: number;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
    return {
        upsertedBirdeye: [],
        upsertedTokenMarkets: [],
        upsertedWebacy: [],
        birdeyeOhlcvFetches: [],
        cgSimplePriceFetches: [],
        cgMetadataFetches: [],
        cgTickersFetches: [],
        cgMarketChartFetches: [],
        stockSnapshotFetches: [],
        solanaOhlcvBoundsCalls: [],
        stockOhlcvBoundsCalls: [],
        setImageUrlCalls: [],
        seedRuns: 0,
        ...overrides,
    };
}

function makeJobsRepo(state: FakeState): JobsRepo {
    return {
        async upsertVariantMarketFromBirdeye(args) {
            state.upsertedBirdeye.push(args.mint);
        },
        async touchVariantMarket() {},
        async getOverviewLastFetchedAtByMint(mint) {
            return state.overviewLastByMint?.[mint] ?? null;
        },
        async listStaleVariantMints() {
            return [];
        },
        async listCuratedAssetIds() {
            return [];
        },
        async listVariantsForRollup() {
            return [];
        },
        async listVariantLastComputedByAssetIds() {
            return new Map();
        },
        async sumDailyOhlcvVolumeByAddresses() {
            return new Map();
        },
        async upsertAssetAggregate() {},
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
            return state.variantByMint?.[mint] ?? null;
        },
        async getAssetRiskLastFetchedAtByMint(mint) {
            return state.assetRiskLastByMint?.[mint] ?? null;
        },
        async upsertAssetRiskLatest(args) {
            state.upsertedWebacy.push(args.mint);
        },
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
        async ensureApiRequestEventsPartition() {
            return 'created' as const;
        },
        async countApiRequestEventsDefaultRows() {
            return 0;
        },
        async getOhlcvBounds(address, interval) {
            return state.ohlcvBoundsByKey?.[`${address}\n${interval}`] ?? { minTime: null, maxTime: null };
        },
        async upsertOhlcvCandles(_address, _interval, candles) {
            return { inserted: candles.length, updated: 0, skipped: 0 };
        },
    };
}

function makeCoingeckoRepo(state: FakeState): CoingeckoRepo {
    return {
        async filterKnownCoinIds(coinIds: readonly string[]) {
            return [...coinIds];
        },
        async hasFreshCoinListRows() {
            return true;
        },
        async upsertCoinListBatch(coins) {
            return { inserted: coins.length, updated: 0, skipped: 0 };
        },
        async getCoinMetadataLastFetchedAt(id) {
            return state.cgMetadataLastByCoinId?.[id] ?? null;
        },
        async upsertCoinMetadata() {},
        async getTickersLastFetchedAt(coinId) {
            return state.cgTickersLastByCoinId?.[coinId] ?? null;
        },
        async upsertTickersLatest() {},
        async touchTickersLatest() {},
        async upsertPriceLatest() {},
        async listPriceLastFetchedAtByCoinIds(coinIds) {
            const out = new Map<string, number | null>();
            for (const id of coinIds) out.set(id, state.cgPriceLastByCoinId?.[id] ?? null);
            return out;
        },
        async getOhlcvBounds(coinId, interval) {
            return state.cgOhlcvBoundsByKey?.[`${coinId}\n${interval}`] ?? { minTime: null, maxTime: null };
        },
        async upsertOhlcvCandles(_coinId, _interval, candles) {
            return { inserted: candles.length, updated: 0, skipped: 0 };
        },
    };
}

function makeCronDeps(state: FakeState): CronDeps {
    return {
        repo: makeJobsRepo(state),
        curated: {
            getAllCuratedMintsInOrder: () => [],
            getCuratedMintRank: () => new Map(),
        },
        birdeye: {
            async fetchTokenOverview() {
                if (state.birdeyeThrows) throw new Error('birdeye down');
                return OVERVIEW;
            },
        },
        birdeyeOhlcv: {
            async fetchOhlcv(args) {
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
            isConfigured: () => true,
            async fetchAll() {
                return {
                    token: { ok: true, status: 200, data: {} },
                    trading: { ok: true, status: 200, data: {} },
                    holder: { ok: true, status: 200, data: {} },
                };
            },
        },
        coingeckoRepo: makeCoingeckoRepo(state),
        coingeckoCurated: { getCuratedCoinIdsInOrder: () => [] },
        coingecko: {
            async fetchCoinList() {
                return [];
            },
            async fetchCoinById(id) {
                state.cgMetadataFetches.push(id);
                return { id, symbol: 'x', name: 'X' };
            },
            async fetchCoinTickersPage(args) {
                state.cgTickersFetches.push(args.coinId);
                return { tickers: [] };
            },
            async fetchSimplePrice(coinIds) {
                state.cgSimplePriceFetches.push([...coinIds]);
                const out: Record<string, { usd?: unknown }> = {};
                for (const id of coinIds) out[id] = { usd: 1 };
                return out;
            },
            async fetchMarketChartRange(args) {
                state.cgMarketChartFetches.push(args.coinId);
                return { prices: [], totalVolumes: [] };
            },
        },
        now: () => FIXED_NOW,
    };
}

function makeMiscRepo(state: FakeState): MiscJobsRepo {
    return {
        async listStaleTokenAddresses() {
            return [];
        },
        async upsertTokenFromBirdeye() {},
        async getTokenMarketsLastFetchedAtByMint(mint) {
            return state.tokenMarketsLastByMint?.[mint] ?? null;
        },
        async upsertTokenMarketsLatest(args) {
            state.upsertedTokenMarkets.push(args.mint);
        },
        async touchTokenMarketsLatest() {},
    };
}

function makeMiscDeps(state: FakeState, base: CronDeps): MiscCronDeps {
    return {
        base,
        repo: makeMiscRepo(state),
        birdeyeMarkets: {
            async fetchTokenMarkets() {
                return [];
            },
        },
    };
}

function makeClickhouseClient(state: FakeState): ClickhouseClient {
    return {
        async fetchStockInstruments() {
            return [];
        },
        async fetchStockSnapshot(symbol) {
            state.stockSnapshotFetches.push(symbol);
            return { priceUsd: 10, volume24hUsd: 100, priceChange24hPercent: 1, asOf: FIXED_NOW };
        },
        async fetchSharesOutstanding() {
            return [];
        },
        async fetchSolanaTradesAsOfMs() {
            return FIXED_NOW;
        },
        async fetchSolanaMintSnapshots() {
            return [];
        },
        async query() {
            return [];
        },
        async queryPreset() {
            return [];
        },
        tables: () => ({
            database: 'db',
            stockTradesTable: 'stock_trades',
            stockInstrumentsTable: 'stock_instruments',
            solanaTradesTable: 'solana_trades',
            priceScale: 1e9,
        }),
    };
}

function makeClickhouseRepo(state: FakeState): ClickhouseRepo {
    return {
        async upsertStockInstruments() {
            return { upserted: 0, skipped: 0 };
        },
        async listStockMappableAssets() {
            return [];
        },
        async listActiveStockMappings() {
            return Object.keys(state.stockInstrumentsByAssetId ?? {}).map(assetId => ({
                assetId,
                symbol: assetId.toUpperCase(),
                normalizedSymbol: assetId.toUpperCase(),
            }));
        },
        async upsertStockPriceLatest() {},
        async updateStockSharesOutstanding() {
            return { updated: 0 };
        },
        async upsertVariantMarketFromClickhouse() {},
        async getStableMints() {
            return [];
        },
        async getRegistryIdentityByMint() {
            return null;
        },
    };
}

function makeExtrasRepo(state: FakeState): ClickhouseExtrasRepo {
    return {
        async replaceTrendingFromClickHouse() {
            return { upserted: 0, deleted: 0 };
        },
        async updateVariantMarketMetricsFromClickhouse() {
            return { updated: 0 };
        },
        async replaceVariantFillQualityFromClickHouse() {
            return { upserted: 0, deleted: 0 };
        },
        async upsertSolanaOhlcv(args) {
            return { inserted: args.candles.length, updated: 0, skipped: 0 };
        },
        async upsertStockOhlcv(args) {
            return { inserted: args.candles.length, updated: 0, skipped: 0 };
        },
        async getSolanaOhlcvBounds(address, interval) {
            state.solanaOhlcvBoundsCalls.push({ address, interval });
            return { minTime: null, maxTime: null };
        },
        async getStockOhlcvBounds(assetId, interval) {
            state.stockOhlcvBoundsCalls.push({ assetId, interval });
            return state.stockOhlcvBoundsByKey?.[`${assetId}\n${interval}`] ?? { minTime: null, maxTime: null };
        },
        async listActiveStockMappings() {
            return Object.keys(state.stockInstrumentsByAssetId ?? {}).map(assetId => ({
                assetId,
                symbol: assetId.toUpperCase(),
                normalizedSymbol: assetId.toUpperCase(),
            }));
        },
        async getStableMints() {
            return [];
        },
        async findVariantMarketRegistryRowsByMints() {
            return [];
        },
    };
}

function makeStockReadsRepo(state: FakeState): StockReadsRepo {
    const instrumentRow = (assetId: string, partial: Partial<StockInstrumentRow>): StockInstrumentRow => ({
        asset_id: assetId,
        symbol: assetId.toUpperCase(),
        normalized_symbol: assetId.toUpperCase(),
        name: null,
        instrument_id: null,
        dataset: null,
        is_active: true,
        source: 'clickhouse',
        last_synced_at: FIXED_NOW,
        ...partial,
    });
    const priceRow = (assetId: string, partial: Partial<StockPriceRow>): StockPriceRow => ({
        asset_id: assetId,
        symbol: assetId.toUpperCase(),
        normalized_symbol: assetId.toUpperCase(),
        price_usd: 1,
        volume_24h_usd: 1,
        price_change_24h_percent: 0,
        shares_outstanding: null,
        shares_as_of: null,
        shares_last_fetched_at: null,
        as_of: FIXED_NOW,
        last_fetched_at: 0,
        source: 'clickhouse_stock',
        ...partial,
    });
    return {
        async findInstrumentByAssetId(assetId) {
            const partial = state.stockInstrumentsByAssetId?.[assetId];
            return partial ? instrumentRow(assetId, partial) : null;
        },
        async findInstrumentsByAssetIds() {
            return [];
        },
        async findPriceByAssetId(assetId) {
            const partial = state.stockPricesByAssetId?.[assetId];
            return partial ? priceRow(assetId, partial) : null;
        },
        async findPricesByAssetIds() {
            return [];
        },
    };
}

function makeSeedDeps(state: FakeState): SeedCronDeps {
    return {
        repo: {
            async upsertCanonicalAsset() {},
            async upsertCanonicalAssetVariant() {},
            async upsertCanonicalAssetAlias() {},
            async ensureVariantMarketRow() {},
            async upsertAssetCollection() {},
            async replaceAssetCollectionMembers() {},
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
                await fn(this);
            },
        },
        now: () => {
            state.seedRuns += 1;
            return FIXED_NOW;
        },
        listCanonicalAssets: () => [],
        listCuratedListOrder: () => [],
        getCuratedListMints: () => [],
        getCuratedListTitle: () => ({ title: 't', description: 'd' }),
        getAllCuratedMintsInOrder: () => [],
        resolveAssetIdByMint: () => null,
    };
}

function makeDeps(overrides: Partial<FakeState> = {}): { deps: CacheWarmDeps; state: FakeState } {
    const state = makeState(overrides);
    const cron = makeCronDeps(state);
    const clickhouse: ClickhouseCronDeps = {
        clickhouseRepo: makeClickhouseRepo(state),
        curated: cron.curated,
        clickhouse: makeClickhouseClient(state),
        now: () => FIXED_NOW,
        env: () => (state.env ?? {}) as NodeJS.ProcessEnv,
    };
    const clickhouseExtras: ClickhouseExtrasCronDeps = {
        clickhouse: makeClickhouseClient(state),
        repo: makeExtrasRepo(state),
        curated: cron.curated,
        now: () => FIXED_NOW,
        env: () => (state.env ?? {}) as NodeJS.ProcessEnv,
    };
    const deps: CacheWarmDeps = {
        cron,
        misc: makeMiscDeps(state, cron),
        clickhouse,
        clickhouseExtras,
        seed: makeSeedDeps(state),
        stockReadsRepo: makeStockReadsRepo(state),
        assetsRepo: {
            async setImageUrlByAssetId(assetId, imageUrl) {
                state.setImageUrlCalls.push({ assetId, imageUrl });
                return true;
            },
        },
        env: () => (state.env ?? {}) as NodeJS.ProcessEnv,
        now: () => FIXED_NOW,
    };
    return { deps, state };
}

const KNOWN_MINT = 'mintKnown';
const KNOWN_VARIANTS = { [KNOWN_MINT]: { assetId: 'jup', chain: 'solana' } };

describe('cacheWarmRequest', () => {
    it('skips unknown mints without warming anything', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmRequest(deps, { secret: 'ignored', mint: 'nope' });
        expect(res).toEqual({ mint: 'nope', scheduled: [], skipped: ['unknown_mint'] });
        expect(state.upsertedBirdeye).toEqual([]);
        expect(state.upsertedTokenMarkets).toEqual([]);
    });

    it('returns invalid_mint for an empty mint', async () => {
        const { deps } = makeDeps();
        const res = await cacheWarmRequest(deps, { mint: '   ' });
        expect(res).toEqual({ mint: '', scheduled: [], skipped: ['invalid_mint'] });
    });

    it('throws InvalidArgsError when mint is missing', async () => {
        const { deps } = makeDeps();
        await expect(cacheWarmRequest(deps, {})).rejects.toThrow(InvalidArgsError);
    });

    it('dedup-skips variantMarket and markets when both are fresh', async () => {
        const { deps, state } = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            overviewLastByMint: { [KNOWN_MINT]: FIXED_NOW - 1_000 },
            tokenMarketsLastByMint: { [KNOWN_MINT]: FIXED_NOW - 1_000 },
        });
        const res = await cacheWarmRequest(deps, { mint: KNOWN_MINT, minAgeMs: 60_000 });
        expect(res.scheduled).toEqual([]);
        expect(res.skipped).toEqual(['variantMarket:fresh', 'markets:fresh']);
        expect(state.upsertedBirdeye).toEqual([]);
        expect(state.upsertedTokenMarkets).toEqual([]);
    });

    it('warms variantMarket and markets inline when stale', async () => {
        const { deps, state } = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            overviewLastByMint: { [KNOWN_MINT]: FIXED_NOW - 60 * 60_000 },
        });
        const res = await cacheWarmRequest(deps, { mint: KNOWN_MINT, minAgeMs: 60_000 });
        expect(res.scheduled).toEqual(['variantMarket', 'markets']);
        expect(res.skipped).toEqual([]);
        expect(state.upsertedBirdeye).toEqual([KNOWN_MINT]);
        expect(state.upsertedTokenMarkets).toEqual([KNOWN_MINT]);
    });

    it('respects explicit variantMarket/markets/ohlcv flags', async () => {
        const { deps, state } = makeDeps({ variantByMint: KNOWN_VARIANTS });
        const res = await cacheWarmRequest(deps, {
            mint: KNOWN_MINT,
            variantMarket: false,
            markets: false,
            ohlcv: true,
            ohlcvInterval: '1H',
            ohlcvDays: 7,
        });
        expect(res.scheduled).toEqual(['ohlcv:1H']);
        expect(state.upsertedBirdeye).toEqual([]);
        expect(state.birdeyeOhlcvFetches.map(f => f.address)).toEqual([KNOWN_MINT]);
        // ClickHouse solana trades refresh is disabled -> Birdeye only.
        expect(state.solanaOhlcvBoundsCalls).toEqual([]);
    });

    it('skips ohlcv when candles are fresh with start coverage', async () => {
        const nowSeconds = Math.floor(FIXED_NOW / 1000);
        const { deps, state } = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            ohlcvBoundsByKey: {
                [`${KNOWN_MINT}\n1H`]: {
                    minTime: nowSeconds - 400 * 24 * 60 * 60,
                    maxTime: nowSeconds - 60,
                },
            },
        });
        const res = await cacheWarmRequest(deps, {
            mint: KNOWN_MINT,
            variantMarket: false,
            markets: false,
            ohlcv: true,
            ohlcvInterval: '1H',
        });
        expect(res.skipped).toEqual(['ohlcv:1H:fresh']);
        expect(state.birdeyeOhlcvFetches).toEqual([]);
    });

    it('dual-schedules ClickHouse + Birdeye ohlcv when the ClickHouse flag is on', async () => {
        const { deps, state } = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            env: { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' },
        });
        const res = await cacheWarmRequest(deps, {
            mint: KNOWN_MINT,
            variantMarket: false,
            markets: false,
            ohlcv: true,
            ohlcvInterval: '1H',
        });
        expect(res.scheduled).toEqual(['ohlcv:1H']);
        // ClickHouse path consulted its bounds AND the Birdeye backstop ran.
        expect(state.solanaOhlcvBoundsCalls).toEqual([{ address: KNOWN_MINT, interval: '1H' }]);
        expect(state.birdeyeOhlcvFetches.map(f => f.address)).toEqual([KNOWN_MINT]);
    });

    it('swallows refresh failures (warming is best-effort)', async () => {
        const { deps, state } = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            birdeyeThrows: true,
        });
        const res = await cacheWarmRequest(deps, { mint: KNOWN_MINT, markets: false });
        expect(res.scheduled).toEqual(['variantMarket']);
        expect(state.upsertedBirdeye).toEqual([]);
    });
});

describe('cacheWarmRequestCoingeckoOhlcv', () => {
    it('skips when the latest candle is fresh', async () => {
        const nowSeconds = Math.floor(FIXED_NOW / 1000);
        const { deps, state } = makeDeps({
            cgOhlcvBoundsByKey: { 'bitcoin\n1H': { minTime: 0, maxTime: nowSeconds - 60 } },
        });
        const res = await cacheWarmRequestCoingeckoOhlcv(deps, { coinId: 'bitcoin', interval: '1H' });
        expect(res).toEqual({ coinId: 'bitcoin', scheduled: [], skipped: ['ohlcv:1H:fresh'] });
        expect(state.cgMarketChartFetches).toEqual([]);
    });

    it('warms inline when stale', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmRequestCoingeckoOhlcv(deps, { coinId: 'bitcoin', interval: '1H', days: 7 });
        expect(res).toEqual({ coinId: 'bitcoin', scheduled: ['ohlcv:1H'], skipped: [] });
        expect(state.cgMarketChartFetches).toEqual(['bitcoin']);
    });
});

describe('cacheWarmRequestCoinPrice', () => {
    it('dedup-skips a fresh price', async () => {
        const { deps, state } = makeDeps({ cgPriceLastByCoinId: { bitcoin: FIXED_NOW - 1_000 } });
        const res = await cacheWarmRequestCoinPrice(deps, { coinId: 'bitcoin' });
        expect(res).toEqual({ coinId: 'bitcoin', scheduled: [], skipped: ['price:fresh'] });
        expect(state.cgSimplePriceFetches).toEqual([]);
    });

    it('warms a stale price inline', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmRequestCoinPrice(deps, { coinId: 'bitcoin', minAgeMs: 0 });
        expect(res).toEqual({ coinId: 'bitcoin', scheduled: ['price'], skipped: [] });
        expect(state.cgSimplePriceFetches).toEqual([['bitcoin']]);
    });
});

describe('cacheWarmRequestCoinMetadata', () => {
    it('dedup-skips fresh metadata and warms stale metadata', async () => {
        const fresh = makeDeps({ cgMetadataLastByCoinId: { bitcoin: FIXED_NOW - 1_000 } });
        expect(await cacheWarmRequestCoinMetadata(fresh.deps, { coinId: 'bitcoin' })).toEqual({
            coinId: 'bitcoin',
            scheduled: [],
            skipped: ['metadata:fresh'],
        });
        expect(fresh.state.cgMetadataFetches).toEqual([]);

        const stale = makeDeps();
        expect(await cacheWarmRequestCoinMetadata(stale.deps, { coinId: 'bitcoin' })).toEqual({
            coinId: 'bitcoin',
            scheduled: ['metadata'],
            skipped: [],
        });
        expect(stale.state.cgMetadataFetches).toEqual(['bitcoin']);
    });
});

describe('cacheWarmRequestCoingeckoTickers', () => {
    it('dedup-skips fresh tickers and warms stale tickers', async () => {
        const fresh = makeDeps({ cgTickersLastByCoinId: { bitcoin: FIXED_NOW - 1_000 } });
        expect(await cacheWarmRequestCoingeckoTickers(fresh.deps, { coinId: 'bitcoin' })).toEqual({
            coinId: 'bitcoin',
            scheduled: [],
            skipped: ['tickers:fresh'],
        });

        const stale = makeDeps();
        expect(await cacheWarmRequestCoingeckoTickers(stale.deps, { coinId: 'bitcoin' })).toEqual({
            coinId: 'bitcoin',
            scheduled: ['tickers'],
            skipped: [],
        });
        expect(stale.state.cgTickersFetches.length).toBeGreaterThan(0);
    });
});

describe('cacheWarmRequestStockPrice', () => {
    it('skips unknown or inactive stock assets', async () => {
        const unknown = makeDeps();
        expect(await cacheWarmRequestStockPrice(unknown.deps, { assetId: 'tsla' })).toEqual({
            assetId: 'tsla',
            scheduled: [],
            skipped: ['unknown_stock_asset'],
        });

        const inactive = makeDeps({ stockInstrumentsByAssetId: { tsla: { is_active: false } } });
        expect(await cacheWarmRequestStockPrice(inactive.deps, { assetId: 'tsla' })).toEqual({
            assetId: 'tsla',
            scheduled: [],
            skipped: ['unknown_stock_asset'],
        });
    });

    it('dedup-skips a fresh snapshot', async () => {
        const { deps, state } = makeDeps({
            stockInstrumentsByAssetId: { tsla: {} },
            stockPricesByAssetId: { tsla: { last_fetched_at: FIXED_NOW - 1_000 } },
        });
        const res = await cacheWarmRequestStockPrice(deps, { assetId: 'tsla' });
        expect(res).toEqual({ assetId: 'tsla', scheduled: [], skipped: ['stockPrice:fresh'] });
        expect(state.stockSnapshotFetches).toEqual([]);
    });

    it('warms inline even when CLICKHOUSE_STOCK_REFRESH_ENABLED is unset (Convex parity)', async () => {
        const { deps, state } = makeDeps({ stockInstrumentsByAssetId: { tsla: {} } });
        const res = await cacheWarmRequestStockPrice(deps, { assetId: 'tsla' });
        expect(res).toEqual({ assetId: 'tsla', scheduled: ['stockPrice'], skipped: [] });
        expect(state.stockSnapshotFetches).toEqual(['TSLA']);
    });
});

describe('cacheWarmRequestStockOhlcv', () => {
    it('skips fresh candles and warms stale ones', async () => {
        const nowSeconds = Math.floor(FIXED_NOW / 1000);
        const fresh = makeDeps({
            stockInstrumentsByAssetId: { tsla: {} },
            stockOhlcvBoundsByKey: { 'tsla\n1H': { minTime: 0, maxTime: nowSeconds - 60 } },
        });
        expect(await cacheWarmRequestStockOhlcv(fresh.deps, { assetId: 'tsla', interval: '1H' })).toEqual({
            assetId: 'tsla',
            scheduled: [],
            skipped: ['stockOhlcv:1H:fresh'],
        });

        const stale = makeDeps({ stockInstrumentsByAssetId: { tsla: {} } });
        expect(await cacheWarmRequestStockOhlcv(stale.deps, { assetId: 'tsla', interval: '1H', days: 7 })).toEqual({
            assetId: 'tsla',
            scheduled: ['stockOhlcv:1H'],
            skipped: [],
        });
        expect(stale.state.stockOhlcvBoundsCalls.length).toBeGreaterThan(0);
    });
});

describe('cacheWarmRequestAssetRisk', () => {
    it('skips unknown mints and fresh risk rows, warms stale ones', async () => {
        const unknown = makeDeps();
        expect(await cacheWarmRequestAssetRisk(unknown.deps, { mint: 'nope' })).toEqual({
            mint: 'nope',
            scheduled: [],
            skipped: ['unknown_mint'],
        });

        const fresh = makeDeps({
            variantByMint: KNOWN_VARIANTS,
            assetRiskLastByMint: { [KNOWN_MINT]: FIXED_NOW - 1_000 },
        });
        expect(await cacheWarmRequestAssetRisk(fresh.deps, { mint: KNOWN_MINT })).toEqual({
            mint: KNOWN_MINT,
            scheduled: [],
            skipped: ['risk:fresh'],
        });
        expect(fresh.state.upsertedWebacy).toEqual([]);

        const stale = makeDeps({ variantByMint: KNOWN_VARIANTS });
        expect(await cacheWarmRequestAssetRisk(stale.deps, { mint: KNOWN_MINT })).toEqual({
            mint: KNOWN_MINT,
            scheduled: ['risk'],
            skipped: [],
        });
        expect(stale.state.upsertedWebacy).toEqual([KNOWN_MINT]);
    });
});

describe('cacheWarmRequestMintsWarm', () => {
    it('returns empty_mints when the list is empty after normalization', async () => {
        const { deps } = makeDeps();
        const res = await cacheWarmRequestMintsWarm(deps, { mints: ['', '  '] });
        expect(res).toEqual({ totalMints: 0, scheduled: [], skipped: ['empty_mints'] });
    });

    it('warms both variantMarket and markets per chunk and honors disable flags', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmRequestMintsWarm(deps, {
            mints: ['m1', 'm2', 'm1'],
            markets: false,
            minAgeMs: 0,
        });
        expect(res.totalMints).toBe(2);
        expect(res.scheduled).toEqual(['variantMarket']);
        expect(res.skipped).toEqual(['markets:disabled']);
        expect(state.upsertedBirdeye.sort()).toEqual(['m1', 'm2']);
        expect(state.upsertedTokenMarkets).toEqual([]);
    });

    it('throws InvalidArgsError on non-string mints', async () => {
        const { deps } = makeDeps();
        await expect(cacheWarmRequestMintsWarm(deps, { mints: [1] })).rejects.toThrow(InvalidArgsError);
    });
});

describe('cacheWarmRequestCuratedListWarm', () => {
    it('rejects empty and unknown list ids without warming', async () => {
        const { deps, state } = makeDeps();
        expect(await cacheWarmRequestCuratedListWarm(deps, { listId: ' ' })).toEqual({
            listId: '',
            totalMints: 0,
            scheduled: [],
            skipped: ['invalid_listId'],
        });
        expect(await cacheWarmRequestCuratedListWarm(deps, { listId: 'not-a-list' })).toEqual({
            listId: 'not-a-list',
            totalMints: 0,
            scheduled: [],
            skipped: ['unknown_listId'],
        });
        expect(state.upsertedBirdeye).toEqual([]);
    });

    it('resolves curated lists from the asset registry', () => {
        expect(__testing.getCuratedMints('all').length).toBeGreaterThan(0);
        expect(__testing.getCuratedMints('nope')).toEqual([]);
    });
});

describe('cacheWarmRequestRegistrySeed', () => {
    it('runs the seed job inline and echoes includeCuratedCollections', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmRequestRegistrySeed(deps, { includeCuratedCollections: false });
        expect(res).toEqual({ scheduled: true, includeCuratedCollections: false });
        expect(state.seedRuns).toBeGreaterThan(0);
    });
});

describe('cacheWarmSetAssetLogoUrl', () => {
    it('validates args and updates assets.image_url', async () => {
        const { deps, state } = makeDeps();
        const res = await cacheWarmSetAssetLogoUrl(deps, {
            secret: 'ignored',
            assetId: ' jup ',
            imageUrl: ' https://img.test/jup.png ',
        });
        expect(res).toBeNull();
        expect(state.setImageUrlCalls).toEqual([
            { assetId: 'jup', imageUrl: 'https://img.test/jup.png' },
        ]);
    });

    it('throws InvalidArgsError on missing/empty assetId or imageUrl', async () => {
        const { deps } = makeDeps();
        await expect(cacheWarmSetAssetLogoUrl(deps, { imageUrl: 'x' })).rejects.toThrow(InvalidArgsError);
        await expect(cacheWarmSetAssetLogoUrl(deps, { assetId: ' ', imageUrl: 'x' })).rejects.toThrow(
            InvalidArgsError,
        );
        await expect(cacheWarmSetAssetLogoUrl(deps, { assetId: 'jup', imageUrl: '  ' })).rejects.toThrow(
            InvalidArgsError,
        );
    });
});

describe('__testing helpers', () => {
    it('intervalToSeconds and ohlcvDaysDefault match the Convex defaults', () => {
        expect(__testing.intervalToSeconds('1H')).toBe(3600);
        expect(__testing.intervalToSeconds('1W')).toBe(7 * 24 * 3600);
        expect(__testing.ohlcvDaysDefault('15m')).toBe(1);
        expect(__testing.ohlcvDaysDefault('1H')).toBe(90);
        expect(__testing.ohlcvDaysDefault('1D')).toBe(365);
    });

    it('chunk splits into fixed-size groups', () => {
        expect(__testing.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });
});
