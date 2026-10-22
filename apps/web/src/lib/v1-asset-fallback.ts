import type { CanonicalAsset, LiquidityTier } from '@tokens/asset-registry';
import { normalizeAddressForChain } from '@tokens/asset-registry/chains';

import type { V2AssetStats, V2Market, V2MarketSource } from '@/lib/api-v2-types';
import { normalizeAdvisory } from '@/lib/asset-advisory';

/**
 * v1 still serves mints that have no v2 variant row: approved launch coins and
 * Sanctum-only LSTs (the v1 registered-only tiers). Until v2 grows a tier for
 * those, the asset page falls back to the v1 resolver for them, shaped like a
 * compiled-registry asset so the shell renders the same Solana sections.
 */
export interface V1AssetsResolveResponse {
    assetId: string;
    asset: {
        assetId: string;
        name?: string | null;
        symbol?: string | null;
        category: CanonicalAsset['category'];
        aliases: string[];
    };
    variant: {
        mint: string;
        kind: CanonicalAsset['variants'][number]['kind'];
        liquidityTier?: LiquidityTier;
        trustTier: CanonicalAsset['variants'][number]['trustTier'];
        tags: string[];
        issuer?: string;
        issuerUrl?: string;
        label?: string;
        symbol?: string;
        name?: string;
        /** `{ status, reason, url, since } | null`; direct mint lookups still resolve flagged mints. */
        advisory?: unknown;
    } | null;
}

export function canonicalAssetFromV1Resolve(response: V1AssetsResolveResponse): CanonicalAsset {
    const name = (response.asset.name ?? '').trim();
    const symbol = (response.asset.symbol ?? '').trim();
    const variant = response.variant;
    const variantAdvisory = variant ? normalizeAdvisory(variant.advisory) : null;

    return {
        assetId: response.asset.assetId,
        ...(name ? { name } : {}),
        ...(symbol ? { symbol } : {}),
        category: response.asset.category,
        aliases: response.asset.aliases,
        variants: variant
            ? [
                  {
                      variantId: `${response.asset.assetId}:${variant.mint.slice(0, 8)}`,
                      mint: variant.mint,
                      kind: variant.kind,
                      trustTier: variant.trustTier,
                      tags: variant.tags,
                      ...(variant.issuer ? { issuer: variant.issuer } : {}),
                      ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                      ...(variant.label ? { label: variant.label } : {}),
                      ...(variant.symbol ? { symbol: variant.symbol } : {}),
                      ...(variant.name ? { name: variant.name } : {}),
                      ...(variantAdvisory ? { advisory: variantAdvisory } : {}),
                  },
              ]
            : [],
    };
}

const SINGLETON_PREFIX = 'solana-';

/** The mint behind a v1 singleton asset id (`solana-<mint>`), or null for any other ref. */
export function singletonMintOf(ref: string): string | null {
    const trimmed = ref.trim();
    if (!trimmed.startsWith(SINGLETON_PREFIX)) return null;
    return normalizeAddressForChain('solana', trimmed.slice(SINGLETON_PREFIX.length));
}

type V1DetailStats = Partial<Record<keyof V2AssetStats, unknown>> | null;

interface V1DetailVariant {
    mint: string;
    market?: Record<string, unknown> | null;
}

/** The parts of `GET /v1/assets/{assetId}?mint=` the fallback page reads (v1 nests them under `asset`). */
export interface V1AssetDetailResponse {
    asset?: {
        stats?: V1DetailStats;
        primaryVariant?: V1DetailVariant | null;
        variantGroups?: Record<string, V1DetailVariant[] | null> | null;
    } | null;
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const V2_MARKET_SOURCES: ReadonlySet<string> = new Set<V2MarketSource>(['birdeye', 'rwa_xyz', 'clickhouse_trades']);

function marketSource(value: unknown): V2MarketSource | null {
    return typeof value === 'string' && V2_MARKET_SOURCES.has(value) ? (value as V2MarketSource) : null;
}

/** A v1 variant `market` block in the v2 shape the page renders (v1 emits a superset of these keys). */
export function v1MarketToV2Market(market: Record<string, unknown>): V2Market {
    return {
        source: marketSource(market.source) ?? 'birdeye',
        metricsSource: marketSource(market.metricsSource),
        price: finiteOrNull(market.price),
        liquidity: finiteOrNull(market.liquidity),
        volume1hUSD: finiteOrNull(market.volume1hUSD),
        volume24hUSD: finiteOrNull(market.volume24hUSD),
        trade1h: finiteOrNull(market.trade1h),
        trade24h: finiteOrNull(market.trade24h),
        uniqueWallet1h: finiteOrNull(market.uniqueWallet1h),
        uniqueWallet24h: finiteOrNull(market.uniqueWallet24h),
        marketCap: finiteOrNull(market.marketCap),
        fdv: finiteOrNull(market.fdv),
        holder: finiteOrNull(market.holder),
        totalSupply: finiteOrNull(market.totalSupply),
        circulatingSupply: finiteOrNull(market.circulatingSupply),
        priceChange1hPercent: finiteOrNull(market.priceChange1hPercent),
        priceChange24hPercent: finiteOrNull(market.priceChange24hPercent),
        lastTradeAt: finiteOrNull(market.lastTradeAt),
        asOf: finiteOrNull(market.asOf),
        lastFetchedAt: finiteOrNull(market.lastFetchedAt),
    };
}

export function v1StatsToV2Stats(stats: V1DetailStats | undefined): V2AssetStats | null {
    if (!stats) return null;
    return {
        price: finiteOrNull(stats.price),
        liquidity: finiteOrNull(stats.liquidity),
        volume24hUSD: finiteOrNull(stats.volume24hUSD),
        volume30dUSD: finiteOrNull(stats.volume30dUSD),
        marketCap: finiteOrNull(stats.marketCap),
        fdv: finiteOrNull(stats.fdv),
        priceChange24hPercent: finiteOrNull(stats.priceChange24hPercent),
        priceChange1hPercent: finiteOrNull(stats.priceChange1hPercent),
        totalSupply: finiteOrNull(stats.totalSupply),
        circulatingSupply: finiteOrNull(stats.circulatingSupply),
    };
}

export interface V1FallbackDetail {
    stats: V2AssetStats | null;
    /** Solana mint → market block, for the variants v1 priced. */
    marketByMint: Map<string, V2Market>;
    logoByMint: Map<string, string>;
}

export function v1DetailToFallback(detail: V1AssetDetailResponse): V1FallbackDetail {
    const marketByMint = new Map<string, V2Market>();
    const logoByMint = new Map<string, string>();
    const asset = detail.asset ?? null;
    const variants = [
        asset?.primaryVariant,
        ...Object.values(asset?.variantGroups ?? {}).flatMap(group => group ?? []),
    ];
    for (const variant of variants) {
        if (!variant?.mint || !variant.market || marketByMint.has(variant.mint)) continue;
        marketByMint.set(variant.mint, v1MarketToV2Market(variant.market));
        const logo = variant.market.logoURI;
        if (typeof logo === 'string' && logo.trim()) logoByMint.set(variant.mint, logo.trim());
    }
    return { stats: v1StatsToV2Stats(asset?.stats), marketByMint, logoByMint };
}
