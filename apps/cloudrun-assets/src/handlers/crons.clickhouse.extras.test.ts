import { describe, expect, it } from 'bun:test';

import type { ClickhouseClient, ClickhouseMintSnapshot } from './crons.clickhouse';
import {
    refreshClickhouseFillQualityVariants,
    refreshClickhouseVariantMarketMetrics,
    refreshPublicEquityStockOhlcv,
    refreshSolanaClickhouseOhlcv,
    refreshSolanaClickhouseTrendingMarkets,
    type ClickhouseExtrasCronDeps,
    type ClickhouseExtrasRepo,
    type TrendingMarketUpsert,
    type VariantFillQualityUpsert,
} from './crons.clickhouse.extras';

interface ClickhouseQueryCall {
    sql: string;
    params?: Record<string, string | number>;
}

interface MakeClickhouseOptions {
    asOfMs?: number | null;
    queryHandler?: (call: ClickhouseQueryCall) => unknown[];
    queryCalls?: ClickhouseQueryCall[];
    mintSnapshots?: (mints: readonly string[]) => ClickhouseMintSnapshot[];
}

function makeClickhouse(overrides: MakeClickhouseOptions = {}): ClickhouseClient {
    const calls = overrides.queryCalls ?? [];
    return {
        async fetchStockInstruments() { return []; },
        async fetchStockSnapshot() { return null; },
        async fetchSharesOutstanding() { return []; },
        async fetchSolanaTradesAsOfMs() {
            return overrides.asOfMs ?? null;
        },
        async fetchSolanaMintSnapshots(params: { mints: readonly string[] }) {
            return overrides.mintSnapshots ? overrides.mintSnapshots(params.mints) : [];
        },
        async queryPreset<T>(name: string, params: Record<string, unknown>): Promise<T[]> {
            const call: ClickhouseQueryCall = { sql: `preset:${name}`, params: params as Record<string, string | number> };
            calls.push(call);
            if (!overrides.queryHandler) return [] as T[];
            return overrides.queryHandler(call) as T[];
        },
    };
}

interface MakeRepoOptions {
    replaceVariantFillQualityCalls?: Array<{
        rows: readonly VariantFillQualityUpsert[];
        replaceMissing: boolean;
        replacementMints: readonly string[];
    }>;
    replaceTrendingCalls?: Array<{ rows: readonly TrendingMarketUpsert[]; replaceMissing: boolean }>;
    upsertSolanaOhlcvCalls?: Array<{
        address: string;
        interval: string;
        source: 'clickhouse_trades';
        candles: readonly unknown[];
    }>;
    upsertStockOhlcvCalls?: Array<{
        assetId: string;
        symbol: string;
        interval: string;
        source: 'clickhouse_stock';
        candles: readonly unknown[];
    }>;
    solanaOhlcvBounds?: (address: string, interval: string) => { minTime: number | null; maxTime: number | null };
    stockOhlcvBounds?: (assetId: string, interval: string) => { minTime: number | null; maxTime: number | null };
    activeStockMappings?: () => Array<{ assetId: string; symbol: string; normalizedSymbol: string }>;
    stableMints?: readonly string[];
    updateVariantMetricsCalls?: Array<{ rows: readonly ClickhouseMintSnapshot[]; lastFetchedAt: number }>;
    registryRows?: ReadonlyMap<string, { logoURI: string | null; name: string | null; decimals: number | null }>;
}

function makeRepo(overrides: MakeRepoOptions = {}): ClickhouseExtrasRepo {
    return {
        async updateVariantMarketMetricsFromClickhouse(args) {
            overrides.updateVariantMetricsCalls?.push(args);
            return { updated: args.rows.length };
        },
        async getStableMints() {
            return [...(overrides.stableMints ?? ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'])];
        },
        async findVariantMarketRegistryRowsByMints(mints) {
            const out: Array<{ mint: string; logoURI: string | null; name: string | null; decimals: number | null }> = [];
            for (const mint of mints) {
                const row = overrides.registryRows?.get(mint);
                if (row) out.push({ mint, ...row });
            }
            return out;
        },
        async replaceTrendingFromClickHouse(args) {
            overrides.replaceTrendingCalls?.push({ rows: args.rows, replaceMissing: args.replaceMissing });
            return { upserted: args.rows.length, deleted: 0 };
        },
        async replaceVariantFillQualityFromClickHouse(args) {
            overrides.replaceVariantFillQualityCalls?.push({
                rows: args.rows,
                replaceMissing: args.replaceMissing,
                replacementMints: args.replacementMints,
            });
            return { upserted: args.rows.length, deleted: 0 };
        },
        async upsertSolanaOhlcv(args) {
            overrides.upsertSolanaOhlcvCalls?.push({
                address: args.address,
                interval: args.interval,
                source: args.source,
                candles: args.candles,
            });
            return { inserted: args.candles.length, updated: 0, skipped: 0 };
        },
        async upsertStockOhlcv(args) {
            overrides.upsertStockOhlcvCalls?.push({
                assetId: args.assetId,
                symbol: args.symbol,
                interval: args.interval,
                source: args.source,
                candles: args.candles,
            });
            return { inserted: args.candles.length, updated: 0, skipped: 0 };
        },
        async getSolanaOhlcvBounds(address, interval) {
            return overrides.solanaOhlcvBounds
                ? overrides.solanaOhlcvBounds(address, interval)
                : { minTime: null, maxTime: null };
        },
        async getStockOhlcvBounds(assetId, interval) {
            return overrides.stockOhlcvBounds
                ? overrides.stockOhlcvBounds(assetId, interval)
                : { minTime: null, maxTime: null };
        },
        async listActiveStockMappings() {
            return overrides.activeStockMappings ? overrides.activeStockMappings() : [];
        },
    };
}

interface MakeDepsOptions {
    curated?: readonly string[];
    repo?: ClickhouseExtrasRepo;
    clickhouse?: ClickhouseClient;
}

function makeDeps(env: NodeJS.ProcessEnv = {}, overrides: MakeDepsOptions = {}): ClickhouseExtrasCronDeps {
    return {
        clickhouse: overrides.clickhouse ?? makeClickhouse(),
        repo: overrides.repo ?? makeRepo(),
        curated: { getAllCuratedMintsInOrder: () => [...(overrides.curated ?? [])] },
        now: () => 1_780_000_000_000,
        env: () => env,
    };
}

describe('refreshSolanaClickhouseTrendingMarkets', () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('returns disabled=true when CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED is not set', async () => {
        const res = await refreshSolanaClickhouseTrendingMarkets(makeDeps({}), {});
        expect(res.disabled).toBe(true);
    });

    it('reports skippedNoTrades when ClickHouse has no asOf row', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const clickhouse = makeClickhouse({
            queryHandler: () => [],
        });
        const res = await refreshSolanaClickhouseTrendingMarkets(
            makeDeps(env, { clickhouse, curated: [SOL] }),
            {},
        );
        expect(res.disabled).toBe(false);
        expect(res.requested).toBe(1);
        expect(res.skippedNoTrades).toBe(1);
        expect(res.asOf).toBe(null);
    });

    it('skips replacement when no scored rows survive eligibility (prevents wiping trending_markets)', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const asOfMs = 1_700_000_000_000;
        const clickhouse = makeClickhouse({
            asOfMs,
            queryHandler: () => {
                return [
                    {
                        mint: SOL_MINT,
                        priceUsd: 100,
                        volume24hUsd: 1,
                        trade24h: 0,
                        lastTradeAtMs: null,
                    },
                ];
            },
        });
        const replaceTrendingCalls: Array<{
            rows: readonly TrendingMarketUpsert[];
            replaceMissing: boolean;
        }> = [];
        const repo = makeRepo({ replaceTrendingCalls, stableMints: [] });
        const res = await refreshSolanaClickhouseTrendingMarkets(
            makeDeps(env, { clickhouse, repo, curated: [SOL_MINT] }),
            {},
        );
        expect(res.scored).toBe(0);
        expect(replaceTrendingCalls.length).toBe(0);
    });

    it('scores eligible snapshots, writes to repo, and excludes ineligible ones', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
        const asOfMs = 1_700_000_000_000;
        const asOfSec = Math.floor(asOfMs / 1000);
        const clickhouse = makeClickhouse({
            asOfMs,
            queryHandler: () => {
                return [
                    {
                        mint: WETH,
                        priceUsd: 3500,
                        volume5mUsd: 100_000,
                        volume15mUsd: 250_000,
                        volume1hUsd: 1_000_000,
                        volume6hUsd: 5_000_000,
                        volume24hUsd: 20_000_000,
                        trade5m: 500,
                        trade15m: 1_500,
                        trade1h: 5_000,
                        trade6h: 20_000,
                        trade24h: 50_000,
                        uniqueTrader5m: 150,
                        uniqueTrader1h: 1_000,
                        uniqueTrader24h: 5_000,
                        price1hAgo: 3450,
                        price24hAgo: 3400,
                        lastTradeAtMs: asOfMs - 60_000,
                    },
                    {
                        mint: USDC,
                        priceUsd: 1,
                        volume24hUsd: 1_000_000,
                        trade24h: 10,
                        lastTradeAtMs: asOfMs - 1_000,
                    },
                ];
            },
        });
        const replaceTrendingCalls: Array<{
            rows: readonly TrendingMarketUpsert[];
            replaceMissing: boolean;
        }> = [];
        const repo = makeRepo({
            replaceTrendingCalls,
            stableMints: [USDC],
            registryRows: new Map([
                [WETH, { logoURI: 'https://logo/weth.png', name: 'Wrapped Ether', decimals: 8 }],
            ]),
        });
        const res = await refreshSolanaClickhouseTrendingMarkets(
            makeDeps(env, { clickhouse, repo, curated: [WETH, USDC] }),
            {},
        );
        expect(res.disabled).toBe(false);
        expect(res.requested).toBe(2);
        expect(res.scored).toBe(1);
        expect(res.skippedIneligible).toBeGreaterThanOrEqual(1);
        expect(res.asOf).toBe(asOfSec);
        expect(replaceTrendingCalls.length).toBe(1);
        expect(replaceTrendingCalls[0]!.replaceMissing).toBe(true);
        const row = replaceTrendingCalls[0]!.rows[0]!;
        expect(row.mint).toBe(WETH);
        expect(row.scoringVersion).toBe('solana-direct-stable-v1');
        expect(row.rank).toBe(1);
        expect(row.trendingScore).toBeGreaterThan(0);
        expect(row.logoURI).toBe('https://logo/weth.png');
        expect(row.decimals).toBe(8);
    });

    it('uses scored rows when explicit mints are passed even without crypto category', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const WETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
        const asOfMs = 1_700_000_000_000;
        const clickhouse = makeClickhouse({
            asOfMs,
            queryHandler: () => {
                return [
                    {
                        mint: WETH,
                        priceUsd: 3500,
                        volume24hUsd: 200_000,
                        trade24h: 100,
                        lastTradeAtMs: asOfMs - 60_000,
                    },
                ];
            },
        });
        const replaceTrendingCalls: Array<{
            rows: readonly TrendingMarketUpsert[];
            replaceMissing: boolean;
        }> = [];
        const repo = makeRepo({
            replaceTrendingCalls,
            stableMints: [USDC],
        });
        const res = await refreshSolanaClickhouseTrendingMarkets(
            makeDeps(env, { clickhouse, repo }),
            { mints: [WETH] },
        );
        expect(res.scored).toBe(1);
        expect(replaceTrendingCalls.length).toBe(1);
        expect(replaceTrendingCalls[0]!.replaceMissing).toBe(false);
    });
});

describe('refreshClickhouseVariantMarketMetrics', () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };

    function snapshot(mint: string): ClickhouseMintSnapshot {
        return {
            mint,
            priceUsd: 150,
            volume1hUsd: 1000,
            volume24hUsd: 24000,
            trade1h: 10,
            trade24h: 240,
            uniqueTrader1h: 5,
            uniqueTrader24h: 50,
            priceChange1hPercent: 1.5,
            priceChange24hPercent: -2,
            lastTradeAt: 1_779_999_999,
            asOf: 1_780_000_000,
        };
    }

    it('is disabled when the refresh flag is off', async () => {
        const res = await refreshClickhouseVariantMarketMetrics(makeDeps({}, { curated: [SOL] }), {});
        expect(res.disabled).toBe(true);
        expect(res.processed).toBe(0);
    });

    it('updates curated mints from mint snapshots', async () => {
        const calls: Array<{ rows: readonly ClickhouseMintSnapshot[]; lastFetchedAt: number }> = [];
        const repo = makeRepo({ updateVariantMetricsCalls: calls });
        const clickhouse = makeClickhouse({ mintSnapshots: mints => mints.map(snapshot) });
        const res = await refreshClickhouseVariantMarketMetrics(
            makeDeps(env, { clickhouse, repo, curated: [SOL, USDC] }),
            { delayMs: 0 },
        );
        expect(res.ok).toBe(true);
        expect(res.updated).toBe(2);
        expect(res.failed).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.rows.map(r => r.mint)).toEqual([SOL, USDC]);
        expect(calls[0]!.lastFetchedAt).toBe(1_780_000_000_000);
    });

    it('counts failed chunks without throwing; total failure reports ok=false', async () => {
        const clickhouse = makeClickhouse({
            mintSnapshots: () => {
                throw new Error('clickhouse-api HTTP 500');
            },
        });
        const res = await refreshClickhouseVariantMarketMetrics(
            makeDeps(env, { clickhouse, curated: [SOL, USDC] }),
            { delayMs: 0 },
        );
        // Every chunk failed and nothing was updated -> total failure -> 500
        // so Cloud Scheduler records the run as failed (retry_count is 0 for
        // this 1-minute job; the next tick is the retry).
        expect(res.ok).toBe(false);
        expect(res.updated).toBe(0);
        expect(res.failed).toBe(2);
    });
});

describe('refreshClickhouseFillQualityVariants', () => {
    const MINT_A = 'So11111111111111111111111111111111111111112';
    const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('returns disabled=true when CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED is not set', async () => {
        const res = await refreshClickhouseFillQualityVariants(makeDeps({}), {});
        expect(res.disabled).toBe(true);
        expect(res.refreshed).toBe(0);
    });

    it('reports skippedMissing when ClickHouse has no as-of row', async () => {
        const env = { CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED: 'true' };
        const clickhouse = makeClickhouse({
            queryHandler: () => [],
        });
        const res = await refreshClickhouseFillQualityVariants(
            makeDeps(env, { clickhouse, curated: [MINT_A] }),
            {},
        );
        expect(res.disabled).toBe(false);
        expect(res.requested).toBe(1);
        expect(res.skippedMissing).toBe(1);
        expect(res.asOf).toBe(null);
    });

    it('upserts rows derived from ClickHouse snapshots and computes scores', async () => {
        const env = { CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED: 'true' };
        const asOfMs = 1_700_000_000_000;
        let callIdx = 0;
        const clickhouse = makeClickhouse({
            queryHandler: () => {
                callIdx += 1;
                if (callIdx === 1) return [{ asOfMs }];
                return [
                    {
                        mint: MINT_A,
                        quoteMint: QUOTE,
                        volume24hUSD: 5_000_000,
                        trade24h: 5_000,
                        botVolume24hUSD: 500_000,
                        botTrade24h: 500,
                        fee24hUSD: 25_000,
                        flowSourceCount: 5,
                        markoutPnl24hUSD: 1_000,
                        markoutCount: 4_000,
                        asOfMs,
                    },
                ];
            },
        });
        const replaceCalls: Array<{
            rows: readonly VariantFillQualityUpsert[];
            replaceMissing: boolean;
            replacementMints: readonly string[];
        }> = [];
        const repo = makeRepo({ replaceVariantFillQualityCalls: replaceCalls });
        const res = await refreshClickhouseFillQualityVariants(
            makeDeps(env, { clickhouse, repo, curated: [MINT_A] }),
            {},
        );
        expect(res.disabled).toBe(false);
        expect(res.refreshed).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.asOf).toBe(Math.floor(asOfMs / 1000));
        expect(replaceCalls.length).toBe(1);
        const row = replaceCalls[0]!.rows[0]!;
        expect(row.mint).toBe(MINT_A);
        expect(row.botVolumeRatio).toBeCloseTo(0.1, 5);
        expect(row.feeBps).toBeCloseTo(50, 5);
        expect(row.markoutBps).toBeCloseTo(2, 5);
        expect(row.executionScore).toBeGreaterThan(0);
        expect(replaceCalls[0]!.replaceMissing).toBe(true);
    });

    it('does not replaceMissing when explicit mints are passed', async () => {
        const env = { CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED: 'true' };
        const asOfMs = 1_700_000_000_000;
        let callIdx = 0;
        const clickhouse = makeClickhouse({
            queryHandler: () => {
                callIdx += 1;
                if (callIdx === 1) return [{ asOfMs }];
                return [];
            },
        });
        const replaceCalls: Array<{
            rows: readonly VariantFillQualityUpsert[];
            replaceMissing: boolean;
            replacementMints: readonly string[];
        }> = [];
        const repo = makeRepo({ replaceVariantFillQualityCalls: replaceCalls });
        const res = await refreshClickhouseFillQualityVariants(
            makeDeps(env, { clickhouse, repo }),
            { mints: [MINT_A] },
        );
        expect(res.disabled).toBe(false);
        expect(res.requested).toBe(1);
        expect(replaceCalls.length).toBe(1);
        expect(replaceCalls[0]!.replaceMissing).toBe(false);
    });
});

describe('refreshSolanaClickhouseOhlcv', () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('returns disabled=true when CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED is not set', async () => {
        const res = await refreshSolanaClickhouseOhlcv(makeDeps({}), { interval: '1H' });
        expect(res.disabled).toBe(true);
        expect(res.interval).toBe('1H');
    });

    it('rejects unknown intervals', async () => {
        await expect(
            refreshSolanaClickhouseOhlcv(makeDeps({ CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' }), {
                interval: '17m',
            }),
        ).rejects.toThrow(/interval must be one of/);
    });

    it('fetches candles per mint, calls upsertSolanaOhlcv for each chunk', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const asOfMs = 1_700_000_000_000;
        const fakeCandle = {
            time: Math.floor(asOfMs / 1000) - 3600,
            open: 100,
            high: 110,
            low: 95,
            close: 105,
            volume: 500_000,
            tradeCount: 12,
        };
        const clickhouse = makeClickhouse({
            asOfMs,
            queryHandler: () => {
                return [fakeCandle];
            },
        });
        const upsertCalls: Array<{
            address: string;
            interval: string;
            source: 'clickhouse_trades';
            candles: readonly unknown[];
        }> = [];
        const repo = makeRepo({
            upsertSolanaOhlcvCalls: upsertCalls,
            stableMints: [USDC],
            solanaOhlcvBounds: () => ({ minTime: null, maxTime: null }),
        });
        const res = await refreshSolanaClickhouseOhlcv(
            makeDeps(env, { clickhouse, repo }),
            { mints: [SOL], interval: '1H', concurrency: 1 },
        );
        expect(res.disabled).toBe(false);
        expect(res.interval).toBe('1H');
        expect(res.requested).toBe(1);
        expect(res.refreshed).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.inserted).toBe(1);
        expect(upsertCalls.length).toBe(1);
        expect(upsertCalls[0]!.address).toBe(SOL);
        expect(upsertCalls[0]!.interval).toBe('1H');
        expect(upsertCalls[0]!.source).toBe('clickhouse_trades');
        expect(upsertCalls[0]!.candles.length).toBe(1);
    });

    it('skips when bounds are already filled', async () => {
        const env = { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' };
        const asOfMs = 1_700_000_000_000;
        const asOfSec = Math.floor(asOfMs / 1000);
        const clickhouse = makeClickhouse({
            asOfMs,
            queryHandler: () => {
                return [];
            },
        });
        const upsertCalls: Array<{
            address: string;
            interval: string;
            source: 'clickhouse_trades';
            candles: readonly unknown[];
        }> = [];
        const repo = makeRepo({
            upsertSolanaOhlcvCalls: upsertCalls,
            stableMints: [USDC],
            solanaOhlcvBounds: () => ({
                minTime: asOfSec - 24 * 60 * 60,
                maxTime: asOfSec - 60,
            }),
        });
        const res = await refreshSolanaClickhouseOhlcv(
            makeDeps(env, { clickhouse, repo }),
            { mints: [SOL], interval: '1H', days: 1, concurrency: 1 },
        );
        expect(res.refreshed).toBe(0);
        expect(res.skipped).toBe(1);
        expect(upsertCalls.length).toBe(0);
    });
});

describe('refreshPublicEquityStockOhlcv', () => {
    it('returns disabled=true when CLICKHOUSE_STOCK_REFRESH_ENABLED is not set', async () => {
        const res = await refreshPublicEquityStockOhlcv(makeDeps({}), { interval: '1H' });
        expect(res.disabled).toBe(true);
    });

    it('rejects unknown intervals', async () => {
        await expect(
            refreshPublicEquityStockOhlcv(
                makeDeps({ CLICKHOUSE_STOCK_REFRESH_ENABLED: 'true' }),
                { interval: '2H' },
            ),
        ).rejects.toThrow(/interval must be one of/);
    });

    it('returns processed=0 when there are no active mappings', async () => {
        const env = { CLICKHOUSE_STOCK_REFRESH_ENABLED: 'true' };
        const res = await refreshPublicEquityStockOhlcv(
            makeDeps(env),
            { interval: '1H' },
        );
        expect(res.processed).toBe(0);
        expect(res.requested).toBe(0);
    });

    it('fetches and upserts stock candles for each selected mapping', async () => {
        const env = { CLICKHOUSE_STOCK_REFRESH_ENABLED: 'true' };
        const candle = {
            time: 1_700_000_000,
            open: 150,
            high: 160,
            low: 145,
            close: 155,
            volume: 100_000,
        };
        const clickhouse = makeClickhouse({
            queryHandler: () => [candle],
        });
        const upsertCalls: Array<{
            assetId: string;
            symbol: string;
            interval: string;
            source: 'clickhouse_stock';
            candles: readonly unknown[];
        }> = [];
        const repo = makeRepo({
            upsertStockOhlcvCalls: upsertCalls,
            activeStockMappings: () => [{ assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' }],
            stockOhlcvBounds: () => ({ minTime: null, maxTime: null }),
        });
        const res = await refreshPublicEquityStockOhlcv(
            makeDeps(env, { clickhouse, repo }),
            { interval: '4H', concurrency: 1 },
        );
        expect(res.disabled).toBe(false);
        expect(res.interval).toBe('4H');
        expect(res.refreshed).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.inserted).toBe(1);
        expect(upsertCalls.length).toBe(1);
        expect(upsertCalls[0]!.assetId).toBe('aapl');
        expect(upsertCalls[0]!.source).toBe('clickhouse_stock');
        expect(upsertCalls[0]!.interval).toBe('4H');
    });

    it('skips assets whose bounds already cover the requested range', async () => {
        const env = { CLICKHOUSE_STOCK_REFRESH_ENABLED: 'true' };
        const clickhouse = makeClickhouse({
            queryHandler: () => [],
        });
        const upsertCalls: Array<{
            assetId: string;
            symbol: string;
            interval: string;
            source: 'clickhouse_stock';
            candles: readonly unknown[];
        }> = [];
        const nowSec = Math.floor(1_780_000_000_000 / 1000);
        const repo = makeRepo({
            upsertStockOhlcvCalls: upsertCalls,
            activeStockMappings: () => [{ assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' }],
            stockOhlcvBounds: () => ({
                minTime: nowSec - 24 * 60 * 60,
                maxTime: nowSec - 60,
            }),
        });
        const res = await refreshPublicEquityStockOhlcv(
            makeDeps(env, { clickhouse, repo }),
            { interval: '1H', days: 1, concurrency: 1 },
        );
        expect(res.refreshed).toBe(0);
        expect(res.skipped).toBe(1);
        expect(upsertCalls.length).toBe(0);
    });
});
