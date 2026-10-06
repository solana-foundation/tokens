import type { HeatmapAsset, HeatmapData, HeatmapVariant } from './types';

/**
 * Populated: traded on Solana in the last 24h and has a 24h price change, so its tile has a size
 * and a colour. Everything else (unlisted-hours stock tokens, idle treasuries, dust variants)
 * would draw as a gray "No data / No volume" tile.
 */
export function isPopulated(item: Pick<HeatmapAsset | HeatmapVariant, 'volume24h' | 'change24h'>): boolean {
    return (item.volume24h ?? 0) > 0 && item.change24h !== null;
}

/**
 * The map without dead tiles. Assets keep only their populated variants, and drill down only while
 * at least two remain; with one or none their tile links straight to the asset page.
 */
export function populatedOnly(data: HeatmapData): HeatmapData {
    let assetCount = 0;
    let variantCount = 0;
    const sectors = data.sectors
        .map(sector => {
            const assets: HeatmapAsset[] = [];
            for (const asset of sector.assets) {
                if (!isPopulated(asset)) continue;
                const variants = asset.variants.filter(isPopulated);
                assets.push(
                    variants.length === asset.variants.length
                        ? asset
                        : { ...asset, variants: variants.length > 1 ? variants : [] },
                );
                assetCount += 1;
                variantCount += variants.length;
            }
            return { ...sector, assets };
        })
        .filter(sector => sector.assets.length > 0);

    return { ...data, sectors, assetCount, variantCount };
}
