import { populatedOnly } from './populated';
import type { HeatmapAsset, HeatmapData, HeatmapSector } from './types';

/**
 * One category for the mini map in the floating market feed: its `limit` highest-volume populated
 * assets, trimmed to what a thumbnail tile draws (symbol, 24h change, 24h volume). The thumbnail is a
 * single link into the full map, so names, logos, prices and variants stay behind.
 */
export function sectorPreview(full: HeatmapData, sectorId: string, limit = Infinity): HeatmapSector | null {
    const sector = populatedOnly(full).sectors.find(candidate => candidate.id === sectorId);
    if (!sector) return null;

    const assets = [...sector.assets]
        .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
        .slice(0, limit)
        .map((asset): HeatmapAsset => ({
            assetId: asset.assetId,
            symbol: asset.symbol,
            name: '',
            sectorId: asset.sectorId,
            price: null,
            change24h: asset.change24h,
            change1h: null,
            marketCap: null,
            marketCapSource: asset.marketCapSource,
            volume24h: asset.volume24h,
            variantCount: 0,
            variants: [],
        }));
    return { ...sector, assets };
}
