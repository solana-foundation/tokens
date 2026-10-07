import { getAssetVariantCategory } from '@/lib/asset-variant-categories';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import type {
    HeatmapAsset,
    HeatmapData,
    HeatmapSector,
    HeatmapSectorMembership,
    HeatmapVariant,
    RawAsset,
    RawCuratedResponse,
    RawVariant,
} from './types';

/** Assets the curated union returns but no home-page category claims; should stay empty. */
const OTHER_SECTOR = { id: 'other', label: 'Other' };

function finite(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positive(value: number | null | undefined): number | null {
    const n = finite(value);
    return n !== null && n > 0 ? n : null;
}

function firstFinite(...values: Array<number | null | undefined>): number | null {
    for (const value of values) {
        const n = finite(value);
        if (n !== null) return n;
    }
    return null;
}

function firstPositive(...values: Array<number | null | undefined>): number | null {
    for (const value of values) {
        const n = positive(value);
        if (n !== null) return n;
    }
    return null;
}

/** Trim precision the map never shows; the tree is serialized into the page. */
function round(value: number | null, digits: number): number | null {
    if (value === null) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function roundPrice(value: number | null): number | null {
    if (value === null) return null;
    return Number(value.toPrecision(6));
}

function sumPositive(values: Array<number | null | undefined>): number | null {
    let total = 0;
    for (const value of values) total += positive(value) ?? 0;
    return total > 0 ? total : null;
}

function buildVariant(assetId: string, variant: RawVariant): HeatmapVariant {
    const market = variant.market ?? null;
    const symbol = (variant.symbol ?? market?.symbol ?? '').trim() || `${variant.mint.slice(0, 4)}…`;
    const name = (variant.name ?? market?.name ?? '').trim() || symbol;
    const group = getAssetVariantCategory(assetId, {
        mint: variant.mint,
        kind: variant.kind,
        tags: variant.tags ?? [],
        name: variant.name,
        symbol: variant.symbol,
    });
    const logoURI = normalizeLogoSrc(market?.logoURI ?? undefined);

    return {
        id: variant.variantId?.trim() || variant.mint,
        mint: variant.mint,
        symbol,
        name,
        ...(logoURI ? { logoURI } : {}),
        groupId: group.id,
        groupLabel: group.label,
        groupOrder: group.order,
        price: roundPrice(positive(market?.price)),
        change24h: round(finite(market?.priceChange24hPercent), 2),
        change1h: round(finite(market?.priceChange1hPercent), 2),
        marketCap: round(positive(market?.marketCap), 0),
        volume24h: round(positive(market?.volume24hUSD), 0),
        liquidity: round(positive(market?.liquidity), 0),
    };
}

function buildAsset(raw: RawAsset, sectorOf: ReadonlyMap<string, string>): HeatmapAsset | null {
    const assetId = raw.assetId?.trim();
    if (!assetId) return null;

    const primary = raw.primaryVariant ?? null;
    const rawVariants = (raw.variants ?? []).filter(variant => Boolean(variant?.mint));
    if (!primary && rawVariants.length === 0) return null;

    const stats = raw.stats ?? null;
    const canonical = raw.canonicalMarket ?? null;
    const primaryMarket = primary?.market ?? null;
    // Stock canonicals quote the listed share; the on-chain token is what trades here (same rule as the home table).
    const isStockCanonical = canonical?.source === 'clickhouse_stock';

    const symbol = (raw.symbol ?? primary?.symbol ?? primaryMarket?.symbol ?? '').trim() || '—';
    const name = (raw.name ?? primary?.name ?? primaryMarket?.name ?? '').trim() || symbol;
    const primarySymbol = (primaryMarket?.symbol ?? primary?.symbol ?? '').trim() || undefined;
    const logoURI = normalizeLogoSrc(
        getTokenLogoURLWithSecondarySymbol(symbol, primarySymbol, raw.imageUrl ?? primaryMarket?.logoURI ?? undefined),
    );

    const onchainCap = sumPositive(rawVariants.map(variant => variant.market?.marketCap));
    const underlyingCap = positive(canonical?.marketCap);
    const marketCap = underlyingCap ?? firstPositive(stats?.marketCap, onchainCap);

    const price = isStockCanonical
        ? firstPositive(stats?.price, primaryMarket?.price, canonical?.price)
        : firstPositive(canonical?.price, primaryMarket?.price, stats?.price);
    const change24h = isStockCanonical
        ? firstFinite(
              stats?.priceChange24hPercent,
              primaryMarket?.priceChange24hPercent,
              canonical?.priceChange24hPercent,
          )
        : firstFinite(
              canonical?.priceChange24hPercent,
              primaryMarket?.priceChange24hPercent,
              stats?.priceChange24hPercent,
          );
    const change1h = firstFinite(primaryMarket?.priceChange1hPercent, stats?.priceChange1hPercent);
    const volume24h = firstPositive(
        stats?.volume24hUSD,
        sumPositive(rawVariants.map(variant => variant.market?.volume24hUSD)),
    );

    return {
        assetId,
        ...(primary?.mint ? { mint: primary.mint } : {}),
        symbol,
        name,
        sectorId: sectorOf.get(assetId) ?? OTHER_SECTOR.id,
        ...(logoURI ? { logoURI } : {}),
        price: roundPrice(price),
        change24h: round(change24h, 2),
        change1h: round(change1h, 2),
        marketCap: round(marketCap, 0),
        marketCapSource: underlyingCap !== null ? 'underlying' : 'onchain',
        volume24h: round(volume24h, 0),
        variantCount: rawVariants.length,
        variants: rawVariants.length > 1 ? rawVariants.map(variant => buildVariant(assetId, variant)) : [],
    };
}

/**
 * Raw curated response → slim sector › asset › variant tree. Sectors are the
 * home page's categories, in its order; an asset on several lists goes to the
 * first. Pure; safe to cache and serialize.
 */
export function buildHeatmapData(
    response: RawCuratedResponse,
    membership: readonly HeatmapSectorMembership[],
    generatedAt: number,
): HeatmapData {
    const sectorOf = new Map<string, string>();
    for (const list of membership) {
        for (const assetId of list.assetIds) {
            if (!sectorOf.has(assetId)) sectorOf.set(assetId, list.id);
        }
    }

    const bySector = new Map<string, HeatmapAsset[]>();
    const seen = new Set<string>();
    let variantCount = 0;

    for (const raw of response.assets ?? []) {
        const asset = buildAsset(raw, sectorOf);
        if (!asset || seen.has(asset.assetId)) continue;
        seen.add(asset.assetId);
        variantCount += asset.variantCount;

        const bucket = bySector.get(asset.sectorId);
        if (bucket) bucket.push(asset);
        else bySector.set(asset.sectorId, [asset]);
    }

    const sectors: HeatmapSector[] = [];
    for (const sector of [...membership, OTHER_SECTOR]) {
        const assets = bySector.get(sector.id);
        if (assets && assets.length > 0) sectors.push({ id: sector.id, label: sector.label, assets });
    }

    return { sectors, assetCount: seen.size, variantCount, generatedAt };
}
