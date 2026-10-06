import { describe, expect, test } from 'bun:test';

import { sectorPreview } from './preview';
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

describe('sectorPreview', () => {
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

    test('returns one category, populated assets only, without variant lists', () => {
        const sector = sectorPreview(full, 'majors')!;

        expect(sector.label).toBe('Crypto');
        expect(sector.assets.map(a => a.assetId)).toEqual(['bitcoin', 'zcash']);
        expect(sector.assets.every(a => a.variants.length === 0)).toBe(true);
    });

    test('keeps the highest-volume assets when limited, trimmed to what a thumbnail draws', () => {
        const sector = sectorPreview(
            {
                ...full,
                sectors: [
                    {
                        id: 'stocks',
                        label: 'Stocks',
                        assets: [
                            { ...asset('small', 1), volume24h: 10 },
                            { ...asset('big', -1), volume24h: 1000 },
                            { ...asset('mid', 0.5), volume24h: 100 },
                        ],
                    },
                ],
            },
            'stocks',
            2,
        )!;

        expect(sector.assets.map(a => [a.assetId, a.volume24h, a.change24h])).toEqual([
            ['big', 1000, -1],
            ['mid', 100, 0.5],
        ]);
        expect(sector.assets[0]).toMatchObject({ name: '', price: null, variants: [] });
    });

    test('is null for an unknown or empty category', () => {
        expect(sectorPreview(full, 'stocks')).toBeNull();
    });
});
