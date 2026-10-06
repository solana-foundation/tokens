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
    test('needs a 24h price change; volume does not matter', () => {
        expect(isPopulated({ change24h: 0 })).toBe(true);
        expect(isPopulated({ change24h: -1.2 })).toBe(true);
        expect(isPopulated({ change24h: null })).toBe(false);
    });
});

describe('populatedOnly', () => {
    test('drops dead assets, and categories left empty', () => {
        const result = populatedOnly(
            data([
                ['stocks', [asset('nvidia', 100, 0.2), asset('quiet', 0, 0.1), asset('unquoted', 50, null)]],
                ['rwas', [asset('buidl', 0, null)]],
            ]),
        );

        expect(result.sectors.map(sector => [sector.id, sector.assets.map(a => a.assetId)])).toEqual([
            ['stocks', ['nvidia', 'quiet']],
        ]);
        expect(result.assetCount).toBe(2);
    });

    test('keeps only populated variants, and drops the drill-down when fewer than two remain', () => {
        const result = populatedOnly(
            data([
                [
                    'majors',
                    [
                        asset('bitcoin', 100, 0.1, [
                            variant('cbBTC', 90, 0.1),
                            variant('21BTC', 0, 0),
                            variant('zenBTC', 0, null),
                        ]),
                        asset('nvidia', 100, 0.2, [variant('NVDAx', 100, 0.2), variant('NVDAon', 0, null)]),
                    ],
                ],
            ]),
        );
        const [bitcoin, nvidia] = result.sectors[0]!.assets;

        // A quiet variant with a price change stays; one with no change data goes.
        expect(bitcoin!.variants.map(v => v.id)).toEqual(['cbBTC', '21BTC']);
        expect(nvidia!.variants).toEqual([]);
        expect(result.variantCount).toBe(3);
    });

    test('leaves fully populated data untouched', () => {
        const live = asset('bitcoin', 100, 0.1, [variant('a', 1, 0), variant('b', 2, 0)]);
        const result = populatedOnly(data([['majors', [live]]]));

        expect(result.sectors[0]!.assets[0]).toBe(live);
    });
});
