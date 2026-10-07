import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { isPopulated, populatedOnly } from './populated';
import type { HeatmapAsset, HeatmapData, HeatmapSector } from './types';

export interface HeatmapMiniResponse {
    /** Categories the mini map cycles through, in order. */
    sectors: Array<{ id: string; label: string }>;
    /** The requested category, or a fallback when it is not offered or has nothing to show. */
    sector: HeatmapSector;
}

/** What the feed's mini map cycles through. `trending` is not a heat map category; see trendingSector. */
export const MINI_SECTORS = ['stocks', 'majors', 'trending'] as const;
export const TRENDING_SECTOR_ID = 'trending';
const FALLBACK_SECTOR = 'stocks';

/** Row order on the heat map page; categories not listed follow in their own order. */
export const PAGE_ROW_ORDER: readonly string[] = [TRENDING_SECTOR_ID, 'majors', 'stocks', 'etfs'];

/**
 * The heat map page's rows: the categories in PAGE_ROW_ORDER (Trending included when available),
 * then any others as they came.
 */
export function pageSectors(data: HeatmapData, trending: HeatmapSector | null): HeatmapData {
    const pool = trending && trending.assets.length > 0 ? [...data.sectors, trending] : data.sectors;
    const byId = new Map(pool.map(sector => [sector.id, sector]));
    const ordered: HeatmapSector[] = [];
    const placed = new Set<string>();
    for (const id of PAGE_ROW_ORDER) {
        const sector = byId.get(id);
        if (sector) {
            ordered.push(sector);
            placed.add(id);
        }
    }
    for (const sector of pool) if (!placed.has(sector.id)) ordered.push(sector);
    return { ...data, sectors: ordered };
}

/** Subset of a `GET /api/v1/assets/trending` row that a tile and its hover card use. */
export interface RawTrendingAsset {
    assetId: string;
    mint?: string | null;
    symbol?: string | null;
    name?: string | null;
    imageUrl?: string | null;
    market?: {
        price?: number | null;
        priceChange24hPercent?: number | null;
        priceChange1hPercent?: number | null;
        volume24hUSD?: number | null;
    } | null;
}

function finite(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The trending list as a heat map category: same tiles (sized by 24h volume, coloured by 24h change),
 * one per asset, carrying the trending token's mint so the tile links to that token's asset page, as
 * the home page's Trending tab does. An asset trending through several of its tokens keeps its
 * best-ranked one.
 */
export function trendingSector(rows: readonly RawTrendingAsset[]): HeatmapSector {
    const seen = new Set<string>();
    const assets: HeatmapAsset[] = [];
    for (const row of rows) {
        const assetId = row.assetId?.trim();
        if (!assetId || seen.has(assetId)) continue;
        seen.add(assetId);
        const symbol = (row.symbol ?? '').trim() || '—';
        const logoURI = normalizeLogoSrc((row.imageUrl ?? '').trim() || undefined);
        const mint = (row.mint ?? '').trim();
        const asset: HeatmapAsset = {
            assetId,
            ...(mint ? { mint } : {}),
            symbol,
            name: (row.name ?? '').trim() || symbol,
            sectorId: TRENDING_SECTOR_ID,
            ...(logoURI ? { logoURI } : {}),
            price: finite(row.market?.price),
            change24h: finite(row.market?.priceChange24hPercent),
            change1h: finite(row.market?.priceChange1hPercent),
            marketCap: null,
            marketCapSource: 'onchain',
            volume24h: finite(row.market?.volume24hUSD),
            variantCount: 0,
            variants: [],
        };
        if (isPopulated(asset)) assets.push(asset);
    }
    return { id: TRENDING_SECTOR_ID, label: 'Trending', assets };
}

interface MiniPreviewOptions {
    /** Keep each category's highest-volume assets only. */
    limit?: number;
    /** Categories offered, in cycle order. */
    order?: readonly string[];
    /** Categories that do not come from the heat map data (trending). */
    extraSectors?: readonly HeatmapSector[];
}

/**
 * Data for the mini map in the floating market feed: the offered categories that have something to
 * show, and the requested one with what a tile and its hover card need (no variant lists).
 */
export function miniPreview(
    full: HeatmapData,
    sectorId: string,
    { limit = Infinity, order = MINI_SECTORS, extraSectors = [] }: MiniPreviewOptions = {},
): HeatmapMiniResponse | null {
    const { sectors: populated } = populatedOnly(full);
    const available = order
        .map(id => extraSectors.find(sector => sector.id === id) ?? populated.find(sector => sector.id === id))
        .filter((sector): sector is HeatmapSector => Boolean(sector && sector.assets.length > 0));
    const sector =
        available.find(candidate => candidate.id === sectorId) ??
        available.find(candidate => candidate.id === FALLBACK_SECTOR) ??
        available[0];
    if (!sector) return null;

    const assets = [...sector.assets]
        .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
        .slice(0, limit)
        .map((asset): HeatmapAsset => ({ ...asset, variantCount: 0, variants: [] }));

    return {
        sectors: available.map(({ id, label }) => ({ id, label })),
        sector: { ...sector, assets },
    };
}
