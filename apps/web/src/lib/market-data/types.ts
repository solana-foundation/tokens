export const MARKET_CATEGORIES = ['tokens', 'etfs', 'stocks', 'metals', 'rwa'] as const;

export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

export function isMarketCategory(value: string): value is MarketCategory {
    return (MARKET_CATEGORIES as readonly string[]).includes(value);
}

/**
 * One row of the unified market table. Every provider normalizes into this
 * shape so the UI never has to know which upstream a row came from.
 */
export interface MarketRow {
    /** Provider-qualified id, e.g. `NASDAQ:NVDA` or `BINANCE:SOLUSDT`. */
    id: string;
    /** Display symbol, e.g. `NVDA`. */
    symbol: string;
    name: string;
    price: number | null;
    changePercent: number | null;
    volume: number | null;
    /**
     * Market cap for coins/stocks, assets under management for ETFs. The two
     * never coexist upstream, so they share one column.
     */
    marketCap: number | null;
    currency: string;
    sector: string | null;
    source: 'tradingview' | 'binance';
}

export interface MarketSnapshot {
    category: MarketCategory;
    rows: MarketRow[];
    /** Total matches upstream, which can exceed `rows.length` when paginated. */
    totalCount: number;
    fetchedAt: number;
    /** True when served from the in-process cache rather than a live fetch. */
    cached: boolean;
    /**
     * Curated tickers the upstream failed to resolve. Reported instead of being
     * dropped silently, so a delisted symbol is visible rather than looking
     * like the asset simply has no data.
     */
    missingTickers?: string[];
}

export function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
