import { describe, expect, test } from 'bun:test';

import {
    layoutAsset,
    layoutOverview,
    layoutSector,
    OVERVIEW_BALANCE,
    TILE_EXPONENT,
    type HeatmapLayout,
    type Rect,
} from './treemap';
import type { HeatmapAsset, HeatmapData, HeatmapSector, HeatmapVariant } from './types';

const WIDTH = 1200;
const HEIGHT = 700;

function variant(mint: string, volume24h: number | null, group = 'wrapped'): HeatmapVariant {
    return {
        id: mint,
        mint,
        hasTokenPage: true,
        symbol: mint,
        name: mint,
        groupId: group,
        groupLabel: group,
        groupOrder: group === 'native' ? 10 : 50,
        price: 1,
        change24h: 0,
        change1h: 0,
        marketCap: null,
        volume24h,
        liquidity: null,
    };
}

function asset(
    assetId: string,
    sectorId: string,
    volume24h: number | null,
    variants: HeatmapVariant[] = [],
): HeatmapAsset {
    return {
        assetId,
        symbol: assetId,
        name: assetId,
        sectorId,
        price: 1,
        change24h: 0,
        change1h: 0,
        marketCap: null,
        marketCapSource: 'underlying',
        volume24h,
        variantCount: Math.max(1, variants.length),
        variants,
    };
}

function sector(id: string, volumes: Array<number | null>): HeatmapSector {
    return { id, label: id, assets: volumes.map((volume, index) => asset(`${id}-${index}`, id, volume)) };
}

function data(sectors: HeatmapSector[]): HeatmapData {
    return {
        sectors,
        assetCount: sectors.reduce((sum, s) => sum + s.assets.length, 0),
        variantCount: 0,
        generatedAt: 0,
    };
}

function area(rect: Rect): number {
    return rect.w * rect.h;
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function expectTiled(layout: HeatmapLayout) {
    const tiles = layout.groups.flatMap(group => group.tiles.map(tile => ({ group, rect: tile.rect })));
    for (const { group, rect } of tiles) {
        expect(rect.w).toBeGreaterThan(0);
        expect(rect.h).toBeGreaterThan(0);
        // Inside its group, below the group's header.
        expect(rect.x).toBeGreaterThanOrEqual(group.rect.x);
        expect(rect.y).toBeGreaterThanOrEqual(group.rect.y + group.headerHeight);
        expect(rect.x + rect.w).toBeLessThanOrEqual(group.rect.x + group.rect.w);
        expect(rect.y + rect.h).toBeLessThanOrEqual(group.rect.y + group.rect.h);
    }
    for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
            expect(overlaps(tiles[i]!.rect, tiles[j]!.rect)).toBe(false);
        }
    }
    for (const group of layout.groups) {
        expect(group.rect.x).toBeGreaterThanOrEqual(0);
        expect(group.rect.y).toBeGreaterThanOrEqual(0);
        expect(group.rect.x + group.rect.w).toBeLessThanOrEqual(layout.width);
        expect(group.rect.y + group.rect.h).toBeLessThanOrEqual(layout.height);
    }
}

describe('layoutOverview', () => {
    const skewed = data([
        sector('majors', [5000, 4000, 3000, 2000, 1000, 500, 250]),
        sector('stocks', [300, 100, 50]),
        sector('metals', [0.002, 0.001]),
    ]);

    test('tiles the stage without overlap', () => {
        const layout = layoutOverview(skewed, WIDTH, HEIGHT);

        expect(layout.level).toBe('overview');
        expect(layout.groups).toHaveLength(3);
        expectTiled(layout);
    });

    test('compresses sector shares and holds every sector above the floor', () => {
        const layout = layoutOverview(skewed, WIDTH, HEIGHT);
        const share = (id: string) => area(layout.groups.find(group => group.id === id)!.rect) / (WIDTH * HEIGHT);

        // Raw totals would give the first category 97%; compression leaves room for the rest.
        expect(share('majors')).toBeLessThan(0.8);
        expect(share('stocks')).toBeGreaterThan(0.15);
        // Gaps between groups cost a little area, hence the tolerance.
        expect(share('metals')).toBeGreaterThan(OVERVIEW_BALANCE.floor * 0.8);
    });

    test('sizes tiles by compressed volume: order kept, ratios follow the tile exponent', () => {
        const layout = layoutOverview(data([sector('majors', [4000, 2000, 1000])]), WIDTH, HEIGHT);
        const [big, mid, small] = layout.groups[0]!.tiles.map(tile => area(tile.rect));

        // Each tile doubles the next one's volume, so areas differ by 2 ** TILE_EXPONENT.
        expect(big! / mid!).toBeCloseTo(2 ** TILE_EXPONENT, 1);
        expect(mid! / small!).toBeCloseTo(2 ** TILE_EXPONENT, 1);
        // The tile reports the real volume, not the compressed weight.
        expect(layout.groups[0]!.tiles.map(tile => tile.value)).toEqual([4000, 2000, 1000]);
        expect(layout.groups[0]!.total).toBe(7000);
    });

    test('merges tiles too small to draw, and unsizeable ones, into a "+N more" tile', () => {
        const volumes = [1e12, 5e11, ...Array.from({ length: 40 }, () => 1), null, 0];
        const layout = layoutOverview(data([sector('stocks', volumes)]), WIDTH, HEIGHT);
        const tiles = layout.groups[0]!.tiles;
        const more = tiles.find(tile => tile.kind === 'more');

        expect(tiles.filter(tile => tile.kind === 'asset')).toHaveLength(2);
        expect(more).toMatchObject({ kind: 'more', count: 42, groupId: 'stocks' });
        // Big enough to click even though the merged value is negligible.
        expect(Math.min(more!.rect.w, more!.rect.h)).toBeGreaterThanOrEqual(20);
        expectTiled(layout);
    });

    test('falls back to equal tiles when nothing in the category traded', () => {
        const layout = layoutOverview(data([sector('rwa', [null, null, null, null])]), WIDTH, HEIGHT);
        const areas = layout.groups[0]!.tiles.map(tile => area(tile.rect));

        expect(areas).toHaveLength(4);
        expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.1);
    });

    test('returns no groups for an empty stage or empty data', () => {
        expect(layoutOverview(skewed, 0, HEIGHT).groups).toEqual([]);
        expect(layoutOverview(data([]), WIDTH, HEIGHT).groups).toEqual([]);
    });
});

describe('layoutSector', () => {
    test('draws every asset, enlarging the smallest instead of merging them', () => {
        const volumes = [1e12, 5e11, ...Array.from({ length: 60 }, () => 1), null];
        const layout = layoutSector(sector('stocks', volumes), WIDTH, HEIGHT);
        const tiles = layout.groups[0]!.tiles;

        expect(layout.level).toBe('sector');
        expect(tiles).toHaveLength(volumes.length);
        expect(tiles.every(tile => tile.kind === 'asset')).toBe(true);
        expect(layout.groups[0]!.headerHeight).toBe(0);
        expect(Math.min(...tiles.map(tile => area(tile.rect)))).toBeGreaterThan(400);
        // The enlarged tail may not crowd out the leaders.
        expect(area(tiles[0]!.rect)).toBeGreaterThan(area(tiles[1]!.rect) * 1.3);
        expectTiled(layout);
    });
});

describe('layoutAsset', () => {
    test('a group holding most of the variants gets room for them, whatever its volume', () => {
        // Solana: wSOL out-trades all 60 LSTs together by ~40×.
        const lsts = Array.from({ length: 60 }, (_, index) => variant(`lst${index}`, 1_000_000 / (index + 1), 'yield'));
        const solana = asset('solana', 'majors', 3_400_000_000, [variant('wSOL', 3_400_000_000, 'native'), ...lsts]);
        const groups = layoutAsset(solana, WIDTH, HEIGHT).groups;
        const share = (id: string) => area(groups.find(group => group.id === id)!.rect) / (WIDTH * HEIGHT);

        expect(share('yield')).toBeGreaterThan(0.45);
        expect(share('native')).toBeGreaterThan(0.4);
    });

    test('a dominant variant leaves the minor ones real tiles, not slivers', () => {
        // SK Hynix on 2026-10-06: SKHY $2.6M, SKHYon $99, SKHYx $9.
        const hynix = asset('sk-hynix', 'stocks', 2_644_943, [
            variant('SKHY', 2_644_943, 'stocks'),
            variant('SKHYon', 99, 'stocks'),
            variant('SKHYx', 9, 'stocks'),
        ]);
        const tiles = layoutAsset(hynix, WIDTH, HEIGHT).groups[0]!.tiles;
        const share = (key: string) => area(tiles.find(tile => tile.key === key)!.rect) / (WIDTH * HEIGHT);

        expect(share('variant:SKHY')).toBeGreaterThan(0.5);
        for (const key of ['variant:SKHYon', 'variant:SKHYx']) {
            expect(share(key)).toBeGreaterThan(0.08);
            const rect = tiles.find(tile => tile.key === key)!.rect;
            expect(Math.min(rect.w, rect.h)).toBeGreaterThan(150);
        }
    });

    test('groups variants by display category and keeps tiny variants readable', () => {
        const bitcoin = asset('bitcoin', 'crypto', 1_700_000_000_000, [
            variant('cbBTC', 250_000_000),
            variant('zBTC', 4_000_000),
            variant('dust', 4_000),
            variant('wBTC', 210_000_000, 'bridged'),
            variant('native', null, 'native'),
        ]);
        const layout = layoutAsset(bitcoin, WIDTH, HEIGHT);

        expect(layout.level).toBe('asset');
        // Display order: native before wrapped/bridged, whatever their size.
        expect(layout.groups.map(group => group.id).sort()).toEqual(['bridged', 'native', 'wrapped']);
        const tiles = layout.groups.flatMap(group => group.tiles);
        expect(tiles.map(tile => tile.key).sort()).toEqual(
            ['variant:cbBTC', 'variant:dust', 'variant:native', 'variant:wBTC', 'variant:zBTC'].sort(),
        );
        expect(Math.min(...tiles.map(tile => Math.min(tile.rect.w, tile.rect.h)))).toBeGreaterThanOrEqual(24);
        expectTiled(layout);
    });
});
