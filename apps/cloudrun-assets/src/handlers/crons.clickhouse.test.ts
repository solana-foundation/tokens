import { describe, expect, it } from 'bun:test';

import {
    refreshPublicEquitySharesOutstanding,
    refreshPublicEquityStockPrices,
    refreshSolanaClickhouseTradeSnapshots,
    syncClickhouseStockMappings,
    __testing,
    type ActiveStockMapping,
    type ClickhouseClient,
    type ClickhouseCronDeps,
    type ClickhouseMintSnapshot,
    type ClickhouseRepo,
    type ClickhouseSharesOutstandingRow,
    type ClickhouseStockInstrumentRow,
    type ClickhouseStockSnapshot,
    type CuratedMintsForClickhouse,
    type SolanaTradeSnapshotUpsert,
    type StockInstrumentUpsert,
    type StockPriceUpsert,
    type StockSharesOutstandingUpdate,
} from './crons.clickhouse';

const FIXED_NOW = 1_780_000_000_000;

interface MockState {
    mappableAssets?: Array<{ assetId: string; category: string; name?: string; symbol?: string; aliases?: string[] }>;
    stockMappings?: ActiveStockMapping[];
    stableMints?: string[];
    registryByMint?: Record<string, { symbol?: string; name?: string }>;
    upsertedInstruments?: StockInstrumentUpsert[];
    upsertedPrices?: StockPriceUpsert[];
    upsertedSolanaSnapshots?: SolanaTradeSnapshotUpsert[];
    sharesUpdates?: StockSharesOutstandingUpdate[];
    /** assetIds with no stock_prices_latest row (updateStockSharesOutstanding returns updated: 0). */
    sharesUpdateMissingAssetIds?: string[];
    failSharesUpdate?: boolean;
}

function makeRepo(state: MockState = {}): ClickhouseRepo {
    state.upsertedInstruments ??= [];
    state.upsertedPrices ??= [];
    state.upsertedSolanaSnapshots ??= [];
    return {
        async listStockMappableAssets() {
            return state.mappableAssets ?? [];
        },
        async listActiveStockMappings() {
            return state.stockMappings ?? [];
        },
        async upsertStockInstruments(rows) {
            for (const r of rows) state.upsertedInstruments!.push(r);
            return { upserted: rows.length, skipped: 0 };
        },
        async upsertStockPriceLatest(args) {
            state.upsertedPrices!.push(args);
        },
        async updateStockSharesOutstanding(args) {
            if (state.failSharesUpdate) throw new Error('shares update failed');
            if (state.sharesUpdateMissingAssetIds?.includes(args.assetId)) return { updated: 0 };
            state.sharesUpdates ??= [];
            state.sharesUpdates.push(args);
            return { updated: 1 };
        },
        async upsertVariantMarketFromClickhouse(args) {
            state.upsertedSolanaSnapshots!.push(args);
        },
        async getStableMints() {
            return state.stableMints ?? [];
        },
        async getRegistryIdentityByMint(mint) {
            return state.registryByMint?.[mint] ?? null;
        },
    };
}

function makeCurated(mints: readonly string[]): CuratedMintsForClickhouse {
    return { getAllCuratedMintsInOrder: () => Array.from(mints) };
}

interface MockClickhouseOpts {
    instruments?: ClickhouseStockInstrumentRow[];
    snapshotsBySymbol?: Record<string, ClickhouseStockSnapshot | null>;
    asOfMs?: number | null;
    solanaSnapshotsByMint?: Record<string, ClickhouseMintSnapshot>;
    sharesBySymbol?: Record<string, ClickhouseSharesOutstandingRow>;
    failStockInstruments?: boolean;
    failStockSnapshot?: boolean;
    failSolanaSnapshots?: boolean;
    failSharesOutstanding?: boolean;
}

function makeClickhouse(opts: MockClickhouseOpts = {}): ClickhouseClient {
    return {
        async fetchStockInstruments() {
            if (opts.failStockInstruments) throw new Error('clickhouse stock instruments down');
            return opts.instruments ?? [];
        },
        async fetchStockSnapshot(symbol) {
            if (opts.failStockSnapshot) throw new Error('clickhouse stock snapshot down');
            return opts.snapshotsBySymbol?.[symbol] ?? null;
        },
        async fetchSharesOutstanding(symbols) {
            if (opts.failSharesOutstanding) throw new Error('clickhouse shares outstanding down');
            const out: ClickhouseSharesOutstandingRow[] = [];
            for (const symbol of symbols) {
                const row = opts.sharesBySymbol?.[symbol];
                if (row) out.push(row);
            }
            return out;
        },
        async fetchSolanaTradesAsOfMs() {
            return opts.asOfMs ?? null;
        },
        async fetchSolanaMintSnapshots(args) {
            if (opts.failSolanaSnapshots) throw new Error('clickhouse solana snapshots down');
            const out: ClickhouseMintSnapshot[] = [];
            for (const mint of args.mints) {
                const snap = opts.solanaSnapshotsByMint?.[mint];
                if (snap) out.push(snap);
            }
            return out;
        },
        async queryPreset() { return []; },
    };
}

function makeDeps(overrides: {
    state?: MockState;
    curatedMints?: readonly string[];
    clickhouse?: MockClickhouseOpts;
    env?: NodeJS.ProcessEnv;
} = {}): { deps: ClickhouseCronDeps; state: MockState } {
    const state = overrides.state ?? {};
    const deps: ClickhouseCronDeps = {
        clickhouseRepo: makeRepo(state),
        curated: makeCurated(overrides.curatedMints ?? []),
        clickhouse: makeClickhouse(overrides.clickhouse ?? {}),
        now: () => FIXED_NOW,
        env: () => overrides.env ?? { CLICKHOUSE_STOCK_REFRESH_ENABLED: 'true', CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: 'true' },
    };
    return { deps, state };
}

describe('syncClickhouseStockMappings', () => {
    it('matches CH rows to equity assets by direct id, symbol, alias and name', async () => {
        const { deps, state } = makeDeps({
            state: {
                mappableAssets: [
                    { assetId: 'aapl', category: 'equity', name: 'Apple Inc', symbol: 'AAPL' },
                    { assetId: 'msft', category: 'equity', name: 'Microsoft', symbol: 'MSFT', aliases: ['msft-alias'] },
                ],
            },
            clickhouse: {
                instruments: [
                    { symbol: 'AAPL', name: 'Apple Inc', assetId: null, instrumentId: 1, dataset: 'xnas' },
                    { symbol: 'MSFT-ALIAS', name: null, assetId: null, instrumentId: 2, dataset: null },
                    { symbol: 'UNKNOWN', name: null, assetId: null, instrumentId: 3, dataset: null },
                ],
            },
        });

        const res = await syncClickhouseStockMappings(deps, { limit: 1000 });
        expect(res.ok).toBe(true);
        expect(res.scanned).toBe(3);
        expect(res.matched).toBe(2);
        expect(res.upserted).toBe(2);
        const upsertedIds = state.upsertedInstruments!.map(r => r.assetId).sort();
        expect(upsertedIds).toEqual(['aapl', 'msft']);
    });

    it('maps commodity assets to their benchmark tickers via the explicit map', async () => {
        const { deps, state } = makeDeps({
            state: {
                mappableAssets: [
                    { assetId: 'gold', category: 'commodity', name: 'Gold', symbol: 'GLD' },
                    { assetId: 'silver', category: 'commodity', name: 'Silver', symbol: 'SLV' },
                    { assetId: 'oil', category: 'commodity', name: 'Oil', symbol: 'USO' },
                ],
            },
            clickhouse: {
                instruments: [
                    { symbol: 'GLD', name: 'SPDR Gold Shares', assetId: null, instrumentId: 10, dataset: 'arcx' },
                    { symbol: 'SLV', name: 'iShares Silver Trust', assetId: null, instrumentId: 11, dataset: 'arcx' },
                    { symbol: 'USO', name: 'United States Oil Fund', assetId: null, instrumentId: 12, dataset: 'arcx' },
                ],
            },
        });

        const res = await syncClickhouseStockMappings(deps, { limit: 1000 });
        expect(res.ok).toBe(true);
        expect(res.matched).toBe(3);
        const bySymbol = new Map(state.upsertedInstruments!.map(r => [r.symbol, r.assetId]));
        expect(bySymbol.get('GLD')).toBe('gold');
        expect(bySymbol.get('SLV')).toBe('silver');
        expect(bySymbol.get('USO')).toBe('oil');
    });

    it('does not reject commodities with ETF/fund/trust-style names (equity heuristics bypassed)', async () => {
        const { deps, state } = makeDeps({
            state: {
                mappableAssets: [
                    // Name contains "Trust" which the equity ETF blocklist would reject.
                    { assetId: 'silver', category: 'commodity', name: 'iShares Silver Trust', symbol: 'SLV' },
                ],
            },
            clickhouse: {
                instruments: [{ symbol: 'SLV', name: 'iShares Silver Trust', assetId: null, instrumentId: 1, dataset: null }],
            },
        });

        const res = await syncClickhouseStockMappings(deps, { limit: 1000 });
        expect(res.matched).toBe(1);
        expect(state.upsertedInstruments![0]?.assetId).toBe('silver');
    });

    it('never maps commodities via symbol/alias matching (Barrick GOLD ticker hazard)', async () => {
        const { deps, state } = makeDeps({
            state: {
                mappableAssets: [
                    { assetId: 'gold', category: 'commodity', name: 'Gold', symbol: 'GLD', aliases: ['gold', 'xau'] },
                ],
            },
            clickhouse: {
                instruments: [
                    // Barrick Gold trades under ticker GOLD — must NOT map to the `gold` commodity.
                    { symbol: 'GOLD', name: 'Barrick Gold Corporation', assetId: null, instrumentId: 20, dataset: 'xnys' },
                    { symbol: 'XAU', name: null, assetId: null, instrumentId: 21, dataset: null },
                ],
            },
        });

        const res = await syncClickhouseStockMappings(deps, { limit: 1000 });
        expect(res.matched).toBe(0);
        expect(state.upsertedInstruments).toHaveLength(0);
    });

    it('leaves commodities without a benchmark ticker unmapped and keeps rejecting equity ETFs', async () => {
        const { deps, state } = makeDeps({
            state: {
                mappableAssets: [
                    { assetId: 'precious-metals', category: 'commodity', name: 'Precious Metals', symbol: 'METALS' },
                    // Equity whose name hits the ETF blocklist — still rejected.
                    { assetId: 'spdr-gold-shares', category: 'equity', name: 'SPDR Gold Shares', symbol: 'GLD' },
                ],
            },
            clickhouse: {
                instruments: [
                    { symbol: 'METALS', name: 'Precious Metals', assetId: null, instrumentId: 30, dataset: null },
                    { symbol: 'GLD', name: 'SPDR Gold Shares', assetId: null, instrumentId: 31, dataset: null },
                ],
            },
        });

        const res = await syncClickhouseStockMappings(deps, { limit: 1000 });
        expect(res.matched).toBe(0);
        expect(state.upsertedInstruments).toHaveLength(0);
    });

    it('exits early with skipped=disabled when env gate is off', async () => {
        const { deps, state } = makeDeps({
            env: { CLICKHOUSE_STOCK_REFRESH_ENABLED: 'false' },
            state: { mappableAssets: [{ assetId: 'aapl', category: 'equity', symbol: 'AAPL' }] },
            clickhouse: { instruments: [{ symbol: 'AAPL', name: null, assetId: null, instrumentId: null, dataset: null }] },
        });
        const res = await syncClickhouseStockMappings(deps, {});
        expect(res.ok).toBe(true);
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('disabled');
        expect(state.upsertedInstruments).toHaveLength(0);
    });
});

describe('refreshPublicEquityStockPrices', () => {
    it('fetches CH snapshots and upserts stock_prices_latest', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [
                    { assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' },
                    { assetId: 'msft', symbol: 'MSFT', normalizedSymbol: 'MSFT' },
                ],
            },
            clickhouse: {
                snapshotsBySymbol: {
                    AAPL: { priceUsd: 190, volume24hUsd: 1000, priceChange24hPercent: 1.5, asOf: 1700 },
                    MSFT: null,
                },
            },
        });

        const res = await refreshPublicEquityStockPrices(deps, { delayMs: 0 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.skippedNoSnapshot).toBe(1);
        expect(state.upsertedPrices!.map(p => p.assetId)).toEqual(['aapl']);
        expect(state.upsertedPrices![0]!.priceUsd).toBe(190);
    });

    it('counts CH errors as failed without throwing; total failure reports ok=false', async () => {
        const { deps, state } = makeDeps({
            state: { stockMappings: [{ assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' }] },
            clickhouse: { failStockSnapshot: true },
        });

        const res = await refreshPublicEquityStockPrices(deps, { delayMs: 0 });
        // Every attempted mapping failed -> total failure -> ok=false so the
        // scheduler counts the run as failed (500) and can retry.
        expect(res.ok).toBe(false);
        expect(res.failed).toBe(1);
        expect(state.upsertedPrices).toHaveLength(0);
    });
});

describe('refreshPublicEquitySharesOutstanding', () => {
    it('fetches shares in batch and updates stock_prices_latest', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [
                    { assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' },
                    { assetId: 'micron', symbol: 'MU', normalizedSymbol: 'MU' },
                ],
            },
            clickhouse: {
                sharesBySymbol: {
                    AAPL: { symbol: 'AAPL', sharesOutstanding: 14_687_356_000, asOfMs: 1_785_268_812_381 },
                    MU: { symbol: 'MU', sharesOutstanding: 1_129_393_151, asOfMs: 1_785_268_870_040 },
                },
            },
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, {});
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(2);
        expect(res.missing).toBe(0);
        expect(res.failed).toBe(0);
        expect(state.sharesUpdates!.map(u => u.assetId).sort()).toEqual(['aapl', 'micron']);
        const mu = state.sharesUpdates!.find(u => u.assetId === 'micron')!;
        expect(mu.sharesOutstanding).toBe(1_129_393_151);
        expect(mu.sharesAsOf).toBe(1_785_268_870.04);
        expect(mu.sharesLastFetchedAt).toBe(FIXED_NOW);
    });

    it('counts feed-missing and null-shares symbols as missing without updating', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [
                    { assetId: 'brk-b', symbol: 'BRK.B', normalizedSymbol: 'BRK.B' },
                    { assetId: 'unlisted', symbol: 'NOPE', normalizedSymbol: 'NOPE' },
                    { assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' },
                ],
            },
            clickhouse: {
                sharesBySymbol: {
                    // Dot-ticker present in the feed but with null shares.
                    'BRK.B': { symbol: 'BRK.B', sharesOutstanding: null, asOfMs: null },
                    AAPL: { symbol: 'AAPL', sharesOutstanding: 14_687_356_000, asOfMs: null },
                },
            },
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, {});
        expect(res.refreshed).toBe(1);
        expect(res.missing).toBe(2);
        expect(state.sharesUpdates!.map(u => u.assetId)).toEqual(['aapl']);
    });

    it('counts assets with no stock_prices_latest row as missing', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [{ assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' }],
                sharesUpdateMissingAssetIds: ['aapl'],
            },
            clickhouse: {
                sharesBySymbol: {
                    AAPL: { symbol: 'AAPL', sharesOutstanding: 14_687_356_000, asOfMs: null },
                },
            },
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, {});
        expect(res.refreshed).toBe(0);
        expect(res.missing).toBe(1);
        expect(state.sharesUpdates ?? []).toHaveLength(0);
    });

    it('skips when stock refresh is disabled', async () => {
        const { deps, state } = makeDeps({
            state: { stockMappings: [{ assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' }] },
            env: {},
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, {});
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('disabled');
        expect(state.sharesUpdates ?? []).toHaveLength(0);
    });

    it('honors explicit assetIds targeting', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [
                    { assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' },
                    { assetId: 'micron', symbol: 'MU', normalizedSymbol: 'MU' },
                ],
            },
            clickhouse: {
                sharesBySymbol: {
                    AAPL: { symbol: 'AAPL', sharesOutstanding: 14_687_356_000, asOfMs: null },
                    MU: { symbol: 'MU', sharesOutstanding: 1_129_393_151, asOfMs: null },
                },
            },
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, { assetIds: ['micron'] });
        expect(res.processed).toBe(1);
        expect(res.refreshed).toBe(1);
        expect(state.sharesUpdates!.map(u => u.assetId)).toEqual(['micron']);
    });

    it('counts whole chunk as failed when the preset call throws', async () => {
        const { deps, state } = makeDeps({
            state: {
                stockMappings: [
                    { assetId: 'aapl', symbol: 'AAPL', normalizedSymbol: 'AAPL' },
                    { assetId: 'micron', symbol: 'MU', normalizedSymbol: 'MU' },
                ],
            },
            clickhouse: { failSharesOutstanding: true },
        });

        const res = await refreshPublicEquitySharesOutstanding(deps, {});
        expect(res.ok).toBe(true);
        expect(res.failed).toBe(2);
        expect(res.refreshed).toBe(0);
        expect(state.sharesUpdates ?? []).toHaveLength(0);
    });
});

describe('refreshSolanaClickhouseTradeSnapshots', () => {
    it('upserts variant market rows from CH for curated mints', async () => {
        const { deps, state } = makeDeps({
            curatedMints: ['mintA', 'mintB'],
            state: {
                stableMints: ['stableUSDC'],
                registryByMint: { mintA: { symbol: 'TKA', name: 'TokenA' } },
            },
            clickhouse: {
                asOfMs: 1_700_000_000_000,
                solanaSnapshotsByMint: {
                    mintA: {
                        mint: 'mintA',
                        priceUsd: 1.23,
                        volume1hUsd: 100,
                        volume24hUsd: 2400,
                        trade1h: 10,
                        trade24h: 240,
                        uniqueTrader1h: 5,
                        uniqueTrader24h: 60,
                        priceChange1hPercent: 0.1,
                        priceChange24hPercent: 2.4,
                        lastTradeAt: 1_699_999_999_000,
                        asOf: 1_700_000_000,
                    },
                },
            },
        });

        const res = await refreshSolanaClickhouseTradeSnapshots(deps, { delayMs: 0, chunkSize: 50 });
        expect(res.ok).toBe(true);
        expect(res.refreshed).toBe(1);
        expect(res.noTrades).toBe(1);
        expect(state.upsertedSolanaSnapshots!.map(s => s.mint)).toEqual(['mintA']);
        expect(state.upsertedSolanaSnapshots![0]!.symbol).toBe('TKA');
        expect(state.upsertedSolanaSnapshots![0]!.volume24hUSD).toBe(2400);
    });

    it('returns disabled when env gate is off', async () => {
        const { deps, state } = makeDeps({
            env: { CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED: '' },
            curatedMints: ['mintA'],
        });
        const res = await refreshSolanaClickhouseTradeSnapshots(deps, {});
        expect(res.ok).toBe(true);
        expect(res.skipped).toBe(true);
        expect(res.reason).toBe('disabled');
        expect(state.upsertedSolanaSnapshots).toHaveLength(0);
    });
});

describe('isPublicEquityAsset', () => {
    it('filters pre-IPO and ETF-like assets', () => {
        expect(__testing.isPublicEquityAsset({ assetId: 'aapl', name: 'Apple Inc', symbol: 'AAPL' })).toBe(true);
        expect(__testing.isPublicEquityAsset({ assetId: 'pre-spacex', name: 'SpaceX (PreStocks)' })).toBe(false);
        expect(__testing.isPublicEquityAsset({ assetId: 'spy', name: 'SPDR S&P 500 ETF' })).toBe(false);
        expect(__testing.isPublicEquityAsset({ assetId: 'spacex', name: 'SpaceX' })).toBe(true);
    });
});
