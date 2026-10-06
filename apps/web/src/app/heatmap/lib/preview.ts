import { populatedOnly } from './populated';
import type { HeatmapAsset, HeatmapData, HeatmapSector } from './types';

export interface HeatmapMiniResponse {
    /** Categories that currently have populated assets, in home-page order. */
    sectors: Array<{ id: string; label: string }>;
    /** The requested category, or a fallback when it has nothing to show. */
    sector: HeatmapSector;
}

const FALLBACK_SECTOR = 'stocks';

/**
 * Data for the mini map in the floating market feed: the category's `limit` highest-volume populated
 * assets, with what a tile and its hover card show and nothing else (no variant lists).
 */
export function miniPreview(full: HeatmapData, sectorId: string, limit = Infinity): HeatmapMiniResponse | null {
    const { sectors } = populatedOnly(full);
    const sector =
        sectors.find(candidate => candidate.id === sectorId) ??
        sectors.find(candidate => candidate.id === FALLBACK_SECTOR) ??
        sectors[0];
    if (!sector) return null;

    const assets = [...sector.assets]
        .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
        .slice(0, limit)
        .map((asset): HeatmapAsset => ({ ...asset, variantCount: 0, variants: [] }));

    return {
        sectors: sectors.map(({ id, label }) => ({ id, label })),
        sector: { ...sector, assets },
    };
}
