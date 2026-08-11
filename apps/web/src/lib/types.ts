export type TrendingWindow = '5m' | '15m' | '1h' | '6h' | '24h';

export interface Token {
    /**
     * Canonical asset id (from the Tokens platform API), when available.
     * Useful for fetching asset-scoped data like OHLCV.
     */
    assetId?: string;
    coingeckoId?: string;
    category?: string;
    canonicalMarketSource?: 'coingecko' | 'clickhouse_stock';
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
    /** DEX depth in USD; `null` when no source has answered for this token yet. */
    liquidity: number | null;
    volume1hUSD?: number;
    volume5mUSD?: number;
    volume15mUSD?: number;
    volume6hUSD?: number;
    volume24hUSD: number;
    underlyingVolume24hUSD?: number;
    underlyingVolume24hLabel?: string;
    trade5m?: number;
    trade15m?: number;
    trade1h?: number;
    trade6h?: number;
    trade24h?: number;
    uniqueWallet5m?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    trendingRank?: number;
    trendingScore?: number;
    price: number;
    priceChange24hPercent: number;
    priceChange1hPercent?: number;
    marketCap: number;
    lastTradeAt?: number;
    asOf?: number;
}

export interface MarketStats {
    volume24h: number;
    totalTvl: number;
    totalMarketCap: number;
    allTimeVolume: number;
}
