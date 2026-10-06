import { describe, expect, test } from 'bun:test';

import { miniPreview } from './preview';
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

describe('miniPreview', () => {
    const full: HeatmapData = {
        sectors: [
            {
                id: 'majors',
                label: 'Crypto',
                assets: [asset('bitcoin', 0.1, [variant('a'), variant('b')]), asset('zcash', 2), asset('buidl', null)],
            },
            {
                id: 'stocks',
                label: 'Stocks',
                assets: [
                    { ...asset('small', 1), volume24h: 10 },
                    { ...asset('big', -1), volume24h: 1000 },
                    { ...asset('mid', 0.5), volume24h: 100 },
                ],
            },
            { id: 'rwas', label: 'Treasuries', assets: [asset('buidl', null)] },
        ],
        assetCount: 7,
        variantCount: 2,
        generatedAt: 0,
    };

    test('lists only categories with populated assets', () => {
        expect(miniPreview(full, 'majors')!.sectors).toEqual([
            { id: 'majors', label: 'Crypto' },
            { id: 'stocks', label: 'Stocks' },
        ]);
    });

    test('returns the category without dead assets or variant lists, keeping hover-card fields', () => {
        const { sector } = miniPreview(full, 'majors')!;

        expect(sector.label).toBe('Crypto');
        expect(sector.assets.map(a => a.assetId)).toEqual(['bitcoin', 'zcash']);
        expect(sector.assets.every(a => a.variants.length === 0)).toBe(true);
        expect(sector.assets[0]).toMatchObject({ name: 'bitcoin', price: 1 });
    });

    test('keeps the highest-volume assets when limited', () => {
        expect(miniPreview(full, 'stocks', 2)!.sector.assets.map(a => a.assetId)).toEqual(['big', 'mid']);
    });

    test('falls back to Stocks when the category is unknown or empty', () => {
        expect(miniPreview(full, 'rwas')!.sector.id).toBe('stocks');
        expect(miniPreview(full, 'nope')!.sector.id).toBe('stocks');
    });
});
