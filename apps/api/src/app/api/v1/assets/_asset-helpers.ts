import {
    STOCK_VARIANT_TIERS,
    classifyLiquidityTier,
    pickPrimaryVariantWithRanking,
    type AssetVariant,
    type CanonicalAsset,
    type LiquidityTier,
    type PrimaryVariantStrategy,
    type StockVariantTier,
    type TrustTier,
} from '@tokens/asset-registry';
import { getCuratedMintRankSync } from '@/lib/curated-membership';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';

const CANONICAL_LOGO_PATH_BY_ASSET_ID: Record<string, string> = {
    aptos: '/logos/popular/aptos.png',
    bitcoin: '/logos/popular/bitcoin.png',
    bnb: '/logos/popular/bnb.png',
    binancecoin: '/logos/popular/bnb.png',
    copper: '/logos/commodities/copper.png',
    ethereum: '/logos/popular/ethereum.png',
    eur: '/logos/currencies/euro.png',
    gold: '/logos/commodities/gold.png',
    hyperliquid: '/logos/popular/hyperliquid.png',
    monad: '/logos/popular/monad.png',
    oil: '/logos/commodities/oil.png',
    silver: '/logos/commodities/silver.png',
    solana: '/logos/popular/solana.png',
    ripple: '/logos/popular/xrp.png',
    sui: '/logos/currencies/sui.png',
    tether: '/logos/popular/tether.png',
    uniswap: '/logos/popular/uniswap.png',
    usd: '/logos/currencies/usd.png',
    xrp: '/logos/popular/xrp.png',
};

const VARIANT_LOGO_FALLBACK_BY_MINT: Record<string, string> = {
    '6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU': '/logos/popular/tbtc-logo.png',
};

export interface TokenMarketSnapshot {
    address: string;
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    trade1h?: number | null;
    trade24h?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    price: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    marketCap: number | null;
    fdv: number | null;
    holder: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
    lastTradeAt?: number | null;
    asOf?: number | null;
}

export interface VariantExecutionQualitySnapshot {
    source: 'clickhouse_fill_quality';
    range: '24h';
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
    markoutPnl24hUSD: number | null;
    markoutCount: number | null;
    markoutBps: number | null;
    executionScore: number;
    isEligibleForPrimary: boolean;
    asOf: number | null;
    lastComputedAt: number;
}

export type VariantSortBy = 'liquidity' | 'execution_quality' | 'stock_redeemability';

export interface AssetStats {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    volume30dUSD: number | null;
    marketCap: number | null;
    fdv: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
}

export function normalizeText(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim();
}

export function normalizeSymbol(value: unknown): string {
    const trimmed = normalizeText(value);
    // Legacy placeholder from older Birdeye parsing.
    if (trimmed === '???') return '';
    return trimmed;
}

export function optionalText(value: unknown): string | null {
    const trimmed = normalizeText(value);
    return trimmed ? trimmed : null;
}

export function optionalSymbol(value: unknown): string | null {
    const trimmed = normalizeSymbol(value);
    return trimmed ? trimmed : null;
}

export function getProviderOnlyLabel(value: unknown): 'xstock' | 'ondo' | null {
    const normalized = normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (normalized === 'xstock') return 'xstock';
    if (normalized === 'ondo') return 'ondo';
    return null;
}

export function isCanonicalSymbolMatch(value: unknown, canonicalSymbol: unknown): boolean {
    const normalizedValue = normalizeSymbol(value);
    const normalizedCanonical = normalizeSymbol(canonicalSymbol);
    return Boolean(
        normalizedValue && normalizedCanonical && normalizedValue.toLowerCase() === normalizedCanonical.toLowerCase(),
    );
}

export function resolveVariantSymbol(args: {
    variantSymbol?: unknown;
    marketSymbol?: unknown;
    label?: unknown;
    canonicalSymbol?: unknown;
}): string | null {
    const canonicalSymbol = optionalSymbol(args.canonicalSymbol);
    const provider = getProviderOnlyLabel(args.label);
    const variantSymbol = optionalSymbol(args.variantSymbol);
    const marketSymbol = optionalSymbol(args.marketSymbol);
    const labelSymbol = optionalSymbol(args.label);

    if (!provider) {
        return variantSymbol ?? marketSymbol ?? labelSymbol ?? null;
    }

    const providerSymbol = canonicalSymbol
        ? provider === 'xstock'
            ? `${canonicalSymbol}x`
            : `${canonicalSymbol}on`
        : null;
    const variantIsBackfill =
        isCanonicalSymbolMatch(variantSymbol, canonicalSymbol) || getProviderOnlyLabel(variantSymbol);
    const marketIsBackfill =
        isCanonicalSymbolMatch(marketSymbol, canonicalSymbol) || getProviderOnlyLabel(marketSymbol);

    return (
        (variantIsBackfill ? null : variantSymbol) ?? providerSymbol ?? (marketIsBackfill ? null : marketSymbol) ?? null
    );
}

export function toFiniteNumberOrNull(value: unknown): number | null {
    if (typeof value !== 'number') return null;
    if (!Number.isFinite(value)) return null;
    return value;
}

export function parsePrimaryVariantStrategy(value: string | null): PrimaryVariantStrategy {
    if (value === 'stock_redeemability') return 'stock_redeemability';
    return value === 'execution_quality' ? 'execution_quality' : 'liquidity';
}

export function parseVariantSortBy(value: string | null): VariantSortBy {
    if (value === 'stock_redeemability') return 'stock_redeemability';
    return value === 'execution_quality' ? 'execution_quality' : 'liquidity';
}

export function parseStockVariantTier(value: string | null): StockVariantTier | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return (STOCK_VARIANT_TIERS as readonly string[]).includes(trimmed) ? (trimmed as StockVariantTier) : null;
}

const NON_PUBLIC_EQUITY_ASSET_ID_PREFIXES = ['pre-', 'stock-', 'private-'] as const;
const NON_PUBLIC_EQUITY_METADATA_PATTERN = /(^|[\s:_-])(pre[-\s]?ipo|pre[-\s]?stocks?|private|unlisted)($|[\s:_-])/;

function normalizeAssetIdentityText(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

/**
 * Categories whose canonical headline price comes from the ClickHouse stock
 * benchmark (`stock_instruments_latest` / `stock_prices_latest`) when a
 * mapping exists: equities (e.g. TSLA) and commodities (gold→GLD, silver→SLV,
 * oil→USO, copper→COPX).
 */
const STOCK_PRICED_CATEGORIES: ReadonlySet<string> = new Set(['equity', 'commodity']);

export function isStockPricedCategory(category: string | null | undefined): boolean {
    return typeof category === 'string' && STOCK_PRICED_CATEGORIES.has(category);
}

/**
 * The shares-outstanding cron refreshes daily; treat share counts older than
 * this as unusable so a symbol the provider stopped returning (delisting,
 * ticker change) can't keep producing a market cap from obsolete shares.
 */
const SHARES_OUTSTANDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Underlying-company market cap = stock price × shares outstanding.
 *
 * Equities only: for commodities the stock benchmark is an ETF proxy
 * (gold→GLD, silver→SLV), whose share count would yield the ETF's market cap,
 * not the asset's. Returns null when either input is missing or the stored
 * share count hasn't been refreshed within SHARES_OUTSTANDING_MAX_AGE_MS.
 */
export function computeCompanyMarketCapUsd(
    asset: Pick<CanonicalAsset, 'category'>,
    snapshot:
        | { priceUsd?: number | null; sharesOutstanding?: number | null; sharesLastFetchedAt?: number | null }
        | null
        | undefined,
    nowMs: number = Date.now(),
): number | null {
    if (asset.category !== 'equity') return null;
    const price = positiveFiniteNumber(snapshot?.priceUsd ?? null);
    const shares = positiveFiniteNumber(snapshot?.sharesOutstanding ?? null);
    if (price === null || shares === null) return null;
    const sharesLastFetchedAt = positiveFiniteNumber(snapshot?.sharesLastFetchedAt ?? null);
    if (sharesLastFetchedAt === null || nowMs - sharesLastFetchedAt > SHARES_OUTSTANDING_MAX_AGE_MS) return null;
    return price * shares;
}

export interface PreStocksDerived {
    /** Price the premium/implied valuation is derived from: our on-chain token price when finite, else the provider's token price. */
    basisPriceUsd: number | null;
    premiumToMarkPercent: number | null;
    impliedValuationUsd: number | null;
}

/**
 * Premium/discount and implied company valuation for a PreStocks token,
 * derived from the PreStocks reference (mark) fields and the token price we
 * display. Recomputed from raw fields (not the provider's own
 * `impliedValuation`) so the premium never disagrees with the displayed
 * price: impliedValuation = markValuation × tokenPrice ÷ markPrice.
 */
export function computePreStocksDerived(
    snapshot: {
        markPriceUsd: number | null;
        markValuationUsd: number | null;
        tokenPriceUsd: number | null;
    },
    onChainPriceUsd: number | null | undefined,
): PreStocksDerived {
    const markPrice = positiveFiniteNumber(snapshot.markPriceUsd);
    const markValuation = positiveFiniteNumber(snapshot.markValuationUsd);
    const basisPriceUsd = positiveFiniteNumber(onChainPriceUsd ?? null) ?? positiveFiniteNumber(snapshot.tokenPriceUsd);
    if (basisPriceUsd === null || markPrice === null) {
        return { basisPriceUsd, premiumToMarkPercent: null, impliedValuationUsd: null };
    }
    return {
        basisPriceUsd,
        premiumToMarkPercent: (basisPriceUsd / markPrice - 1) * 100,
        impliedValuationUsd: markValuation === null ? null : (markValuation * basisPriceUsd) / markPrice,
    };
}

export function isCanonicalPublicEquityAsset(
    asset: Pick<CanonicalAsset, 'assetId' | 'category' | 'aliases' | 'name' | 'symbol'>,
): boolean {
    if (asset.category !== 'equity') return false;
    const assetId = asset.assetId.trim();
    if (!assetId) return false;

    const identifiers = [asset.assetId, asset.symbol, asset.name, ...asset.aliases];
    const hasNonPublicSignal = identifiers.some(value => {
        const normalized = normalizeAssetIdentityText(value);
        return (
            NON_PUBLIC_EQUITY_ASSET_ID_PREFIXES.some(prefix => normalized.startsWith(prefix)) ||
            NON_PUBLIC_EQUITY_METADATA_PATTERN.test(normalized)
        );
    });
    if (hasNonPublicSignal) return false;

    const haystack = normalizeAssetIdentityText(`${asset.assetId} ${asset.name ?? ''}`);
    if (/\b(etf|fund|trust|nasdaq|russell|vanguard|ishares|spdr|proshares)\b/.test(haystack)) return false;

    return true;
}

export function variantMatchesFilters(
    variant: Pick<AssetVariant, 'kind' | 'stockVariantTier'> & { liquidityTier?: LiquidityTier },
    filters: {
        kind?: AssetVariant['kind'] | null;
        liquidityTier?: LiquidityTier | null;
        stockVariantTier?: StockVariantTier | null;
    },
): boolean {
    if (filters.kind && variant.kind !== filters.kind) return false;
    if (filters.liquidityTier && variant.liquidityTier !== filters.liquidityTier) return false;
    if (filters.stockVariantTier && variant.stockVariantTier !== filters.stockVariantTier) return false;
    return true;
}

export function optionalMarketSource(value: unknown): TokenMarketSnapshot['source'] | undefined {
    return value === 'birdeye' || value === 'rwa_xyz' || value === 'clickhouse_trades' ? value : undefined;
}

export function tokenMarketSnapshotFromConvexMarket(address: string, market: object): TokenMarketSnapshot {
    const fields = market as Record<string, unknown>;
    const source = optionalMarketSource(fields.source);
    const metricsSource = optionalMarketSource(fields.metricsSource);
    const logoURI = optionalText(fields.logoURI) ?? VARIANT_LOGO_FALLBACK_BY_MINT[address];

    return {
        address,
        ...(source ? { source } : {}),
        ...(metricsSource ? { metricsSource } : {}),
        symbol: optionalSymbol(fields.symbol),
        name: optionalText(fields.name),
        decimals: toFiniteNumberOrNull(fields.decimals),
        logoURI: logoURI ?? null,
        liquidity: toFiniteNumberOrNull(fields.liquidity),
        volume1hUSD: toFiniteNumberOrNull(fields.volume1hUSD),
        volume24hUSD: toFiniteNumberOrNull(fields.volume24hUSD),
        trade1h: toFiniteNumberOrNull(fields.trade1h),
        trade24h: toFiniteNumberOrNull(fields.trade24h),
        uniqueWallet1h: toFiniteNumberOrNull(fields.uniqueWallet1h),
        uniqueWallet24h: toFiniteNumberOrNull(fields.uniqueWallet24h),
        price: toFiniteNumberOrNull(fields.price),
        priceChange24hPercent: toFiniteNumberOrNull(fields.priceChange24hPercent),
        priceChange1hPercent: toFiniteNumberOrNull(fields.priceChange1hPercent),
        marketCap: toFiniteNumberOrNull(fields.marketCap),
        fdv: toFiniteNumberOrNull(fields.fdv),
        holder: toFiniteNumberOrNull(fields.holder),
        totalSupply: toFiniteNumberOrNull(fields.totalSupply),
        circulatingSupply: toFiniteNumberOrNull(fields.circulatingSupply),
        lastTradeAt: toFiniteNumberOrNull(fields.lastTradeAt),
        asOf: toFiniteNumberOrNull(fields.asOf),
    };
}

export function executionQualitySnapshotFromConvexFillQuality(
    fillQuality: object | null | undefined,
): VariantExecutionQualitySnapshot | null {
    if (!fillQuality) return null;
    const fields = fillQuality as Record<string, unknown>;
    if (fields.source !== 'clickhouse_fill_quality') return null;

    const lastComputedAt = toFiniteNumberOrNull(fields.lastComputedAt);
    if (lastComputedAt === null) return null;

    return {
        source: 'clickhouse_fill_quality',
        range: '24h',
        horizon: '5s',
        quoteMint: optionalText(fields.quoteMint) ?? '',
        volume24hUSD: toFiniteNumberOrNull(fields.volume24hUSD) ?? 0,
        trade24h: toFiniteNumberOrNull(fields.trade24h) ?? 0,
        botVolume24hUSD: toFiniteNumberOrNull(fields.botVolume24hUSD) ?? 0,
        botTrade24h: toFiniteNumberOrNull(fields.botTrade24h) ?? 0,
        botVolumeRatio: toFiniteNumberOrNull(fields.botVolumeRatio) ?? 0,
        fee24hUSD: toFiniteNumberOrNull(fields.fee24hUSD) ?? 0,
        feeBps: toFiniteNumberOrNull(fields.feeBps) ?? 0,
        flowSourceCount: toFiniteNumberOrNull(fields.flowSourceCount) ?? 0,
        markoutPnl24hUSD: toFiniteNumberOrNull(fields.markoutPnl24hUSD),
        markoutCount: toFiniteNumberOrNull(fields.markoutCount),
        markoutBps: toFiniteNumberOrNull(fields.markoutBps),
        executionScore: toFiniteNumberOrNull(fields.executionScore) ?? 0,
        isEligibleForPrimary: fields.isEligibleForPrimary === true,
        asOf: toFiniteNumberOrNull(fields.asOf),
        lastComputedAt,
    };
}

export function absolutizeLocalLogoUrl(request: Request, url: string | null | undefined): string | null {
    const trimmed = (url ?? '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('/logos/')) return new URL(rasterizeLocalLogoPath(trimmed), request.url).toString();

    try {
        const parsed = new URL(trimmed);
        if (parsed.pathname.startsWith('/logos/')) {
            return new URL(rasterizeLocalLogoPath(parsed.pathname), request.url).toString();
        }
    } catch {
        // ignore non-URL values
    }

    return trimmed;
}

function rasterizeLocalLogoPath(pathname: string): string {
    return pathname.replace(/\.svg$/i, '.png');
}

export function getCanonicalCurrencyLogoUrl(request: Request, assetId: string): string | null {
    const id = assetId.trim().toLowerCase();
    if (!id) return null;
    const path = CANONICAL_LOGO_PATH_BY_ASSET_ID[id];
    if (path) return new URL(path, request.url).toString();
    return null;
}

export function resolveAssetImageUrl(
    request: Request,
    params: { assetId: string; symbol?: string | null; imageUrl?: string | null },
): string | null {
    // Hand-curated canonical logos are authoritative: they must beat DB `image_url`
    // values, which are cache-warmed from symbol heuristics and can go stale
    // (e.g. gold was warmed to the GLDx xStock logo via the GLD symbol mapping).
    const localOverride = getCanonicalCurrencyLogoUrl(request, params.assetId);
    if (localOverride) return localOverride;

    const explicitImageUrl = absolutizeLocalLogoUrl(request, params.imageUrl ?? null);
    if (explicitImageUrl) return explicitImageUrl;

    return absolutizeLocalLogoUrl(
        request,
        getTokenLogoURLWithSecondarySymbol(params.symbol ?? undefined, params.assetId, undefined) ?? null,
    );
}

export function deriveLiquidityTier(liquidity: unknown): LiquidityTier {
    return classifyLiquidityTier(toFiniteNumberOrNull(liquidity));
}

export function deriveVariantTierFields(liquidity: unknown): { liquidityTier: LiquidityTier; trustTier: TrustTier } {
    const liquidityTier = deriveLiquidityTier(liquidity);
    return { liquidityTier, trustTier: liquidityTier };
}

export function withDerivedVariantTier<T extends object>(
    value: T,
    liquidity: unknown,
): T & { liquidityTier: LiquidityTier; trustTier: TrustTier } {
    return { ...value, ...deriveVariantTierFields(liquidity) };
}

/**
 * Curated rank is the primary-variant tiebreaker, sourced from the DB-backed
 * effective-membership snapshot. Synchronous last-good read: a cold instance
 * serves an empty map (selection falls through to liquidity/fill-quality)
 * while the snapshot loads in the background.
 */
export function buildCuratedMintRank(): Map<string, number> {
    return getCuratedMintRankSync();
}

function isSpotLikeKind(kind: AssetVariant['kind']): boolean {
    return (
        kind === 'native' ||
        kind === 'wrapped' ||
        kind === 'bridged' ||
        kind === 'spot' ||
        kind === 'stablecoin' ||
        kind === 'lst' ||
        kind === 'tokenized_equity' ||
        kind === 'basket'
    );
}

export function pickPrimaryVariant(
    asset: CanonicalAsset,
    mintRank: ReadonlyMap<string, number>,
    tokenByMint?: ReadonlyMap<string, TokenMarketSnapshot>,
    fillQualityByMint?: ReadonlyMap<string, VariantExecutionQualitySnapshot | null | undefined>,
    options?: { strategy?: PrimaryVariantStrategy },
): AssetVariant | null {
    return pickPrimaryVariantWithRanking({
        asset,
        mintRank,
        marketByMint: tokenByMint,
        fillQualityByMint,
        options: { strategy: options?.strategy ?? 'liquidity' },
    }).variant;
}

export function tokenToStats(token: TokenMarketSnapshot | undefined): AssetStats | null {
    if (!token) return null;
    return {
        price: token.price,
        liquidity: token.liquidity,
        volume24hUSD: token.volume24hUSD,
        volume30dUSD: null,
        marketCap: token.marketCap,
        fdv: token.fdv,
        priceChange24hPercent: token.priceChange24hPercent,
        priceChange1hPercent: token.priceChange1hPercent,
        totalSupply: token.totalSupply,
        circulatingSupply: token.circulatingSupply,
    };
}

function positiveFiniteNumber(value: unknown): number | null {
    const number = toFiniteNumberOrNull(value);
    return number !== null && number > 0 ? number : null;
}

function weightedAverageByVariantActivity(
    tokens: TokenMarketSnapshot[],
    valueForToken: (token: TokenMarketSnapshot) => number | null,
    options: { requirePositiveValue?: boolean } = {},
): number | null {
    const candidates = tokens
        .map(token => ({
            token,
            value: valueForToken(token),
        }))
        .filter(candidate => {
            const value = candidate.value;
            if (value === null) return false;
            return options.requirePositiveValue === true ? value > 0 : true;
        });
    const useLiquidityWeights = candidates.some(candidate => positiveFiniteNumber(candidate.token.liquidity) !== null);
    const weightForToken = useLiquidityWeights
        ? (token: TokenMarketSnapshot) => positiveFiniteNumber(token.liquidity)
        : (token: TokenMarketSnapshot) => positiveFiniteNumber(token.volume24hUSD);

    let weightedSum = 0;
    let weightSum = 0;
    for (const candidate of candidates) {
        const weight = weightForToken(candidate.token);
        if (weight === null) continue;
        const value = candidate.value;
        if (value === null) continue;
        weightedSum += value * weight;
        weightSum += weight;
    }

    return weightSum > 0 ? weightedSum / weightSum : null;
}

// On-chain markets below both floors are treated as inactive ("dust") for
// stock-priced assets: a single tiny trade on an empty pool can print an
// arbitrary price (and a wild 24h change computed from it), so the stock
// benchmark is more trustworthy than anything derived from these markets.
const DUST_ONCHAIN_MARKET_MAX_LIQUIDITY_USD = 100;
const DUST_ONCHAIN_MARKET_MAX_VOLUME24H_USD = 100;

export function selectCanonicalAssetStats(args: {
    coingecko?: {
        priceUsd?: number | null;
        marketCapUsd?: number | null;
        volume24hUsd?: number | null;
        priceChange24hPercent?: number | null;
    } | null;
    stock?: {
        priceUsd?: number | null;
        volume24hUsd?: number | null;
        priceChange24hPercent?: number | null;
        /** Underlying-company market cap (stock price × shares outstanding). */
        marketCapUsd?: number | null;
    } | null;
    aggregate?: AssetStats | null;
    primaryVariant?: AssetStats | null;
    preferAggregateVolume24h?: boolean;
    preferStockMarket?: boolean;
    /**
     * One token represents one share of the underlying stock, so
     * `stock.priceUsd` is a valid substitute for the on-chain token price.
     * Leave unset for commodities and other assets where the benchmark's
     * units differ from the token's (e.g. gold: GLD share vs per-oz spot).
     */
    stockPriceMatchesTokenUnits?: boolean;
}): AssetStats | null {
    const coingecko = args.coingecko ?? null;
    const stock = args.stock ?? null;
    const aggregate = args.aggregate ?? null;
    const primaryVariant = args.primaryVariant ?? null;
    const preferStockMarket = args.preferStockMarket === true;

    const pick = (...values: Array<unknown>): number | null => {
        for (const value of values) {
            const number = toFiniteNumberOrNull(value);
            if (number !== null) return number;
        }
        return null;
    };

    const onChainLiquidity = pick(aggregate?.liquidity, primaryVariant?.liquidity) ?? 0;
    const onChainVolume24hUSD = pick(aggregate?.volume24hUSD, primaryVariant?.volume24hUSD) ?? 0;
    const useStockForDustOnChain =
        preferStockMarket &&
        stock !== null &&
        onChainLiquidity < DUST_ONCHAIN_MARKET_MAX_LIQUIDITY_USD &&
        onChainVolume24hUSD < DUST_ONCHAIN_MARKET_MAX_VOLUME24H_USD;

    const price = preferStockMarket
        ? useStockForDustOnChain && args.stockPriceMatchesTokenUnits === true
            ? pick(stock?.priceUsd, aggregate?.price, primaryVariant?.price, coingecko?.priceUsd)
            : pick(aggregate?.price, primaryVariant?.price, coingecko?.priceUsd)
        : pick(coingecko?.priceUsd, stock?.priceUsd, aggregate?.price, primaryVariant?.price);
    const volume24hUSD = preferStockMarket
        ? pick(aggregate?.volume24hUSD, primaryVariant?.volume24hUSD, coingecko?.volume24hUsd)
        : args.preferAggregateVolume24h
          ? pick(aggregate?.volume24hUSD, primaryVariant?.volume24hUSD, coingecko?.volume24hUsd, stock?.volume24hUsd)
          : pick(coingecko?.volume24hUsd, stock?.volume24hUsd, aggregate?.volume24hUSD, primaryVariant?.volume24hUSD);
    const marketCap = preferStockMarket
        ? // For stock-priced assets, prefer the underlying company's market cap
          // (price × shares outstanding) over the aggregated tokenized-supply mcap.
          pick(stock?.marketCapUsd, aggregate?.marketCap, primaryVariant?.marketCap, coingecko?.marketCapUsd)
        : pick(coingecko?.marketCapUsd, aggregate?.marketCap, primaryVariant?.marketCap);
    const priceChange24hPercent = preferStockMarket
        ? useStockForDustOnChain
            ? pick(
                  stock?.priceChange24hPercent,
                  aggregate?.priceChange24hPercent,
                  primaryVariant?.priceChange24hPercent,
                  coingecko?.priceChange24hPercent,
              )
            : pick(
                  aggregate?.priceChange24hPercent,
                  primaryVariant?.priceChange24hPercent,
                  coingecko?.priceChange24hPercent,
              )
        : pick(
              coingecko?.priceChange24hPercent,
              stock?.priceChange24hPercent,
              aggregate?.priceChange24hPercent,
              primaryVariant?.priceChange24hPercent,
          );

    const selected: AssetStats = {
        price,
        liquidity: pick(aggregate?.liquidity, primaryVariant?.liquidity),
        volume24hUSD,
        volume30dUSD: pick(aggregate?.volume30dUSD, primaryVariant?.volume30dUSD),
        marketCap,
        fdv: pick(aggregate?.fdv, primaryVariant?.fdv),
        priceChange24hPercent,
        priceChange1hPercent: useStockForDustOnChain
            ? null
            : pick(aggregate?.priceChange1hPercent, primaryVariant?.priceChange1hPercent),
        totalSupply: pick(aggregate?.totalSupply, primaryVariant?.totalSupply),
        circulatingSupply: pick(aggregate?.circulatingSupply, primaryVariant?.circulatingSupply),
    };

    return Object.values(selected).some(value => typeof value === 'number' && Number.isFinite(value)) ? selected : null;
}

export function aggregateTokenStats(
    asset: CanonicalAsset,
    tokenByMint: ReadonlyMap<string, TokenMarketSnapshot>,
    primaryToken: TokenMarketSnapshot | undefined,
): AssetStats | null {
    const spotLikeVariants = asset.variants.filter(v => isSpotLikeKind(v.kind));
    const variants = spotLikeVariants.length > 0 ? spotLikeVariants : asset.variants;

    const base = tokenToStats(primaryToken) ?? {
        price: null,
        liquidity: null,
        volume24hUSD: null,
        volume30dUSD: null,
        marketCap: null,
        fdv: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        totalSupply: null,
        circulatingSupply: null,
    };

    const totals = {
        marketCap: 0,
        fdv: 0,
        totalSupply: 0,
        circulatingSupply: 0,
    };
    const hasTotals = {
        marketCap: false,
        fdv: false,
        totalSupply: false,
        circulatingSupply: false,
    };
    const tokensForWeightedStats: TokenMarketSnapshot[] = [];

    for (const variant of variants) {
        const token = tokenByMint.get(variant.mint);
        if (!token) continue;
        tokensForWeightedStats.push(token);

        for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
            const value = token[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
            totals[key] += value;
            hasTotals[key] = true;
        }
    }
    const weightedPrice = weightedAverageByVariantActivity(
        tokensForWeightedStats,
        token => toFiniteNumberOrNull(token.price),
        {
            requirePositiveValue: true,
        },
    );
    const weightedPriceChange24hPercent = weightedAverageByVariantActivity(tokensForWeightedStats, token =>
        toFiniteNumberOrNull(token.priceChange24hPercent),
    );
    const weightedPriceChange1hPercent = weightedAverageByVariantActivity(tokensForWeightedStats, token =>
        toFiniteNumberOrNull(token.priceChange1hPercent),
    );

    const hasBase = Object.values(base).some(value => typeof value === 'number' && Number.isFinite(value));
    const hasAnyTotal = Object.values(hasTotals).some(Boolean);
    const hasAnyWeightedStats =
        weightedPrice !== null || weightedPriceChange24hPercent !== null || weightedPriceChange1hPercent !== null;
    if (!hasBase && !hasAnyTotal && !hasAnyWeightedStats) return null;

    return {
        ...base,
        price: weightedPrice ?? base.price,
        marketCap: hasTotals.marketCap ? totals.marketCap : base.marketCap,
        fdv: hasTotals.fdv ? totals.fdv : base.fdv,
        priceChange24hPercent: weightedPriceChange24hPercent ?? base.priceChange24hPercent,
        priceChange1hPercent: weightedPriceChange1hPercent ?? base.priceChange1hPercent,
        totalSupply: hasTotals.totalSupply ? totals.totalSupply : base.totalSupply,
        circulatingSupply: hasTotals.circulatingSupply ? totals.circulatingSupply : base.circulatingSupply,
    };
}

export function mergeAssetStatsWithAggregates(
    stats: AssetStats | null,
    aggregates: { liquidity: number; volume24hUSD: number; volume30dUSD?: number | null } | null,
): AssetStats | null {
    if (!aggregates) return stats;

    const liquidity =
        typeof aggregates.liquidity === 'number' && Number.isFinite(aggregates.liquidity) ? aggregates.liquidity : 0;
    const volume24hUSD =
        typeof aggregates.volume24hUSD === 'number' && Number.isFinite(aggregates.volume24hUSD)
            ? aggregates.volume24hUSD
            : 0;
    const volume30dUSD =
        typeof aggregates.volume30dUSD === 'number' && Number.isFinite(aggregates.volume30dUSD)
            ? aggregates.volume30dUSD
            : null;
    const hasMeaningfulAggregates = liquidity > 0 || volume24hUSD > 0 || volume30dUSD !== null;

    if (!stats && !hasMeaningfulAggregates) return null;

    const base: AssetStats = stats ?? {
        price: null,
        liquidity: null,
        volume24hUSD: null,
        volume30dUSD: null,
        marketCap: null,
        fdv: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        totalSupply: null,
        circulatingSupply: null,
    };

    if (!hasMeaningfulAggregates) return base;

    return { ...base, liquidity, volume24hUSD, volume30dUSD };
}

export interface TokenMarketsDocLike {
    markets: Array<{
        liquidity?: number;
        volume24h?: number;
        price?: number;
        base?: { address: string; symbol?: string; name?: string; decimals?: number; icon?: string };
        quote?: { address: string; symbol?: string; name?: string; decimals?: number; icon?: string };
    }>;
}

function pickBestMarket(markets: TokenMarketsDocLike['markets']): TokenMarketsDocLike['markets'][number] | null {
    if (markets.length === 0) return null;

    return markets.reduce<TokenMarketsDocLike['markets'][number] | null>((best, next) => {
        if (!best) return next;
        const bestLiquidity =
            typeof best.liquidity === 'number' && Number.isFinite(best.liquidity) ? best.liquidity : 0;
        const nextLiquidity =
            typeof next.liquidity === 'number' && Number.isFinite(next.liquidity) ? next.liquidity : 0;
        if (nextLiquidity !== bestLiquidity) return nextLiquidity > bestLiquidity ? next : best;

        const bestVol = typeof best.volume24h === 'number' && Number.isFinite(best.volume24h) ? best.volume24h : 0;
        const nextVol = typeof next.volume24h === 'number' && Number.isFinite(next.volume24h) ? next.volume24h : 0;
        if (nextVol !== bestVol) return nextVol > bestVol ? next : best;

        return best;
    }, null);
}

export function buildSnapshotFromTokenMarketsDoc(params: {
    mint: string;
    assetFallbackSymbol: string | undefined;
    assetFallbackName: string | undefined;
    tokenMarketsDoc: TokenMarketsDocLike | null;
}): TokenMarketSnapshot | null {
    const mint = params.mint.trim();
    if (!mint) return null;
    const doc = params.tokenMarketsDoc;
    if (!doc || doc.markets.length === 0) return null;

    const best = pickBestMarket(doc.markets);
    if (!best) return null;

    const tokenMeta =
        best.base?.address === mint ? best.base : best.quote?.address === mint ? best.quote : (best.base ?? best.quote);
    const fallbackSymbol = (params.assetFallbackSymbol ?? '').trim() || '—';
    const fallbackName = (params.assetFallbackName ?? '').trim() || fallbackSymbol;

    const symbol = (tokenMeta?.symbol ?? '').trim() || fallbackSymbol;
    const name = (tokenMeta?.name ?? '').trim() || fallbackName;
    const decimals =
        typeof tokenMeta?.decimals === 'number' && Number.isFinite(tokenMeta.decimals) ? tokenMeta.decimals : null;
    const logoURI = (tokenMeta?.icon ?? '').trim() || VARIANT_LOGO_FALLBACK_BY_MINT[mint] || null;

    const liquidity = typeof best.liquidity === 'number' && Number.isFinite(best.liquidity) ? best.liquidity : null;
    const volume24hUSD = typeof best.volume24h === 'number' && Number.isFinite(best.volume24h) ? best.volume24h : null;
    const price = typeof best.price === 'number' && Number.isFinite(best.price) ? best.price : null;

    return {
        address: mint,
        symbol: symbol === '—' ? null : symbol,
        name: name === '—' ? null : name,
        decimals,
        logoURI,
        liquidity,
        volume24hUSD,
        price,
        // Birdeye markets payload doesn’t provide these fields reliably.
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        marketCap: null,
        fdv: null,
        holder: null,
        totalSupply: null,
        circulatingSupply: null,
    };
}

export function listSymbols(asset: CanonicalAsset, tokenByMint?: ReadonlyMap<string, TokenMarketSnapshot>): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();

    function add(value: string | undefined | null) {
        const trimmed = (value ?? '').trim();
        if (!trimmed) return;
        if (seen.has(trimmed)) return;
        seen.add(trimmed);
        unique.push(trimmed);
    }

    // Prefer the canonical asset symbol (e.g. BTC, XAU) first.
    add(asset.symbol);

    for (const variant of asset.variants) {
        add(variant.symbol);
        add(tokenByMint?.get(variant.mint)?.symbol);
        // Keep labels as a last resort for variants without symbol coverage.
        add(variant.label);
    }

    return unique;
}
