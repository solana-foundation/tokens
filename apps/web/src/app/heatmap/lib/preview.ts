import { buildCoinHref } from '@/lib/coin-href';
import { populatedOnly } from './populated';
import type { HeatmapData } from './types';

export interface HeatmapPreviewData {
    data: HeatmapData;
    /** Where each asset tile goes: into /heatmap for assets with variants, else the asset page. */
    hrefs: Record<string, string>;
}

/**
 * The home-page preview draws only the overview, so it ships assets without their variant lists
 * (~26 KB gzipped instead of ~51 KB); each tile carries its link instead of a drill-down.
 */
export function toPreviewData(full: HeatmapData): HeatmapPreviewData {
    const populated = populatedOnly(full);
    const hrefs: Record<string, string> = {};
    const sectors = populated.sectors.map(sector => ({
        ...sector,
        assets: sector.assets.map(asset => {
            hrefs[asset.assetId] =
                asset.variants.length > 1
                    ? `/heatmap?asset=${encodeURIComponent(asset.assetId)}`
                    : buildCoinHref(asset.assetId, undefined);
            return { ...asset, variants: [] };
        }),
    }));
    return { data: { ...populated, sectors, variantCount: 0 }, hrefs };
}
