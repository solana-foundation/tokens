import { describe, expect, it } from 'bun:test';

import { InvalidArgsError, type CronDeps } from './crons';
import {
    refreshCuratedCoingeckoMetadata,
    refreshCuratedCoingeckoOhlcv,
    refreshCuratedCoingeckoPrices,
    refreshCuratedCoingeckoTickers,
    syncCoingeckoCoinList,
    __testing,
    type CoingeckoClient,
    type CoingeckoCoinListItem,
    type CoingeckoCoinMetadataUpsert,
    type CoingeckoCoinUpsert,
    type CoingeckoCuratedSource,
    type CoingeckoOhlcvCandle,
    type CoingeckoOhlcvInterval,
    type CoingeckoPriceUpsert,
    type CoingeckoRepo,
    type CoingeckoTickersUpsert,
} from './crons.coingecko';

const FIXED_NOW = 1_780_000_000_000;

interface CGState {
    coinListResult?: CoingeckoCoinListItem[];
    coinListThrows?: boolean;
    upsertedCoinListBatches?: CoingeckoCoinUpsert[][];
    coinListUpsertResult?: { inserted: number; updated: number; skipped: number };
    coinListUpsertThrows?: boolean;
    /** Throw only for multi-row batches, so the per-coin fallback can succeed. */
    coinListUpsertThrowsForMultiRow?: boolean;
    /** Coin ids whose individual (single-row) upsert should throw. */
    coinListUpsertThrowsForCoinIds?: string[];
    metadataLastByCoinId?: Record<string, number>;
    coinByIdResult?: Record<string, unknown>;
    coinByIdThrows?: Record<string, boolean>;
    upsertedMetadata?: CoingeckoCoinMetadataUpsert[];
    tickersLastByCoinId?: Record<string, number>;
    tickerPagesByCoinId?: Record<string, Array<{ name?: string; tickers: unknown[]; total?: number }>>;
    tickerPagesThrows?: Record<string, boolean>;
    upsertedTickers?: CoingeckoTickersUpsert[];
    touchedTickers?: { coinId: string; lastFetchedAt: number }[];
    simplePriceResult?: Record<string, {
        usd?: unknown;
        usd_market_cap?: unknown;
        usd_24h_vol?: unknown;
        usd_24h_change?: unknown;
        last_updated_at?: unknown;
    }>;
    simplePriceThrows?: boolean;
    priceLastByCoinId?: Record<string, number | null>;
    upsertedPrices?: CoingeckoPriceUpsert[];
    priceUpsertThrowsForCoinIds?: string[];
    ohlcvBoundsByKey?: Record<string, { minTime: number | null; maxTime: number | null }>;
    marketChartByCoinId?: Record<
        string,
        { prices: Array<{ time: number; value: number }>; totalVolumes: Array<{ time: number; value: number }> }
    >;
    marketChartThrows?: Record<string, boolean>;
    knownCoinIds?: string[];
    coinLastSyncedAtByCoinId?: Record<string, number>;
    marketChartCalls?: string[];
    upsertedOhlcv?: Array<{ coinId: string; interval: CoingeckoOhlcvInterval; candles: CoingeckoOhlcvCandle[] }>;
}

function makeRepo(state: CGState = {}): CoingeckoRepo {
    state.upsertedCoinListBatches ??= [];
    state.upsertedMetadata ??= [];
    state.upsertedTickers ??= [];
    state.touchedTickers ??= [];
    state.upsertedPrices ??= [];
    state.upsertedOhlcv ??= [];
    return {
        async upsertCoinListBatch(coins) {
            if (state.coinListUpsertThrows) throw new Error('upsert failed');
            if (state.coinListUpsertThrowsForMultiRow && coins.length > 1) throw new Error('batch upsert failed');
            const failIds = state.coinListUpsertThrowsForCoinIds;
            if (failIds && coins.some(c => failIds.includes(c.id))) throw new Error('coin upsert failed');
            state.upsertedCoinListBatches!.push([...coins]);
            return state.coinListUpsertResult ?? { inserted: coins.length, updated: 0, skipped: 0 };
        },
        async getCoinMetadataLastFetchedAt(id) {
            return state.metadataLastByCoinId?.[id] ?? null;
        },
        async upsertCoinMetadata(args) {
            state.upsertedMetadata!.push(args);
        },
        async getTickersLastFetchedAt(coinId) {
            return state.tickersLastByCoinId?.[coinId] ?? null;
        },
        async upsertTickersLatest(args) {
            state.upsertedTickers!.push(args);
        },
        async touchTickersLatest(coinId, lastFetchedAt) {
            state.touchedTickers!.push({ coinId, lastFetchedAt });
        },
        async upsertPriceLatest(args) {
            if (state.priceUpsertThrowsForCoinIds?.includes(args.coinId)) {
                throw new Error('price upsert failed');
            }
            state.upsertedPrices!.push(args);
        },
        async listPriceLastFetchedAtByCoinIds(coinIds) {
            const out = new Map<string, number | null>();
            for (const id of coinIds) out.set(id, state.priceLastByCoinId?.[id] ?? null);
            return out;
        },
        async filterKnownCoinIds(coinIds: readonly string[], syncedSinceMs: number) {
            const known = state.knownCoinIds ? new Set(state.knownCoinIds) : null;
            return coinIds.filter(id => {
                if (known && !known.has(id)) return false;
                const syncedAt = state.coinLastSyncedAtByCoinId?.[id];
                return syncedAt === undefined || syncedAt >= syncedSinceMs;
            });
        },
        async hasFreshCoinListRows(syncedSinceMs: number) {
            if (!state.knownCoinIds) return true;
            return state.knownCoinIds.some(id => {
                const syncedAt = state.coinLastSyncedAtByCoinId?.[id];
                return syncedAt === undefined || syncedAt >= syncedSinceMs;
            });
        },
        async getOhlcvBounds(coinId, interval) {
            return state.ohlcvBoundsByKey?.[`${coinId}\n${interval}`] ?? { minTime: null, maxTime: null };
        },
        async upsertOhlcvCandles(coinId, interval, candles) {
            state.upsertedOhlcv!.push({ coinId, interval, candles: [...candles] });
            return { inserted: candles.length, updated: 0, skipped: 0 };
        },
    };
}

function makeCurated(coinIds: readonly string[]): CoingeckoCuratedSource {
    return { getCuratedCoinIdsInOrder: () => Array.from(coinIds) };
}

function makeClient(state: CGState = {}): CoingeckoClient {
    return {
        async fetchCoinList() {
            if (state.coinListThrows) throw new Error('coin list http failed');
            return state.coinListResult ?? [];
        },
        async fetchCoinById(id) {
            if (state.coinByIdThrows?.[id]) throw new Error(`coin ${id} http failed`);
            return state.coinByIdResult?.[id] ?? null;
        },
        async fetchCoinTickersPage({ coinId, page }) {
            if (state.tickerPagesThrows?.[coinId]) throw new Error(`tickers ${coinId} failed`);
            const pages = state.tickerPagesByCoinId?.[coinId] ?? [];
            return pages[page - 1] ?? { tickers: [] };
        },
        async fetchSimplePrice() {
            if (state.simplePriceThrows) throw new Error('simple/price http failed');
            return state.simplePriceResult ?? {};
        },
        async fetchMarketChartRange({ coinId }) {
            (state.marketChartCalls ??= []).push(coinId);
            if (state.marketChartThrows?.[coinId]) throw new Error(`market_chart ${coinId} failed`);
            return state.marketChartByCoinId?.[coinId] ?? { prices: [], totalVolumes: [] };
        },
    };
}

function makeDeps(overrides: {
    state?: CGState;
    curated?: readonly string[];
} = {}): { deps: CronDeps; state: CGState } {
    const state = overrides.state ?? {};
    const deps: CronDeps = {
        repo: {} as never,
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
        birdeye: { async fetchTokenOverview() { return null; } },
        birdeyeOhlcv: { async fetchOhlcv() { return []; } },
        sanctum: { async fetchAndNormalizeLsts() { return { ok: false, reason: 'missing_env' }; } },
        webacy: { isConfigured: () => true, async fetchAll() { return {
            token: { ok: false, status: 0 },
            trading: { ok: false, status: 0 },
            holder: { ok: false, status: 0 },
        }; } },
        coingeckoRepo: makeRepo(state),
        coingeckoCurated: makeCurated(overrides.curated ?? []),
        coingecko: makeClient(state),
        now: () => FIXED_NOW,
    };
    return { deps, state };
}

describe('syncCoingeckoCoinList', () => {
    it('parses, batches, and upserts the coin list', async () => {
        const coins: CoingeckoCoinListItem[] = [
            { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} },
            { id: 'ethereum', symbol: 'eth', name: 'Ethereum', platforms: { ethereum: '0xeee' } },
            { id: 'solana', symbol: 'sol', name: 'Solana', platforms: {} },
        ];
        const { deps, state } = makeDeps({ state: { coinListResult: coins } });
        const res = await syncCoingeckoCoinList(deps, { batchSize: 25 });
        expect(res.ok).toBe(true);
        expect(res.processed).toBe(3);
        expect(res.total).toBe(3);
        expect(state.upsertedCoinListBatches!.length).toBe(1);
        expect(state.upsertedCoinListBatches![0]!.map(c => c.id)).toEqual(['bitcoin', 'ethereum', 'solana']);
        expect(state.upsertedCoinListBatches![0]![0]!.syncedAt).toBe(FIXED_NOW);
    });

    it('records failed batches but does not throw when upsert rejects', async () => {
        const coins: CoingeckoCoinListItem[] = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} }];
        const { deps } = makeDeps({ state: { coinListResult: coins, coinListUpsertThrows: true } });
        const res = await syncCoingeckoCoinList(deps, {});
        expect(res.ok).toBe(true);
        expect(res.failedBatches).toBe(1);
    });

    it('falls back to per-coin upserts so a failed batch does not strand valid coins', async () => {
        const coins: CoingeckoCoinListItem[] = [
            { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} },
            { id: 'ethereum', symbol: 'eth', name: 'Ethereum', platforms: {} },
            { id: 'solana', symbol: 'sol', name: 'Solana', platforms: {} },
        ];
        const { deps, state } = makeDeps({
            state: {
                coinListResult: coins,
                // Whole-batch upsert fails, but each single-row retry succeeds
                // (except solana, which stays genuinely unwriteable).
                coinListUpsertThrowsForMultiRow: true,
                coinListUpsertThrowsForCoinIds: ['solana'],
            },
        });
        const res = await syncCoingeckoCoinList(deps, { batchSize: 25 });
        expect(res.ok).toBe(true);
        expect(res.failedBatches).toBe(1);
        // Only the genuinely-bad coin is left unsynced; the rest recover.
        expect(res.failedCoins).toBe(1);
        const syncedIds = state.upsertedCoinListBatches!.flat().map(c => c.id).sort();
        expect(syncedIds).toEqual(['bitcoin', 'ethereum']);
    });

    it('throws InvalidArgsError when coingecko deps are missing', async () => {
        const { deps } = makeDeps();
        delete (deps as { coingecko?: unknown }).coingecko;
        await expect(syncCoingeckoCoinList(deps, {})).rejects.toThrow(InvalidArgsError);
    });
});

describe('refreshCuratedCoingeckoMetadata', () => {
    it('skips coins whose metadata was recently fetched and upserts the rest', async () => {
        const coinById: Record<string, unknown> = {
            bitcoin: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} },
            ethereum: { id: 'ethereum', symbol: 'eth', name: 'Ethereum', platforms: {} },
        };
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'ethereum'],
            state: {
                metadataLastByCoinId: { bitcoin: FIXED_NOW - 10_000 },
                coinByIdResult: coinById,
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, {
            maxCoins: 2,
            minAgeMs: 24 * 60 * 60 * 1000,
            delayMs: 0,
        });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.skipped).toBe(1);
        expect(state.upsertedMetadata!.map(m => m.id)).toEqual(['ethereum']);
    });

    it('skips curated coins missing from the synced coin list', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'delisted-xstock'],
            state: {
                knownCoinIds: ['bitcoin'],
                coinByIdResult: { bitcoin: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} } },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(0);
        expect(state.upsertedMetadata!.map(m => m.id)).toEqual(['bitcoin']);
    });

    it('drops coins whose coin-list row went stale (delisted upstream)', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'caterpillar-xstock'],
            state: {
                knownCoinIds: ['bitcoin', 'caterpillar-xstock'],
                coinLastSyncedAtByCoinId: {
                    bitcoin: FIXED_NOW - 60_000,
                    'caterpillar-xstock': FIXED_NOW - 16 * 24 * 60 * 60 * 1000,
                },
                coinByIdResult: { bitcoin: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} } },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(0);
        expect(state.upsertedMetadata!.map(m => m.id)).toEqual(['bitcoin']);
    });

    it('fails open when every coin-list row is stale (broken sync, not mass delisting)', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'ethereum'],
            state: {
                knownCoinIds: ['bitcoin', 'ethereum'],
                coinLastSyncedAtByCoinId: {
                    bitcoin: FIXED_NOW - 16 * 24 * 60 * 60 * 1000,
                    ethereum: FIXED_NOW - 16 * 24 * 60 * 60 * 1000,
                },
                coinByIdResult: {
                    bitcoin: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} },
                    ethereum: { id: 'ethereum', symbol: 'eth', name: 'Ethereum', platforms: {} },
                },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.refreshed).toBe(2);
        expect(state.upsertedMetadata!.map(m => m.id).sort()).toEqual(['bitcoin', 'ethereum']);
    });

    it('drops the whole batch when every id is delisted but the coin list itself is fresh', async () => {
        const { deps, state } = makeDeps({
            curated: ['nike-xstock', 'servicenow-xstock'],
            state: {
                knownCoinIds: ['bitcoin'],
                coinLastSyncedAtByCoinId: { bitcoin: FIXED_NOW - 60_000 },
                coinByIdResult: {
                    'nike-xstock': { id: 'nike-xstock', symbol: 'nikex', name: 'Nike xStock', platforms: {} },
                    'servicenow-xstock': { id: 'servicenow-xstock', symbol: 'nowx', name: 'ServiceNow xStock', platforms: {} },
                },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(0);
        expect(state.upsertedMetadata!).toEqual([]);
    });

    it('fails open when the synced coin list is empty', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin'],
            state: {
                knownCoinIds: [],
                coinByIdResult: { bitcoin: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: {} } },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.refreshed).toBe(1);
        expect(state.upsertedMetadata!.map(m => m.id)).toEqual(['bitcoin']);
    });

    it('counts http failures and continues', async () => {
        const { deps, state } = makeDeps({
            curated: ['fail', 'ok'],
            state: {
                coinByIdResult: { ok: { id: 'ok', symbol: 'ok', name: 'Ok', platforms: {} } },
                coinByIdThrows: { fail: true },
            },
        });
        const res = await refreshCuratedCoingeckoMetadata(deps, { maxCoins: 2, minAgeMs: 0, delayMs: 0, concurrency: 1 });
        expect(res.failed).toBe(1);
        expect(res.refreshed).toBe(1);
        expect(state.upsertedMetadata!.map(m => m.id)).toEqual(['ok']);
    });
});

describe('refreshCuratedCoingeckoTickers', () => {
    it('skips curated coins missing from the synced coin list', async () => {
        const { deps } = makeDeps({
            curated: ['bitcoin', 'delisted-xstock'],
            state: {
                knownCoinIds: ['bitcoin'],
                tickerPagesByCoinId: { bitcoin: [{ name: 'Bitcoin', tickers: [], total: 0 }] },
            },
        });
        const res = await refreshCuratedCoingeckoTickers(deps, { maxCoins: 10, minAgeMs: 0, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(0);
        expect(res.processed).toBe(1);
    });

    it('fetches pages, normalizes rows, and upserts', async () => {
        const tickerRaw = {
            base: 'BTC',
            target: 'USDT',
            market: { name: 'Binance', identifier: 'binance', has_trading_incentive: false },
            converted_last: { usd: 50_000 },
            converted_volume: { usd: 1_000_000 },
            bid_ask_spread_percentage: 0.01,
            is_anomaly: false,
            is_stale: false,
            trade_url: 'https://binance.com',
            timestamp: '2026-06-01T00:00:00Z',
            trust_score: 'green',
        };
        const { deps, state } = makeDeps({
            curated: ['bitcoin'],
            state: {
                tickerPagesByCoinId: {
                    bitcoin: [
                        { name: 'Bitcoin', tickers: [tickerRaw, tickerRaw], total: 2 },
                        { tickers: [] },
                    ],
                },
            },
        });
        const res = await refreshCuratedCoingeckoTickers(deps, {
            maxCoins: 1,
            minAgeMs: 0,
            delayMs: 0,
            maxTickers: 200,
        });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(state.upsertedTickers!.length).toBe(1);
        expect(state.upsertedTickers![0]!.tickers.length).toBe(2);
        expect(state.upsertedTickers![0]!.name).toBe('Bitcoin');
    });

    it('touches the row when the upstream throws', async () => {
        const { deps, state } = makeDeps({
            curated: ['fail'],
            state: { tickerPagesThrows: { fail: true } },
        });
        const res = await refreshCuratedCoingeckoTickers(deps, { maxCoins: 1, minAgeMs: 0, delayMs: 0 });
        expect(res.failed).toBe(1);
        expect(state.touchedTickers!.length).toBe(1);
        expect(state.touchedTickers![0]!.coinId).toBe('fail');
    });
});

describe('refreshCuratedCoingeckoPrices', () => {
    it('skips curated coins missing from the synced coin list', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'delisted-xstock'],
            state: {
                knownCoinIds: ['bitcoin'],
                simplePriceResult: { bitcoin: { usd: 1 } },
            },
        });
        const res = await refreshCuratedCoingeckoPrices(deps, { maxCoins: 10, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(state.upsertedPrices!.map(x => x.coinId)).toEqual(['bitcoin']);
    });

    it('fetches simple/price and upserts each coin', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'ethereum'],
            state: {
                simplePriceResult: {
                    bitcoin: { usd: 50_000, usd_market_cap: 1e12, usd_24h_vol: 1e9, usd_24h_change: 1.5 },
                    ethereum: { usd: 3000, usd_market_cap: 4e11, usd_24h_vol: 5e8, usd_24h_change: -0.5 },
                },
            },
        });
        const res = await refreshCuratedCoingeckoPrices(deps, { maxCoins: 2, chunkSize: 200, delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(2);
        expect(state.upsertedPrices!.map(p => p.coinId)).toEqual(['bitcoin', 'ethereum']);
        expect(state.upsertedPrices![0]!.priceUsd).toBe(50_000);
    });

    it('counts per-coin upsert failures', async () => {
        const { deps } = makeDeps({
            curated: ['bitcoin', 'ethereum'],
            state: {
                simplePriceResult: { bitcoin: { usd: 1 }, ethereum: { usd: 2 } },
                priceUpsertThrowsForCoinIds: ['bitcoin'],
            },
        });
        const res = await refreshCuratedCoingeckoPrices(deps, { maxCoins: 2, delayMs: 0 });
        expect(res.failed).toBe(1);
        expect(res.refreshed).toBe(1);
    });
});

describe('refreshCuratedCoingeckoPrices explicit coinIds', () => {
    it('uses args.coinIds instead of the curated selection and keeps freshness dedup', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'ethereum'],
            state: {
                simplePriceResult: { solana: { usd: 200 }, jupiter: { usd: 1 } },
                priceLastByCoinId: { jupiter: FIXED_NOW - 1_000 },
            },
        });
        const res = await refreshCuratedCoingeckoPrices(deps, {
            coinIds: ['solana', 'jupiter'],
            minAgeMs: 60_000,
            delayMs: 0,
        });
        expect(res.refreshed).toBe(1);
        expect(res.skipped).toBe(1);
        expect(state.upsertedPrices!.map(p => p.coinId)).toEqual(['solana']);
    });

    it('dedupes and caps explicit coinIds at 250', async () => {
        const coinIds = Array.from({ length: 300 }, (_, i) => `coin${i}`);
        const simplePriceResult: CGState['simplePriceResult'] = {};
        for (const id of coinIds) simplePriceResult[id] = { usd: 1 };
        const { deps, state } = makeDeps({ state: { simplePriceResult } });
        const res = await refreshCuratedCoingeckoPrices(deps, {
            coinIds: [...coinIds, 'coin0', ' coin1 '],
            chunkSize: 250,
            delayMs: 0,
        });
        expect(res.processed).toBe(250);
        expect(state.upsertedPrices!.length).toBe(250);
    });

    it('rejects non-string entries in args.coinIds', async () => {
        const { deps } = makeDeps({});
        await expect(refreshCuratedCoingeckoPrices(deps, { coinIds: [42] })).rejects.toThrow(InvalidArgsError);
    });
});

describe('refreshCuratedCoingeckoOhlcv', () => {
    it('fetches market_chart/range, builds candles, and upserts when bounds are empty', async () => {
        const intervalSeconds = 60 * 60;
        const t1 = 1_000_000;
        const t2 = t1 + intervalSeconds;
        const { deps, state } = makeDeps({
            curated: ['bitcoin'],
            state: {
                marketChartByCoinId: {
                    bitcoin: {
                        prices: [
                            { time: t1, value: 100 },
                            { time: t1 + 60, value: 110 },
                            { time: t2, value: 120 },
                        ],
                        totalVolumes: [
                            { time: t1, value: 1000 },
                            { time: t2, value: 2000 },
                        ],
                    },
                },
            },
        });
        const res = await refreshCuratedCoingeckoOhlcv(deps, {
            interval: '1H',
            days: 1,
            maxCoins: 1,
            concurrency: 1,
            delayMs: 0,
        });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(state.upsertedOhlcv!.length).toBeGreaterThan(0);
        const totalCandles = state.upsertedOhlcv!.reduce((sum, b) => sum + b.candles.length, 0);
        expect(totalCandles).toBeGreaterThan(0);
    });

    it('skips curated coins missing from the synced CoinGecko coin list', async () => {
        const { deps, state } = makeDeps({
            curated: ['bitcoin', 'delisted-xstock'],
            state: {
                knownCoinIds: ['bitcoin'],
                marketChartByCoinId: {
                    bitcoin: {
                        prices: [{ time: 1_000_000, value: 100 }],
                        totalVolumes: [{ time: 1_000_000, value: 1000 }],
                    },
                },
            },
        });
        const res = await refreshCuratedCoingeckoOhlcv(deps, {
            interval: '1H',
            days: 1,
            maxCoins: 10,
            concurrency: 1,
            delayMs: 0,
        });
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(0);
        expect(state.marketChartCalls ?? []).not.toContain('delisted-xstock');
        expect(state.marketChartCalls ?? []).toContain('bitcoin');
    });

    it('counts failures when market_chart throws', async () => {
        const { deps } = makeDeps({
            curated: ['fail'],
            state: { marketChartThrows: { fail: true } },
        });
        const res = await refreshCuratedCoingeckoOhlcv(deps, {
            interval: '1H',
            days: 7,
            maxCoins: 1,
            concurrency: 1,
            delayMs: 0,
        });
        expect(res.failed).toBe(1);
        expect(res.refreshed).toBe(0);
    });

    it('rejects invalid interval', async () => {
        const { deps } = makeDeps({ curated: ['bitcoin'] });
        await expect(
            refreshCuratedCoingeckoOhlcv(deps, { interval: 'bogus', days: 1, delayMs: 0 }),
        ).rejects.toThrow(InvalidArgsError);
    });
});

describe('__testing helpers', () => {
    it('parses a coin list payload skipping invalid entries', () => {
        const out = __testing.parseCoinListPayload([
            { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', platforms: { ethereum: '0x1' } },
            { id: '', symbol: 'x', name: 'X' },
            { symbol: 'no-id', name: 'NoId' },
            { id: 'eth', symbol: 'eth', name: 'Ethereum' },
        ]);
        expect(out.map(c => c.id)).toEqual(['bitcoin', 'eth']);
        expect(out[0]!.platforms).toEqual({ ethereum: '0x1' });
    });

    it('normalizes ticker rows and drops invalid ones', () => {
        const ok = __testing.normalizeTickerRow({
            base: 'BTC',
            target: 'USDT',
            market: { name: 'Binance' },
            converted_last: { usd: 1 },
        });
        expect(ok?.base).toBe('BTC');
        const bad = __testing.normalizeTickerRow({ base: 'BTC' });
        expect(bad).toBeNull();
    });

    it('sanitizes coin metadata payloads', () => {
        const out = __testing.sanitizeCoinMetadata({ id: 'btc', symbol: 'btc', name: 'Bitcoin', platforms: {} });
        expect(out.ok).toBe(true);
        const bad = __testing.sanitizeCoinMetadata({ id: 'btc' });
        expect(bad.ok).toBe(false);
    });

    it('parses interval strings strictly', () => {
        expect(__testing.parseCoingeckoInterval('1H')).toBe('1H');
        expect(() => __testing.parseCoingeckoInterval('bogus')).toThrow(InvalidArgsError);
    });
});
