import { describe, expect, test } from 'bun:test';

import { isPopulated, populatedOnly } from './populated';
import type { HeatmapAsset, HeatmapData, HeatmapVariant } from './types';

function variant(id: string, volume24h: number | null, change24h: number | null): HeatmapVariant {
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
        change24h,
        change1h: null,
        marketCap: null,
        volume24h,
        liquidity: null,
    };
}

function asset(
    assetId: string,
    volume24h: number | null,
    change24h: number | null,
    variants: HeatmapVariant[] = [],
): HeatmapAsset {
    return {
        assetId,
        symbol: assetId,
        name: assetId,
        sectorId: 'stocks',
        price: 1,
        change24h,
        change1h: null,
        marketCap: null,
        marketCapSource: 'underlying',
        volume24h,
        variantCount: Math.max(1, variants.length),
        variants,
    };
}

function data(sectors: Array<[string, HeatmapAsset[]]>): HeatmapData {
    return {
        sectors: sectors.map(([id, assets]) => ({ id, label: id, assets })),
        assetCount: sectors.reduce((sum, [, assets]) => sum + assets.length, 0),
        variantCount: 0,
        generatedAt: 0,
    };
}

describe('isPopulated', () => {
    test('needs both 24h volume and a 24h change', () => {
        expect(isPopulated({ volume24h: 10, change24h: 0 })).toBe(true);
        expect(isPopulated({ volume24h: 10, change24h: null })).toBe(false);
        expect(isPopulated({ volume24h: 0, change24h: 1.2 })).toBe(false);
        expect(isPopulated({ volume24h: null, change24h: 1.2 })).toBe(false);
    });
});

describe('populatedOnly', () => {
    test('drops dead assets, and categories left empty', () => {
        const result = populatedOnly(
            data([
                ['stocks', [asset('nvidia', 100, 0.2), asset('idle', 0, null), asset('stale', 50, null)]],
                ['rwas', [asset('tbll', 0, null)]],
            ]),
        );

        expect(result.sectors.map(sector => [sector.id, sector.assets.map(a => a.assetId)])).toEqual([
            ['stocks', ['nvidia']],
        ]);
        expect(result.assetCount).toBe(1);
    });

    test('keeps only populated variants, and drops the drill-down when fewer than two remain', () => {
        const result = populatedOnly(
            data([
                [
                    'majors',
                    [
                        asset('bitcoin', 100, 0.1, [
                            variant('cbBTC', 90, 0.1),
                            variant('wBTC', 10, -0.2),
                            variant('dust', 0, 0),
                        ]),
                        asset('nvidia', 100, 0.2, [variant('NVDAx', 100, 0.2), variant('NVDAon', 0, null)]),
                    ],
                ],
            ]),
        );
        const [bitcoin, nvidia] = result.sectors[0]!.assets;

        expect(bitcoin!.variants.map(v => v.id)).toEqual(['cbBTC', 'wBTC']);
        expect(nvidia!.variants).toEqual([]);
        expect(result.variantCount).toBe(3);
    });

    test('leaves fully populated data untouched', () => {
        const live = asset('bitcoin', 100, 0.1, [variant('a', 1, 0), variant('b', 2, 0)]);
        const result = populatedOnly(data([['majors', [live]]]));

        expect(result.sectors[0]!.assets[0]).toBe(live);
    });
});
