import 'server-only';

import { bareSymbol, runScannerQuery, type ScannerQuery, type ScannerRow } from './tradingview';
import {
    numberOrNull,
    stringOrNull,
    type MarketCategory,
    type MarketRow,
    type MarketSnapshot,
} from './types';

/** Crypto-coin screener columns (market `coin`). */
const COIN_COLUMNS = [
    'base_currency',
    'base_currency_desc',
    'close',
    'change',
    'market_cap_calc',
    '24h_vol_cmc',
] as const;

/**
 * US equity screener columns (market `america`). ETFs populate `aum` and leave
 * `market_cap_basic` null; stocks do the opposite, so both are requested and
 * whichever is present wins.
 */
const EQUITY_COLUMNS = [
    'name',
    'description',
    'close',
    'change',
    'volume',
    'market_cap_basic',
    'aum',
    'sector',
] as const;

/** Spot/futures quote columns for explicit ticker lookups (market `global`). */
const SPOT_COLUMNS = ['description', 'close', 'change', 'currency', 'volume'] as const;

const METAL_TICKERS = [
    'TVC:GOLD',
    'TVC:SILVER',
    'TVC:PLATINUM',
    'TVC:PALLADIUM',
    'COMEX:GC1!',
    'COMEX:SI1!',
    'COMEX:HG1!',
    'COMEX:PL1!',
] as const;

/**
 * Tokenized real-world assets. TradingView has no RWA screener category, so
 * this is a curated list; tickers that no longer resolve are reported in
 * `missingTickers` rather than silently dropped.
 */
const RWA_TICKERS = [
    'CRYPTO:PAXGUSD',
    'CRYPTO:XAUTUSD',
    'CRYPTO:ONDOUSD',
    'CRYPTO:CFGUSD',
    'CRYPTO:MPLUSD',
    'CRYPTO:POLYXUSD',
    'CRYPTO:RIOUSD',
    'CRYPTO:TRUUSD',
] as const;

function coinRow(row: ScannerRow): MarketRow {
    return {
        id: row.ticker,
        symbol: stringOrNull(row.values.base_currency) ?? bareSymbol(row.ticker),
        name: stringOrNull(row.values.base_currency_desc) ?? bareSymbol(row.ticker),
        price: numberOrNull(row.values.close),
        changePercent: numberOrNull(row.values.change),
        volume: numberOrNull(row.values['24h_vol_cmc']),
        marketCap: numberOrNull(row.values.market_cap_calc),
        currency: 'USD',
        sector: null,
        source: 'tradingview',
    };
}

function equityRow(row: ScannerRow): MarketRow {
    return {
        id: row.ticker,
        symbol: stringOrNull(row.values.name) ?? bareSymbol(row.ticker),
        name: stringOrNull(row.values.description) ?? bareSymbol(row.ticker),
        price: numberOrNull(row.values.close),
        changePercent: numberOrNull(row.values.change),
        volume: numberOrNull(row.values.volume),
        marketCap: numberOrNull(row.values.aum) ?? numberOrNull(row.values.market_cap_basic),
        currency: 'USD',
        sector: stringOrNull(row.values.sector),
        source: 'tradingview',
    };
}

function spotRow(row: ScannerRow): MarketRow {
    const volume = numberOrNull(row.values.volume);
    return {
        id: row.ticker,
        symbol: bareSymbol(row.ticker),
        name: stringOrNull(row.values.description) ?? bareSymbol(row.ticker),
        price: numberOrNull(row.values.close),
        changePercent: numberOrNull(row.values.change),
        // Spot metal indices (TVC:*) report 0 volume; that is "not applicable",
        // not "no trading", so it is normalized away.
        volume: volume === null || volume === 0 ? null : volume,
        marketCap: null,
        currency: stringOrNull(row.values.currency) ?? 'USD',
        sector: 'Metals',
        source: 'tradingview',
    };
}

interface CategoryDefinition {
    label: string;
    /** Tickers this category requests explicitly, if it is a curated list. */
    tickers?: readonly string[];
    buildQuery: (limit: number) => ScannerQuery;
    toRow: (row: ScannerRow) => MarketRow;
}

const CATEGORY_DEFINITIONS: Record<MarketCategory, CategoryDefinition> = {
    tokens: {
        label: 'Tokens',
        buildQuery: limit => ({
            market: 'coin',
            columns: COIN_COLUMNS,
            sort: { sortBy: 'market_cap_calc', sortOrder: 'desc' },
            range: [0, limit],
        }),
        toRow: coinRow,
    },
    etfs: {
        label: 'ETFs',
        buildQuery: limit => ({
            market: 'america',
            columns: EQUITY_COLUMNS,
            filter: [{ left: 'type', operation: 'equal', right: 'fund' }],
            sort: { sortBy: 'aum', sortOrder: 'desc' },
            range: [0, limit],
        }),
        toRow: equityRow,
    },
    stocks: {
        label: 'Stocks',
        buildQuery: limit => ({
            market: 'america',
            columns: EQUITY_COLUMNS,
            filter: [{ left: 'type', operation: 'equal', right: 'stock' }],
            sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
            range: [0, limit],
        }),
        toRow: equityRow,
    },
    metals: {
        label: 'Metals',
        tickers: METAL_TICKERS,
        buildQuery: () => ({
            market: 'global',
            columns: SPOT_COLUMNS,
            tickers: METAL_TICKERS,
        }),
        toRow: spotRow,
    },
    rwa: {
        label: 'RWA',
        tickers: RWA_TICKERS,
        buildQuery: () => ({
            market: 'global',
            columns: COIN_COLUMNS,
            tickers: RWA_TICKERS,
        }),
        toRow: coinRow,
    },
};

export function categoryLabel(category: MarketCategory): string {
    return CATEGORY_DEFINITIONS[category].label;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
    snapshot: MarketSnapshot;
    expiresAt: number;
}

const snapshotCache = new Map<string, CacheEntry>();

async function loadSnapshot(category: MarketCategory, limit: number): Promise<MarketSnapshot> {
    const definition = CATEGORY_DEFINITIONS[category];
    const result = await runScannerQuery(definition.buildQuery(limit));

    const rows = result.rows.map(definition.toRow);

    // Curated lists are ordered by intent, not by an upstream sort, so keep the
    // declared order and surface anything the scanner failed to resolve.
    let missingTickers: string[] | undefined;
    if (definition.tickers) {
        const byTicker = new Map(rows.map(row => [row.id, row]));
        const ordered: MarketRow[] = [];
        const missing: string[] = [];
        for (const ticker of definition.tickers) {
            const row = byTicker.get(ticker);
            if (row) ordered.push(row);
            else missing.push(ticker);
        }
        rows.length = 0;
        rows.push(...ordered);
        if (missing.length > 0) missingTickers = missing;
    }

    return {
        category,
        rows: rows.slice(0, limit),
        totalCount: definition.tickers ? rows.length : result.totalCount,
        fetchedAt: Date.now(),
        cached: false,
        missingTickers,
    };
}

export async function getMarketSnapshot(
    category: MarketCategory,
    limit: number,
): Promise<MarketSnapshot> {
    const key = `${category}:${limit}`;
    const now = Date.now();

    const hit = snapshotCache.get(key);
    if (hit && hit.expiresAt > now) {
        return { ...hit.snapshot, cached: true };
    }

    const snapshot = await loadSnapshot(category, limit);
    snapshotCache.set(key, { snapshot, expiresAt: now + CACHE_TTL_MS });
    return snapshot;
}
