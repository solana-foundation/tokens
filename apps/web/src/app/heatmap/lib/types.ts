import type { VariantKind } from '@tokens/asset-registry';

/** Subset of `GET /api/v1/assets/curated?groupBy=asset&variants=all` the heat map reads. */
export interface RawVariantMarket {
    price?: number | null;
    liquidity?: number | null;
    volume24hUSD?: number | null;
    marketCap?: number | null;
    priceChange24hPercent?: number | null;
    priceChange1hPercent?: number | null;
    logoURI?: string | null;
    symbol?: string | null;
    name?: string | null;
}

export interface RawVariant {
    variantId?: string | null;
    mint: string;
    symbol?: string | null;
    name?: string | null;
    kind?: VariantKind;
    tags?: string[] | null;
    market?: RawVariantMarket | null;
}

export interface RawAssetStats {
    price?: number | null;
    liquidity?: number | null;
    volume24hUSD?: number | null;
    marketCap?: number | null;
    priceChange24hPercent?: number | null;
    priceChange1hPercent?: number | null;
}

export interface RawCanonicalMarket {
    source?: string;
    price?: number | null;
    marketCap?: number | null;
    priceChange24hPercent?: number | null;
}

export interface RawAsset {
    assetId: string;
    name?: string | null;
    symbol?: string | null;
    imageUrl?: string | null;
    stats?: RawAssetStats | null;
    canonicalMarket?: RawCanonicalMarket | null;
    primaryVariant?: RawVariant | null;
    variants?: RawVariant[] | null;
}

/** A home-page category: a curated list and the canonical assets that belong to it. */
export interface HeatmapSectorMembership {
    id: string;
    label: string;
    assetIds: string[];
}

export interface RawCuratedResponse {
    listId?: string;
    assets?: RawAsset[] | null;
}

export const HEATMAP_PERIODS = ['24h', '1h'] as const;
export type HeatmapPeriod = (typeof HEATMAP_PERIODS)[number];

export interface HeatmapVariant {
    /** Unique within the asset. The mint alone is not: one address can be a variant on two chains. */
    id: string;
    mint: string;
    symbol: string;
    name: string;
    logoURI?: string;
    /** Display category from `getAssetVariantCategory` (Native / Wrapped / Bridged / …). */
    groupId: string;
    groupLabel: string;
    groupOrder: number;
    price: number | null;
    change24h: number | null;
    change1h: number | null;
    marketCap: number | null;
    volume24h: number | null;
    liquidity: number | null;
}

export interface HeatmapAsset {
    assetId: string;
    symbol: string;
    name: string;
    sectorId: string;
    logoURI?: string;
    price: number | null;
    change24h: number | null;
    change1h: number | null;
    /** Underlying market cap when a canonical source reports one, else the on-Solana value. */
    marketCap: number | null;
    marketCapSource: 'underlying' | 'onchain';
    /** On-Solana 24h volume. */
    volume24h: number | null;
    variantCount: number;
    /** Only populated for assets with more than one variant; those are the ones that drill down. */
    variants: HeatmapVariant[];
    /** Primary variant's mint; the asset page link is `buildCoinHref(assetId, mint)`, as on the home page. */
    mint?: string;
}

export interface HeatmapSector {
    /** Curated list slug, the same id the home page uses for its category tabs. */
    id: string;
    label: string;
    assets: HeatmapAsset[];
}

export interface HeatmapData {
    sectors: HeatmapSector[];
    assetCount: number;
    variantCount: number;
    generatedAt: number;
}
