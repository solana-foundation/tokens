import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Effect } from 'effect';
import { apiJson } from '@/effect/api-client';
import type { Token } from '@/lib/types';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import type { CuratedListSlug as CuratedTokenListId } from '@tokens/asset-registry/curated-lists';

interface TokensQueryOptions {
    enabled?: boolean;
    /** Seed the cache (e.g. with SSR data). Only used when the cache entry is empty. */
    initialData?: Token[];
    /** Timestamp of when `initialData` was fetched, so staleTime applies accurately. */
    initialDataUpdatedAt?: number;
}

export type CuratedTokenCategoryId = CuratedTokenListId;
export type TrendingMode = 'fresh' | 'flow';

interface AssetMarketSnapshot {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume5mUSD?: number | null;
    volume15mUSD?: number | null;
    volume1hUSD?: number | null;
    volume6hUSD?: number | null;
    volume24hUSD: number | null;
    trade5m?: number | null;
    trade15m?: number | null;
    trade1h?: number | null;
    trade6h?: number | null;
    trade24h?: number | null;
    uniqueWallet5m?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    decimals: number | null;
    logoURI: string | null;
    // These may or may not be present depending on the endpoint/version.
    symbol?: string;
    name?: string;
    lastTradeAt?: number | null;
    asOf?: number | null;
    lastFetchedAt?: number | null;
}

interface AssetPrimaryVariant {
    mint: string;
    symbol?: string;
    name?: string;
    market?: AssetMarketSnapshot | null;
}

interface AssetStats {
    price: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    marketCap: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
}

type CanonicalMarketSnapshot =
    | {
          source: 'coingecko';
          coinId: string;
          price: number | null;
          marketCap: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
      }
    | {
          source: 'clickhouse_stock';
          symbol: string;
          price: number | null;
          marketCap?: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      }
    | {
          source: 'prestocks';
          symbol: string;
          mint: string;
          price: number | null;
          /** Implied company valuation — NOT the tokenized float value. */
          marketCap: number | null;
          markPriceUsd: number | null;
          markValuationUsd: number | null;
          impliedValuationUsd: number | null;
          premiumToMarkPercent: number | null;
          volume24hUSD: number | null;
          priceChange24hPercent: number | null;
          lastFetchedAt: number | null;
          providerLastUpdatedAt: number | null;
          asOf: number | null;
      };

interface AssetSearchResult {
    assetId: string;
    name?: string;
    symbol?: string;
    category?: string;
    coingeckoId?: string;
    imageUrl?: string | null;
    canonicalMarket?: CanonicalMarketSnapshot;
    stats?: AssetStats | null;
    primaryVariant: AssetPrimaryVariant | null;
}

interface AssetsCuratedResponse {
    listId: string;
    assets: AssetSearchResult[];
}

interface AssetsSearchResponse {
    query: string;
    category: string | null;
    results: AssetSearchResult[];
}

interface TrendingAssetResult {
    rank: number;
    assetId: string;
    mint: string;
    symbol: string;
    name: string;
    category: string;
    decimals: number;
    imageUrl: string | null;
    market: {
        source: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
        metricsSource: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
        price: number | null;
        liquidity?: number | null;
        volume5mUSD?: number | null;
        volume15mUSD?: number | null;
        volume1hUSD?: number | null;
        volume6hUSD?: number | null;
        volume24hUSD?: number | null;
        trade5m?: number | null;
        trade15m?: number | null;
        trade1h?: number | null;
        trade6h?: number | null;
        trade24h?: number | null;
        uniqueWallet5m?: number | null;
        uniqueWallet1h?: number | null;
        uniqueWallet24h?: number | null;
        priceChange1hPercent: number | null;
        priceChange24hPercent: number | null;
        lastTradeAt: number | null;
        asOf: number | null;
        lastFetchedAt?: number | null;
    };
    trending: {
        score: number;
        scoringVersion: string;
    };
}

interface AssetsTrendingResponse {
    trending: TrendingAssetResult[];
}

function canonicalVolumeLabel(source: CanonicalMarketSnapshot['source'] | undefined): string | null {
    if (source === 'clickhouse_stock') return 'Stock';
    if (source === 'coingecko') return 'Canonical';
    return null;
}

function shouldShowCanonicalVolumePill(result: AssetSearchResult, canonicalMarket: CanonicalMarketSnapshot | null) {
    return canonicalMarket?.source === 'clickhouse_stock' || result.category === 'crypto';
}

function assetResultToToken(result: AssetSearchResult): Token | null {
    const primary = result.primaryVariant;
    const market = primary?.market;
    const stats = result.stats ?? null;
    const canonicalMarket = result.canonicalMarket ?? null;
    if (!primary) return null;

    function pickFinite(primary: number | null | undefined, fallback: number | null | undefined): number | null {
        const a = typeof primary === 'number' && Number.isFinite(primary) ? primary : null;
        if (a !== null) return a;
        const b = typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : null;
        return b;
    }

    function pickPositive(primary: number | null | undefined, fallback: number | null | undefined): number | null {
        const a = typeof primary === 'number' && Number.isFinite(primary) && primary > 0 ? primary : null;
        if (a !== null) return a;
        const b = typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : null;
        return b;
    }

    // Prefer canonical identity (asset-level), then fall back to the primary mint.
    const symbol = (result.symbol ?? primary.symbol ?? market?.symbol ?? '').trim() || '—';
    const name = (result.name ?? primary.name ?? market?.name ?? symbol).trim() || symbol;
    const fallbackLogoURI = result.imageUrl ?? market?.logoURI ?? undefined;
    const marketSymbol = (market?.symbol ?? primary.symbol ?? '').trim() || undefined;
    const logoURI = getTokenLogoURLWithSecondarySymbol(symbol, marketSymbol, fallbackLogoURI);
    const priceChange1hPercent = pickFinite(market?.priceChange1hPercent, stats?.priceChange1hPercent);
    const canonicalPrice = pickPositive(canonicalMarket?.price, null);
    const canonicalPriceChange24h = pickFinite(canonicalMarket?.priceChange24hPercent, null);
    const isStockCanonical = canonicalMarket?.source === 'clickhouse_stock';
    const showCanonicalVolumePill = shouldShowCanonicalVolumePill(result, canonicalMarket);
    const underlyingVolume24hUSD =
        showCanonicalVolumePill && canonicalMarket ? pickPositive(canonicalMarket.volume24hUSD, null) : null;
    const underlyingVolume24hLabel =
        underlyingVolume24hUSD !== null ? canonicalVolumeLabel(canonicalMarket?.source) : null;
    const coingeckoId = canonicalMarket?.source === 'coingecko' ? canonicalMarket.coinId : result.coingeckoId;

    return {
        assetId: result.assetId,
        ...(coingeckoId ? { coingeckoId } : {}),
        ...(result.category ? { category: result.category } : {}),
        ...(canonicalMarket?.source ? { canonicalMarketSource: canonicalMarket.source } : {}),
        address: primary.mint,
        ...(market?.source ? { source: market.source } : {}),
        ...(market?.metricsSource ? { metricsSource: market.metricsSource } : {}),
        symbol,
        name,
        decimals: market?.decimals ?? 9,
        ...(logoURI ? { logoURI } : {}),
        liquidity: pickPositive(stats?.liquidity, market?.liquidity) ?? 0,
        ...(market?.volume1hUSD != null ? { volume1hUSD: market.volume1hUSD } : {}),
        volume24hUSD: pickPositive(stats?.volume24hUSD, market?.volume24hUSD) ?? 0,
        ...(underlyingVolume24hUSD !== null ? { underlyingVolume24hUSD } : {}),
        ...(underlyingVolume24hLabel ? { underlyingVolume24hLabel } : {}),
        ...(market?.trade1h != null ? { trade1h: market.trade1h } : {}),
        ...(market?.trade24h != null ? { trade24h: market.trade24h } : {}),
        ...(market?.uniqueWallet1h != null ? { uniqueWallet1h: market.uniqueWallet1h } : {}),
        ...(market?.uniqueWallet24h != null ? { uniqueWallet24h: market.uniqueWallet24h } : {}),
        price: isStockCanonical
            ? (pickPositive(stats?.price, market?.price) ?? canonicalPrice ?? 0)
            : (canonicalPrice ?? pickPositive(market?.price, stats?.price) ?? 0),
        priceChange24hPercent: isStockCanonical
            ? (pickFinite(stats?.priceChange24hPercent, market?.priceChange24hPercent) ?? canonicalPriceChange24h ?? 0)
            : (canonicalPriceChange24h ?? pickFinite(market?.priceChange24hPercent, stats?.priceChange24hPercent) ?? 0),
        ...(priceChange1hPercent !== null ? { priceChange1hPercent } : {}),
        marketCap: isStockCanonical
            ? 0
            : (pickPositive(canonicalMarket?.marketCap, pickPositive(market?.marketCap, stats?.marketCap)) ?? 0),
        ...(market?.lastTradeAt != null ? { lastTradeAt: market.lastTradeAt } : {}),
        ...(market?.asOf != null ? { asOf: market.asOf } : {}),
    } satisfies Token;
}

function trendingResultToToken(result: TrendingAssetResult): Token {
    const market = result.market;
    const logoURI = (result.imageUrl ?? '').trim() || undefined;

    return {
        assetId: result.assetId,
        address: result.mint,
        source: market.source,
        metricsSource: market.metricsSource,
        symbol: result.symbol,
        name: result.name,
        decimals: result.decimals,
        ...(logoURI ? { logoURI } : {}),
        liquidity: market.liquidity ?? 0,
        ...(market.volume5mUSD != null ? { volume5mUSD: market.volume5mUSD } : {}),
        ...(market.volume15mUSD != null ? { volume15mUSD: market.volume15mUSD } : {}),
        ...(market.volume1hUSD != null ? { volume1hUSD: market.volume1hUSD } : {}),
        ...(market.volume6hUSD != null ? { volume6hUSD: market.volume6hUSD } : {}),
        volume24hUSD: market.volume24hUSD ?? 0,
        ...(market.trade5m != null ? { trade5m: market.trade5m } : {}),
        ...(market.trade15m != null ? { trade15m: market.trade15m } : {}),
        ...(market.trade1h != null ? { trade1h: market.trade1h } : {}),
        ...(market.trade6h != null ? { trade6h: market.trade6h } : {}),
        ...(market.trade24h != null ? { trade24h: market.trade24h } : {}),
        ...(market.uniqueWallet5m != null ? { uniqueWallet5m: market.uniqueWallet5m } : {}),
        ...(market.uniqueWallet1h != null ? { uniqueWallet1h: market.uniqueWallet1h } : {}),
        ...(market.uniqueWallet24h != null ? { uniqueWallet24h: market.uniqueWallet24h } : {}),
        price: market.price ?? 0,
        priceChange24hPercent: market.priceChange24hPercent ?? 0,
        ...(market.priceChange1hPercent != null ? { priceChange1hPercent: market.priceChange1hPercent } : {}),
        marketCap: 0,
        ...(market.lastTradeAt != null ? { lastTradeAt: market.lastTradeAt } : {}),
        ...(market.asOf != null ? { asOf: market.asOf } : {}),
        trendingRank: result.rank,
        trendingScore: result.trending.score,
    } satisfies Token;
}

export async function fetchCuratedTokens(listId: CuratedTokenCategoryId, signal?: AbortSignal): Promise<Token[]> {
    const data = await Effect.runPromise(
        apiJson<AssetsCuratedResponse>({
            // Default is `groupBy=asset` to ensure a single canonical row per real-world asset.
            url: `/api/v1/assets/curated?list=${encodeURIComponent(listId)}&groupBy=asset`,
        }),
        { signal },
    );

    const tokens = (data.assets ?? []).map(assetResultToToken).filter((t): t is NonNullable<typeof t> => t !== null);
    const seen = new Set<string>();
    const unique: Token[] = [];
    for (const token of tokens) {
        const key = (token.assetId ?? '').trim() || token.address;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(token);
    }
    return unique;
}

export async function fetchTrendingTokens(mode: TrendingMode = 'fresh', signal?: AbortSignal): Promise<Token[]> {
    const data = await Effect.runPromise(
        apiJson<AssetsTrendingResponse>({
            url: `/api/v1/assets/trending?limit=50&mode=${encodeURIComponent(mode)}`,
        }),
        { signal },
    );

    return (data.trending ?? []).map(trendingResultToToken);
}

export async function fetchSearchTokens(query: string, signal?: AbortSignal): Promise<Token[]> {
    const params = new URLSearchParams({ q: query, limit: '20' });
    const data = await Effect.runPromise(
        apiJson<AssetsSearchResponse>({ url: `/api/v1/assets/search?${params.toString()}` }),
        {
            signal,
        },
    );
    const tokens = (data.results ?? []).map(assetResultToToken).filter((t): t is NonNullable<typeof t> => t !== null);
    const seen = new Set<string>();
    const unique: Token[] = [];
    for (const token of tokens) {
        const key = (token.assetId ?? '').trim() || token.address;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(token);
    }
    return unique;
}

export function useCuratedTokens(listId: CuratedTokenCategoryId, options: TokensQueryOptions = {}) {
    const { enabled = true, initialData, initialDataUpdatedAt } = options;

    return useQuery<Token[]>({
        queryKey: ['tokens', 'curated', listId],
        queryFn: ({ signal }) => fetchCuratedTokens(listId, signal),
        staleTime: 30 * 1000,
        placeholderData: keepPreviousData,
        initialData,
        initialDataUpdatedAt,
        enabled,
    });
}

export function useTrendingTokens(options: TokensQueryOptions & { mode?: TrendingMode } = {}) {
    const { enabled = true, mode = 'fresh', initialData, initialDataUpdatedAt } = options;

    return useQuery<Token[]>({
        queryKey: ['tokens', 'trending', mode],
        queryFn: ({ signal }) => fetchTrendingTokens(mode, signal),
        staleTime: mode === 'fresh' ? 15 * 1000 : 30 * 1000,
        placeholderData: keepPreviousData,
        initialData,
        initialDataUpdatedAt,
        enabled,
    });
}

export function useSearchTokens(query: string, options: TokensQueryOptions = {}) {
    const { enabled = true } = options;

    return useQuery<Token[]>({
        queryKey: ['tokens', 'search', query],
        queryFn: ({ signal }) => fetchSearchTokens(query, signal),
        enabled: enabled && query.length >= 2,
    });
}
