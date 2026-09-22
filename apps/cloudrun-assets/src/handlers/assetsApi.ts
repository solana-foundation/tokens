import { normalizeLegacyTier } from '@tokens/asset-registry';

import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

export type AssetCategory =
    | 'crypto'
    | 'stablecoin'
    | 'lst'
    | 'rwa'
    | 'commodity'
    | 'equity'
    | 'etf'
    | 'index';

const KNOWN_ASSET_CATEGORIES: ReadonlySet<string> = new Set<AssetCategory>([
    'crypto',
    'stablecoin',
    'lst',
    'rwa',
    'commodity',
    'equity',
    'etf',
    'index',
]);

const warnedCategories = new Set<string>();
const warnedVariantSources = new Set<string>();
const warnedFillQualityTuples = new Set<string>();
const warnedStockSources = new Set<string>();

function toAssetCategory(value: string, assetId: string): AssetCategory {
    if (KNOWN_ASSET_CATEGORIES.has(value)) return value as AssetCategory;
    if (!warnedCategories.has(value)) {
        warnedCategories.add(value);
        console.warn(
            `[assetsApi] unknown asset category "${value}" (first seen on assetId=${assetId}); passing through`,
        );
    }
    return value as AssetCategory;
}

export type TrustTier = 'tier1' | 'tier2' | 'tier3';
export type MarketSource = 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
export type StockMarketSource = 'clickhouse_stock';
export type StockVariantTier = 'share_redeemable' | 'cash_redeemable' | 'not_redeemable';

const VARIANT_LOGO_FALLBACK_BY_MINT: Record<string, string> = {
    '6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU': '/logos/popular/tbtc-logo.png',
};

export interface AssetsApiAssetRow {
    asset_id: string;
    category: string;
    name: string | null;
    symbol: string | null;
    aliases: string[];
    coingecko_id: string | null;
    description: string | null;
    image_url: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface AssetsApiVariantRow {
    asset_id: string;
    chain: string;
    mint: string;
    variant_id: string;
    kind: string;
    trust_tier: string;
    stock_variant_tier: string | null;
    tags: string[];
    issuer: string | null;
    issuer_url: string | null;
    label: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface AssetsApiVariantMarketRow {
    mint: string;
    source: string;
    metrics_source: string | null;
    birdeye_metrics: unknown;
    rwa_metrics: unknown;
    clickhouse_metrics: unknown;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
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
    market_cap: number | null;
    fdv: number | null;
    price_change_24h_percent: number | null;
    price_change_1h_percent: number | null;
    holder: number | null;
    total_supply: number | null;
    circulating_supply: number | null;
    last_trade_human_time: string | null;
    extensions: unknown;
    as_of: number | null;
    last_trade_at: number | null;
    last_fetched_at: number;
    overview_last_fetched_at: number | null;
}

export interface AssetsApiFillQualityRow {
    mint: string;
    source: string;
    range_identifier: string;
    horizon: string;
    quote_mint: string;
    volume_24h_usd: number;
    trade_24h: number;
    bot_volume_24h_usd: number;
    bot_trade_24h: number;
    bot_volume_ratio: number;
    fee_24h_usd: number;
    fee_bps: number;
    flow_source_count: number;
    markout_pnl_24h_usd: number | null;
    markout_count: number | null;
    markout_bps: number | null;
    execution_score: number;
    is_eligible_for_primary: boolean;
    as_of: number;
    last_computed_at: number;
}

export interface AssetsApiAssetMarketRow {
    asset_id: string;
    liquidity: number;
    volume_24h_usd: number;
    volume_30d_usd: number | null;
    primary_mint: string | null;
    last_computed_at: number;
    min_variant_last_fetched_at: number | null;
    max_variant_last_fetched_at: number | null;
}

export interface AssetsApiCoingeckoCoinRow {
    coin_id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
    last_synced_at: number;
    coin: unknown;
    last_metadata_fetched_at: number | null;
}

export interface AssetsApiStockInstrumentRow {
    asset_id: string;
    symbol: string;
    normalized_symbol: string;
    name: string | null;
    instrument_id: number | null;
    dataset: string | null;
    is_active: boolean;
    source: string;
    last_synced_at: number;
}

export interface AssetsApiStockPriceRow {
    asset_id: string;
    symbol: string;
    normalized_symbol: string;
    price_usd: number | null;
    volume_24h_usd: number | null;
    price_change_24h_percent: number | null;
    as_of: number | null;
    last_fetched_at: number;
    source: string;
}

export interface AssetsApiRepo {
    findAssetByAssetId(assetId: string): Promise<AssetsApiAssetRow | null>;
    findActiveVariantsByAssetId(assetId: string): Promise<AssetsApiVariantRow[]>;
    findVariantMarketsLatestByMint(mint: string): Promise<AssetsApiVariantMarketRow | null>;
    findVariantMarketsLatestByMints(mints: string[]): Promise<AssetsApiVariantMarketRow[]>;
    findVariantFillQualityLatestByMint(mint: string): Promise<AssetsApiFillQualityRow | null>;
    findVariantFillQualityLatestByMints(mints: string[]): Promise<AssetsApiFillQualityRow[]>;
    findAssetMarketsLatestByAssetId(assetId: string): Promise<AssetsApiAssetMarketRow | null>;
    findCoingeckoCoinByCoinId(coinId: string): Promise<AssetsApiCoingeckoCoinRow | null>;
    findStockInstrumentsLatestByAssetId(assetId: string): Promise<AssetsApiStockInstrumentRow | null>;
    findStockPricesLatestByAssetId(assetId: string): Promise<AssetsApiStockPriceRow | null>;
}

export interface AssetApiResult {
    assetId: string;
    category: AssetCategory;
    aliases: string[];
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
    name?: string;
    symbol?: string;
    coingeckoId?: string;
    description?: string;
    imageUrl?: string;
}

export interface VariantApiResult {
    assetId: string;
    chain: string;
    mint: string;
    variantId: string;
    kind: string;
    trustTier: TrustTier;
    tags: string[];
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
    issuer?: string;
    issuerUrl?: string;
    label?: string;
    stockVariantTier?: StockVariantTier;
}

export interface VariantMarketApiResult {
    mint: string;
    source: MarketSource;
    metricsSource?: MarketSource;
    birdeyeMetrics?: unknown;
    rwaMetrics?: unknown;
    clickhouseMetrics?: unknown;
    symbol?: string;
    name?: string;
    decimals?: number;
    logoURI?: string;
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
    marketCap?: number;
    fdv?: number;
    priceChange24hPercent?: number;
    priceChange1hPercent?: number;
    holder?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    lastTradeHumanTime?: string;
    extensions?: unknown;
    asOf?: number;
    lastTradeAt?: number;
    lastFetchedAt: number;
    overviewLastFetchedAt?: number;
}

export interface FillQualityApiResult {
    mint: string;
    source: 'clickhouse_fill_quality';
    rangeIdentifier: '24h';
    horizon: '5s';
    quoteMint: string;
    volume24hUSD: number;
    trade24h: number;
    botVolume24hUSD: number;
    botTrade24h: number;
    botVolumeRatio: number;
    fee24hUSD: number;
    feeBps: number;
    flowSourceCount: number;
    markoutPnl24hUSD?: number;
    markoutCount?: number;
    markoutBps?: number;
    executionScore: number;
    isEligibleForPrimary: boolean;
    asOf: number;
    lastComputedAt: number;
}

export interface AssetMarketApiResult {
    assetId: string;
    liquidity: number;
    volume24hUSD: number;
    volume30dUSD?: number | null;
    primaryMint?: string;
    lastComputedAt: number;
    minVariantLastFetchedAt?: number;
    maxVariantLastFetchedAt?: number;
}

export interface CoingeckoCoinApiResult {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
    lastSyncedAt: number;
    coin?: unknown;
    lastMetadataFetchedAt?: number;
}

export interface StockInstrumentApiResult {
    assetId: string;
    symbol: string;
    normalizedSymbol: string;
    name?: string;
    instrumentId?: number;
    dataset?: string;
    isActive: boolean;
    source: 'clickhouse';
    lastSyncedAt: number;
}

export interface StockPriceApiResult {
    assetId: string;
    symbol: string;
    normalizedSymbol: string;
    priceUsd: number | null;
    volume24hUsd: number | null;
    priceChange24hPercent: number | null;
    asOf: number | null;
    lastFetchedAt: number;
    source: StockMarketSource;
}

export interface LoadAssetBaseForApiResult {
    asset: AssetApiResult | null;
    variants: VariantApiResult[];
    variantMarkets?: { mint: string; market: VariantMarketApiResult | null }[];
    fillQuality?: { mint: string; fillQuality: FillQualityApiResult | null }[];
    assetMarket?: AssetMarketApiResult | null;
    coingeckoCoin?: CoingeckoCoinApiResult | null;
    stockInstrument?: StockInstrumentApiResult | null;
    stockPrice?: StockPriceApiResult | null;
}

const STOCK_VARIANT_TIERS: readonly StockVariantTier[] = [
    'share_redeemable',
    'cash_redeemable',
    'not_redeemable',
];

function isStockVariantTier(value: unknown): value is StockVariantTier {
    return typeof value === 'string' && (STOCK_VARIANT_TIERS as readonly string[]).includes(value);
}

function isMarketSource(value: unknown): value is MarketSource {
    return value === 'birdeye' || value === 'rwa_xyz' || value === 'clickhouse_trades';
}

function isStockMarketSource(value: unknown): value is StockMarketSource {
    return value === 'clickhouse_stock';
}

function normalizeTrustTier(value: unknown): TrustTier {
    return normalizeLegacyTier(typeof value === 'string' ? value : null) ?? 'tier3';
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new InvalidArgsError(`${key} must be a boolean`);
    }
    return value;
}

function assetRowToResult(row: AssetsApiAssetRow): AssetApiResult {
    const result: AssetApiResult = {
        assetId: row.asset_id,
        category: toAssetCategory(row.category, row.asset_id),
        aliases: row.aliases,
        isActive: row.is_active,
        createdAt: row.created_at.getTime(),
        updatedAt: row.updated_at.getTime(),
    };
    if (row.name !== null) result.name = row.name;
    if (row.symbol !== null) result.symbol = row.symbol;
    if (row.coingecko_id !== null) result.coingeckoId = row.coingecko_id;
    if (row.description !== null) result.description = row.description;
    if (row.image_url !== null) result.imageUrl = row.image_url;
    return result;
}

function variantRowToResult(row: AssetsApiVariantRow): VariantApiResult {
    const out: VariantApiResult = {
        assetId: row.asset_id,
        chain: row.chain,
        mint: row.mint,
        variantId: row.variant_id,
        kind: row.kind,
        trustTier: normalizeTrustTier(row.trust_tier),
        tags: Array.isArray(row.tags) ? row.tags : [],
        isActive: row.is_active,
        createdAt: row.created_at.getTime(),
        updatedAt: row.updated_at.getTime(),
    };
    if (row.issuer !== null) out.issuer = row.issuer;
    if (row.issuer_url !== null) out.issuerUrl = row.issuer_url;
    if (row.label !== null) out.label = row.label;
    if (row.stock_variant_tier !== null && isStockVariantTier(row.stock_variant_tier)) {
        out.stockVariantTier = row.stock_variant_tier;
    }
    return out;
}

function variantMarketRowToResult(row: AssetsApiVariantMarketRow): VariantMarketApiResult | null {
    if (!isMarketSource(row.source)) {
        if (!warnedVariantSources.has(row.source)) {
            warnedVariantSources.add(row.source);
            console.warn(
                `[assetsApi] dropping variant_markets_latest row with unknown source="${row.source}" (mint=${row.mint})`,
            );
        }
        return null;
    }
    const out: VariantMarketApiResult = {
        mint: row.mint,
        source: row.source,
        lastFetchedAt: row.last_fetched_at,
    };
    if (isMarketSource(row.metrics_source)) out.metricsSource = row.metrics_source;

    if (row.birdeye_metrics !== null && row.birdeye_metrics !== undefined) {
        out.birdeyeMetrics = row.birdeye_metrics;
    }
    if (row.rwa_metrics !== null && row.rwa_metrics !== undefined) {
        out.rwaMetrics = row.rwa_metrics;
    }
    if (row.clickhouse_metrics !== null && row.clickhouse_metrics !== undefined) {
        out.clickhouseMetrics = row.clickhouse_metrics;
    }

    if (row.symbol !== null) out.symbol = row.symbol;
    if (row.name !== null) out.name = row.name;
    if (row.decimals !== null) out.decimals = row.decimals;

    const logoURI = resolveLogoUri(row) ?? VARIANT_LOGO_FALLBACK_BY_MINT[row.mint];
    if (logoURI !== undefined) out.logoURI = logoURI;

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
    if (row.market_cap !== null) out.marketCap = row.market_cap;
    if (row.fdv !== null) out.fdv = row.fdv;
    if (row.price_change_24h_percent !== null) out.priceChange24hPercent = row.price_change_24h_percent;
    if (row.price_change_1h_percent !== null) out.priceChange1hPercent = row.price_change_1h_percent;
    if (row.holder !== null) out.holder = row.holder;
    if (row.total_supply !== null) out.totalSupply = row.total_supply;
    if (row.circulating_supply !== null) out.circulatingSupply = row.circulating_supply;
    if (row.last_trade_human_time !== null) out.lastTradeHumanTime = row.last_trade_human_time;

    if (row.extensions !== null && row.extensions !== undefined) {
        out.extensions = row.extensions;
    }

    if (row.as_of !== null) out.asOf = row.as_of;
    if (row.last_trade_at !== null) out.lastTradeAt = row.last_trade_at;
    if (row.overview_last_fetched_at !== null) out.overviewLastFetchedAt = row.overview_last_fetched_at;

    return out;
}

function fillQualityRowToResult(row: AssetsApiFillQualityRow): FillQualityApiResult | null {
    if (row.source !== 'clickhouse_fill_quality' || row.range_identifier !== '24h' || row.horizon !== '5s') {
        const key = `${row.source}|${row.range_identifier}|${row.horizon}`;
        if (!warnedFillQualityTuples.has(key)) {
            warnedFillQualityTuples.add(key);
            console.warn(
                `[assetsApi] dropping variant_fill_quality_latest row with unexpected (source,range,horizon)=(${row.source},${row.range_identifier},${row.horizon}) mint=${row.mint}`,
            );
        }
        return null;
    }
    const out: FillQualityApiResult = {
        mint: row.mint,
        source: 'clickhouse_fill_quality',
        rangeIdentifier: '24h',
        horizon: '5s',
        quoteMint: row.quote_mint,
        volume24hUSD: row.volume_24h_usd,
        trade24h: row.trade_24h,
        botVolume24hUSD: row.bot_volume_24h_usd,
        botTrade24h: row.bot_trade_24h,
        botVolumeRatio: row.bot_volume_ratio,
        fee24hUSD: row.fee_24h_usd,
        feeBps: row.fee_bps,
        flowSourceCount: row.flow_source_count,
        executionScore: row.execution_score,
        isEligibleForPrimary: row.is_eligible_for_primary,
        asOf: row.as_of,
        lastComputedAt: row.last_computed_at,
    };
    if (row.markout_pnl_24h_usd !== null) out.markoutPnl24hUSD = row.markout_pnl_24h_usd;
    if (row.markout_count !== null) out.markoutCount = row.markout_count;
    if (row.markout_bps !== null) out.markoutBps = row.markout_bps;
    return out;
}

function assetMarketRowToResult(row: AssetsApiAssetMarketRow): AssetMarketApiResult {
    const out: AssetMarketApiResult = {
        assetId: row.asset_id,
        liquidity: row.liquidity,
        volume24hUSD: row.volume_24h_usd,
        lastComputedAt: row.last_computed_at,
    };
    if (row.volume_30d_usd !== null) out.volume30dUSD = row.volume_30d_usd;
    if (row.primary_mint !== null) out.primaryMint = row.primary_mint;
    if (row.min_variant_last_fetched_at !== null) {
        out.minVariantLastFetchedAt = row.min_variant_last_fetched_at;
    }
    if (row.max_variant_last_fetched_at !== null) {
        out.maxVariantLastFetchedAt = row.max_variant_last_fetched_at;
    }
    return out;
}

function coingeckoCoinRowToResult(row: AssetsApiCoingeckoCoinRow): CoingeckoCoinApiResult {
    const out: CoingeckoCoinApiResult = {
        id: row.coin_id,
        symbol: row.symbol,
        name: row.name,
        platforms: row.platforms,
        lastSyncedAt: row.last_synced_at,
    };
    if (row.coin !== null && row.coin !== undefined) out.coin = row.coin;
    if (row.last_metadata_fetched_at !== null) {
        out.lastMetadataFetchedAt = row.last_metadata_fetched_at;
    }
    return out;
}

function stockInstrumentRowToResult(
    row: AssetsApiStockInstrumentRow,
): StockInstrumentApiResult | null {
    if (row.source !== 'clickhouse') return null;
    const out: StockInstrumentApiResult = {
        assetId: row.asset_id,
        symbol: row.symbol,
        normalizedSymbol: row.normalized_symbol,
        isActive: row.is_active,
        source: 'clickhouse',
        lastSyncedAt: row.last_synced_at,
    };
    if (row.name !== null) out.name = row.name;
    if (row.instrument_id !== null) out.instrumentId = row.instrument_id;
    if (row.dataset !== null) out.dataset = row.dataset;
    return out;
}

function stockPriceRowToResult(row: AssetsApiStockPriceRow): StockPriceApiResult | null {
    if (!isStockMarketSource(row.source)) {
        if (!warnedStockSources.has(row.source)) {
            warnedStockSources.add(row.source);
            console.warn(
                `[assetsApi] dropping stock_prices_latest row with unknown source="${row.source}" (assetId=${row.asset_id})`,
            );
        }
        return null;
    }
    return {
        assetId: row.asset_id,
        symbol: row.symbol,
        normalizedSymbol: row.normalized_symbol,
        priceUsd: row.price_usd,
        volume24hUsd: row.volume_24h_usd,
        priceChange24hPercent: row.price_change_24h_percent,
        asOf: row.as_of,
        lastFetchedAt: row.last_fetched_at,
        source: row.source,
    };
}

export async function loadAssetBaseForApi(
    repo: AssetsApiRepo,
    args: unknown,
): Promise<LoadAssetBaseForApiResult> {
    const a = asObject(args);
    const assetIdRaw = readString(a, 'assetId');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const includeVariants = readOptionalBoolean(a, 'includeVariants');
    const includeVariantMarkets = readOptionalBoolean(a, 'includeVariantMarkets') ?? false;
    const includeFillQuality = readOptionalBoolean(a, 'includeFillQuality') ?? false;
    const includeAssetMarket = readOptionalBoolean(a, 'includeAssetMarket') ?? false;
    const includeCoingeckoCoin = readOptionalBoolean(a, 'includeCoingeckoCoin') ?? false;
    const includeStockInstrument = readOptionalBoolean(a, 'includeStockInstrument') ?? false;
    const includeStockPrice = readOptionalBoolean(a, 'includeStockPrice') ?? false;

    const assetId = assetIdRaw.trim();
    const assetRow = assetId ? await repo.findAssetByAssetId(assetId) : null;

    if (!assetRow || (!includeInactive && !assetRow.is_active)) {
        return { asset: null, variants: [] };
    }

    const asset = assetRowToResult(assetRow);
    const variants =
        includeVariants === false
            ? []
            : (await repo.findActiveVariantsByAssetId(assetRow.asset_id)).map(variantRowToResult);

    const mints = variants.map(v => v.mint).slice(0, 250);

    const variantMarketsP: Promise<{ mint: string; market: VariantMarketApiResult | null }[] | undefined> =
        includeVariantMarkets
            ? (async () => {
                  const rows = await repo.findVariantMarketsLatestByMints(mints);
                  const byMint = new Map<string, AssetsApiVariantMarketRow>();
                  for (const row of rows) byMint.set(row.mint, row);
                  return mints.map(mint => {
                      const row = byMint.get(mint) ?? null;
                      return { mint, market: row ? variantMarketRowToResult(row) : null };
                  });
              })()
            : Promise.resolve(undefined);

    const fillQualityP: Promise<{ mint: string; fillQuality: FillQualityApiResult | null }[] | undefined> =
        includeFillQuality
            ? (async () => {
                  const rows = await repo.findVariantFillQualityLatestByMints(mints);
                  const byMint = new Map<string, AssetsApiFillQualityRow>();
                  for (const row of rows) byMint.set(row.mint, row);
                  return mints.map(mint => {
                      const row = byMint.get(mint) ?? null;
                      return { mint, fillQuality: row ? fillQualityRowToResult(row) : null };
                  });
              })()
            : Promise.resolve(undefined);

    const assetMarketP = includeAssetMarket
        ? repo.findAssetMarketsLatestByAssetId(assetRow.asset_id)
        : Promise.resolve(null);

    const coingeckoCoinP =
        includeCoingeckoCoin && assetRow.coingecko_id
            ? repo.findCoingeckoCoinByCoinId(assetRow.coingecko_id)
            : Promise.resolve(null);

    const stockInstrumentP = includeStockInstrument
        ? repo.findStockInstrumentsLatestByAssetId(assetRow.asset_id)
        : Promise.resolve(null);

    const stockPriceP = includeStockPrice
        ? repo.findStockPricesLatestByAssetId(assetRow.asset_id)
        : Promise.resolve(null);

    const [variantMarkets, fillQuality, assetMarket, coingeckoCoin, stockInstrument, stockPrice] = await Promise.all([
        variantMarketsP,
        fillQualityP,
        assetMarketP,
        coingeckoCoinP,
        stockInstrumentP,
        stockPriceP,
    ]);

    const result: LoadAssetBaseForApiResult = { asset, variants };
    if (variantMarkets !== undefined) result.variantMarkets = variantMarkets;
    if (fillQuality !== undefined) result.fillQuality = fillQuality;
    if (includeAssetMarket) {
        result.assetMarket = assetMarket ? assetMarketRowToResult(assetMarket) : null;
    }
    if (includeCoingeckoCoin) {
        result.coingeckoCoin = coingeckoCoin ? coingeckoCoinRowToResult(coingeckoCoin) : null;
    }
    if (includeStockInstrument) {
        result.stockInstrument =
            stockInstrument && stockInstrument.is_active
                ? stockInstrumentRowToResult(stockInstrument)
                : null;
    }
    if (includeStockPrice) {
        result.stockPrice = stockPrice ? stockPriceRowToResult(stockPrice) : null;
    }
    return result;
}
