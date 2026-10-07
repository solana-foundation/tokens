import type { LayoutTile } from './treemap';

/** What a tile has room to say. Below `symbol` it is colour only and relies on the tooltip. */
export type TileDetail = 'full' | 'change' | 'symbol' | 'none';

/** Requested logo size; the tile scales it to 20–44 px. Shared with the preloader so URLs match. */
export const LOGO_SOURCE_SIZE = 40;

export function detailFor(width: number, height: number): TileDetail {
    if (width >= 104 && height >= 78) return 'full';
    if (width >= 56 && height >= 36) return 'change';
    if (width >= 28 && height >= 15) return 'symbol';
    return 'none';
}

export interface TileFace {
    symbol: string;
    logoURI?: string;
    variantCount: number;
}

export function faceFor(tile: Exclude<LayoutTile, { kind: 'more' }>): TileFace {
    if (tile.kind === 'variant') return { symbol: tile.variant.symbol, logoURI: tile.variant.logoURI, variantCount: 0 };
    return { symbol: tile.asset.symbol, logoURI: tile.asset.logoURI, variantCount: tile.asset.variants.length };
}
