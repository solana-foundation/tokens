import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

export const TRENDING_SCORING_VERSION = 'solana-direct-stable-v1';
export const FRESH_TRENDING_SCORING_VERSION = 'birdeye-selected-fresh-v1';

const ASSET_CATEGORIES = new Set<string>([
    'crypto',
    'stablecoin',
    'lst',
    'rwa',
    'commodity',
    'equity',
    'etf',
    'index',
]);

const MARKET_SOURCES = new Set<string>(['birdeye', 'rwa_xyz', 'clickhouse_trades']);

type AssetCategory =
    | 'crypto'
    | 'stablecoin'
    | 'lst'
    | 'rwa'
    | 'commodity'
    | 'equity'
    | 'etf'
    | 'index';

type MarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';

export interface TrendingMarketRow {
    mint: string;
    asset_id: string;
    variant_id: string;
    category: string;
    symbol: string;
    name: string;
    decimals: number | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    source: string;
    scoring_version: string;
    price: number | null;
    volume_5m_usd: number;
    volume_15m_usd: number;
    volume_1h_usd: number;
    volume_6h_usd: number;
    volume_24h_usd: number;
    trade_5m: number;
    trade_15m: number;
    trade_1h: number;
    trade_6h: number;
    trade_24h: number;
    unique_wallet_5m: number;
    unique_wallet_1h: number;
    unique_wallet_24h: number;
    price_change_1h_percent: number | null;
    price_change_24h_percent: number | null;
    trending_score: number;
    rank: number;
    category_rank: number;
    last_trade_at: number | null;
    as_of: number;
    last_computed_at: number;
}

export interface FreshTrendingMarketRow {
    mint: string;
    asset_id: string;
    variant_id: string;
    category: string;
    symbol: string;
    name: string;
    decimals: number | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    source: string;
    metrics_source: string | null;
    scoring_version: string;
    price: number | null;
    liquidity: number | null;
    volume_5m_usd: number | null;
    volume_15m_usd: number | null;
    volume_1h_usd: number | null;
    volume_6h_usd: number | null;
    volume_24h_usd: number | null;
    trade_5m: number | null;
    trade_15m: number | null;
    trade_1h: number | null;
    trade_6h: number | null;
    trade_24h: number | null;
    unique_wallet_5m: number | null;
    unique_wallet_1h: number | null;
    unique_wallet_24h: number | null;
    price_change_1h_percent: number | null;
    price_change_24h_percent: number | null;
    last_trade_at: number | null;
    as_of: number | null;
    last_fetched_at: number;
    trending_score: number;
    rank: number;
    category_rank: number;
    last_computed_at: number;
}

export interface TrendingReadsRepo {
    listTrending(category: string | null): Promise<TrendingMarketRow[]>;
    listFreshTrending(category: string | null): Promise<FreshTrendingMarketRow[]>;
}

function isAssetCategory(value: unknown): value is AssetCategory {
    return typeof value === 'string' && ASSET_CATEGORIES.has(value);
}

function isMarketSource(value: unknown): value is MarketSource {
    return typeof value === 'string' && MARKET_SOURCES.has(value);
}

export interface TrendingMarketResult {
    mint: string;
    assetId: string;
    variantId: string;
    category: AssetCategory;
    symbol: string;
    name: string;
    decimals?: number;
    logoURI?: string;
    source: 'clickhouse_trades';
    scoringVersion: string;
    price?: number;
    volume5mUSD: number;
    volume15mUSD: number;
    volume1hUSD: number;
    volume6hUSD: number;
    volume24hUSD: number;
    trade5m: number;
    trade15m: number;
    trade1h: number;
    trade6h: number;
    trade24h: number;
    uniqueWallet5m: number;
    uniqueWallet1h: number;
    uniqueWallet24h: number;
    priceChange1hPercent?: number;
    priceChange24hPercent?: number;
    trendingScore: number;
    rank: number;
    categoryRank: number;
    lastTradeAt?: number;
    asOf: number;
    lastComputedAt: number;
}

export interface FreshTrendingMarketResult {
    mint: string;
    assetId: string;
    variantId: string;
    category: AssetCategory;
    symbol: string;
    name: string;
    decimals?: number;
    logoURI?: string;
    source: MarketSource;
    metricsSource?: MarketSource;
    scoringVersion: string;
    price?: number;
    liquidity?: number;
    volume5mUSD?: number;
    volume15mUSD?: number;
    volume1hUSD?: number;
    volume6hUSD?: number;
    volume24hUSD?: number;
    trade5m?: number;
    trade15m?: number;
    trade1h?: number;
    trade6h?: number;
    trade24h?: number;
    uniqueWallet5m?: number;
    uniqueWallet1h?: number;
    uniqueWallet24h?: number;
    priceChange1hPercent?: number;
    priceChange24hPercent?: number;
    lastTradeAt?: number;
    asOf?: number;
    lastFetchedAt: number;
    trendingScore: number;
    rank: number;
    categoryRank: number;
    lastComputedAt: number;
}

export interface TrendingListResult {
    rows: TrendingMarketResult[];
    total: number;
    asOf: number | null;
    scoringVersion: string;
}

export interface FreshTrendingListResult {
    rows: FreshTrendingMarketResult[];
    total: number;
    asOf: number | null;
    scoringVersion: string;
}

function rowToTrendingResult(row: TrendingMarketRow): TrendingMarketResult | null {
    if (!isAssetCategory(row.category)) return null;
    if (row.source !== 'clickhouse_trades') return null;
    const out: TrendingMarketResult = {
        mint: row.mint,
        assetId: row.asset_id,
        variantId: row.variant_id,
        category: row.category,
        symbol: row.symbol,
        name: row.name,
        source: 'clickhouse_trades',
        scoringVersion: row.scoring_version,
        volume5mUSD: row.volume_5m_usd,
        volume15mUSD: row.volume_15m_usd,
        volume1hUSD: row.volume_1h_usd,
        volume6hUSD: row.volume_6h_usd,
        volume24hUSD: row.volume_24h_usd,
        trade5m: row.trade_5m,
        trade15m: row.trade_15m,
        trade1h: row.trade_1h,
        trade6h: row.trade_6h,
        trade24h: row.trade_24h,
        uniqueWallet5m: row.unique_wallet_5m,
        uniqueWallet1h: row.unique_wallet_1h,
        uniqueWallet24h: row.unique_wallet_24h,
        trendingScore: row.trending_score,
        rank: row.rank,
        categoryRank: row.category_rank,
        asOf: row.as_of,
        lastComputedAt: row.last_computed_at,
    };
    if (row.decimals !== null) out.decimals = row.decimals;
    const logoURI = resolveLogoUri(row);
    if (logoURI !== null) out.logoURI = logoURI;
    if (row.price !== null) out.price = row.price;
    if (row.price_change_1h_percent !== null) out.priceChange1hPercent = row.price_change_1h_percent;
    if (row.price_change_24h_percent !== null) out.priceChange24hPercent = row.price_change_24h_percent;
    if (row.last_trade_at !== null) out.lastTradeAt = row.last_trade_at;
    return out;
}

function rowToFreshTrendingResult(row: FreshTrendingMarketRow): FreshTrendingMarketResult | null {
    if (!isAssetCategory(row.category)) return null;
    if (!isMarketSource(row.source)) return null;
    const out: FreshTrendingMarketResult = {
        mint: row.mint,
        assetId: row.asset_id,
        variantId: row.variant_id,
        category: row.category,
        symbol: row.symbol,
        name: row.name,
        source: row.source,
        scoringVersion: row.scoring_version,
        lastFetchedAt: row.last_fetched_at,
        trendingScore: row.trending_score,
        rank: row.rank,
        categoryRank: row.category_rank,
        lastComputedAt: row.last_computed_at,
    };
    if (row.decimals !== null) out.decimals = row.decimals;
    const logoURI = resolveLogoUri(row);
    if (logoURI !== null) out.logoURI = logoURI;
    if (isMarketSource(row.metrics_source)) out.metricsSource = row.metrics_source;
    if (row.price !== null) out.price = row.price;
    if (row.liquidity !== null) out.liquidity = row.liquidity;
    if (row.volume_5m_usd !== null) out.volume5mUSD = row.volume_5m_usd;
    if (row.volume_15m_usd !== null) out.volume15mUSD = row.volume_15m_usd;
    if (row.volume_1h_usd !== null) out.volume1hUSD = row.volume_1h_usd;
    if (row.volume_6h_usd !== null) out.volume6hUSD = row.volume_6h_usd;
    if (row.volume_24h_usd !== null) out.volume24hUSD = row.volume_24h_usd;
    if (row.trade_5m !== null) out.trade5m = row.trade_5m;
    if (row.trade_15m !== null) out.trade15m = row.trade_15m;
    if (row.trade_1h !== null) out.trade1h = row.trade_1h;
    if (row.trade_6h !== null) out.trade6h = row.trade_6h;
    if (row.trade_24h !== null) out.trade24h = row.trade_24h;
    if (row.unique_wallet_5m !== null) out.uniqueWallet5m = row.unique_wallet_5m;
    if (row.unique_wallet_1h !== null) out.uniqueWallet1h = row.unique_wallet_1h;
    if (row.unique_wallet_24h !== null) out.uniqueWallet24h = row.unique_wallet_24h;
    if (row.price_change_1h_percent !== null) out.priceChange1hPercent = row.price_change_1h_percent;
    if (row.price_change_24h_percent !== null) out.priceChange24hPercent = row.price_change_24h_percent;
    if (row.last_trade_at !== null) out.lastTradeAt = row.last_trade_at;
    if (row.as_of !== null) out.asOf = row.as_of;
    return out;
}

function parseListArgs(args: unknown): { category: AssetCategory | null; limit: number; offset: number } {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { category?: unknown; limit?: unknown; offset?: unknown };
    let category: AssetCategory | null = null;
    if (a.category !== undefined) {
        if (!isAssetCategory(a.category)) {
            throw new InvalidArgsError('category must be a valid asset category');
        }
        category = a.category;
    }
    if (a.limit !== undefined && typeof a.limit !== 'number') {
        throw new InvalidArgsError('limit must be a number when present');
    }
    if (a.offset !== undefined && typeof a.offset !== 'number') {
        throw new InvalidArgsError('offset must be a number when present');
    }
    const limit = Math.min(Math.max(Math.floor(typeof a.limit === 'number' ? a.limit : 50), 1), 50);
    const offset = Math.min(Math.max(Math.floor(typeof a.offset === 'number' ? a.offset : 0), 0), 1000);
    return { category, limit, offset };
}

export async function listTrending(repo: TrendingReadsRepo, args: unknown): Promise<TrendingListResult> {
    const { category, limit, offset } = parseListArgs(args);
    const rows = await repo.listTrending(category);
    const filtered: TrendingMarketRow[] = [];
    for (const row of rows) {
        if (rowToTrendingResult(row) !== null) filtered.push(row);
    }
    const sorted = filtered.sort((a, b) =>
        category ? a.category_rank - b.category_rank || a.rank - b.rank : a.rank - b.rank,
    );
    const page = sorted.slice(offset, offset + limit);
    const asOf = sorted.reduce<number | null>(
        (max, row) => (max === null ? row.as_of : Math.max(max, row.as_of)),
        null,
    );
    const mapped = page
        .map(row => rowToTrendingResult(row))
        .filter((r): r is TrendingMarketResult => r !== null);
    return {
        rows: mapped,
        total: sorted.length,
        asOf,
        scoringVersion: TRENDING_SCORING_VERSION,
    };
}

export async function listFreshTrending(
    repo: TrendingReadsRepo,
    args: unknown,
): Promise<FreshTrendingListResult> {
    const { category, limit, offset } = parseListArgs(args);
    const rows = await repo.listFreshTrending(category);
    const filtered: FreshTrendingMarketRow[] = [];
    for (const row of rows) {
        if (rowToFreshTrendingResult(row) !== null) filtered.push(row);
    }
    const sorted = filtered.sort((a, b) =>
        category ? a.category_rank - b.category_rank || a.rank - b.rank : a.rank - b.rank,
    );
    const page = sorted.slice(offset, offset + limit);
    const asOf = sorted.reduce<number | null>(
        (max, row) => (max === null ? row.last_fetched_at : Math.max(max, row.last_fetched_at)),
        null,
    );
    const mapped = page
        .map(row => rowToFreshTrendingResult(row))
        .filter((r): r is FreshTrendingMarketResult => r !== null);
    return {
        rows: mapped,
        total: sorted.length,
        asOf,
        scoringVersion: FRESH_TRENDING_SCORING_VERSION,
    };
}
