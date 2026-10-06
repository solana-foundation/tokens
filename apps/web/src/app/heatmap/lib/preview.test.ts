import { describe, expect, test } from 'bun:test';

import { toPreviewData } from './preview';
import type { HeatmapAsset, HeatmapData, HeatmapVariant } from './types';

function variant(id: string): HeatmapVariant {
    return {
        id,
        mint: id,
        hasTokenPage: true,
        symbol: id,
        name: id,
        groupId: 'wrapped',
        groupLabel: 'Wrapped',
        groupOrder: 50,
        price: 1,
        change24h: 0.1,
        change1h: null,
        marketCap: null,
        volume24h: 1,
        liquidity: null,
    };
}

function asset(assetId: string, change24h: number | null, variants: HeatmapVariant[] = []): HeatmapAsset {
    return {
        assetId,
        symbol: assetId,
        name: assetId,
        sectorId: 'majors',
        price: 1,
        change24h,
        change1h: null,
        marketCap: null,
        marketCapSource: 'underlying',
        volume24h: 1,
        variantCount: variants.length,
        variants,
    };
}

describe('toPreviewData', () => {
    const full: HeatmapData = {
        sectors: [
            {
                id: 'majors',
                label: 'Crypto',
                assets: [asset('bitcoin', 0.1, [variant('a'), variant('b')]), asset('zcash', 2), asset('buidl', null)],
            },
        ],
        assetCount: 3,
        variantCount: 2,
        generatedAt: 0,
    };

    test('drops dead assets and every variant list', () => {
        const { data } = toPreviewData(full);

        expect(data.sectors[0]!.assets.map(a => a.assetId)).toEqual(['bitcoin', 'zcash']);
        expect(data.sectors[0]!.assets.every(a => a.variants.length === 0)).toBe(true);
    });

    test('links assets with variants into the heat map and the rest to their asset page', () => {
        expect(toPreviewData(full).hrefs).toEqual({ bitcoin: '/heatmap?asset=bitcoin', zcash: '/zcash' });
    });
});
