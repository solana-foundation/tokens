import { describe, expect, test } from 'bun:test';

import { anchorFor, cameraMove, expandFrom, squeezeInto, viewKey, type HeatmapView } from './camera';
import type { HeatmapLayout, LayoutTile, Rect } from './treemap';
import type { HeatmapAsset } from './types';

const STAGE = { width: 1000, height: 600 };

function assetTile(assetId: string, rect: Rect): LayoutTile {
    return { kind: 'asset', key: `asset:${assetId}`, rect, value: 1, asset: { assetId } as HeatmapAsset };
}

function layout(
    level: HeatmapLayout['level'],
    groups: Array<{ id: string; rect: Rect; tiles: LayoutTile[] }>,
): HeatmapLayout {
    return {
        level,
        ...STAGE,
        groups: groups.map(group => ({
            ...group,
            label: group.id,
            headerHeight: 0,
            total: 1,
            itemCount: group.tiles.length,
        })),
    };
}

const BITCOIN: Rect = { x: 600, y: 24, w: 300, h: 400 };
const CRYPTO: Rect = { x: 600, y: 0, w: 400, h: 600 };
const overview = layout('overview', [
    {
        id: 'equity',
        rect: { x: 0, y: 0, w: 592, h: 600 },
        tiles: [assetTile('nvidia', { x: 0, y: 24, w: 300, h: 300 })],
    },
    { id: 'crypto', rect: CRYPTO, tiles: [assetTile('bitcoin', BITCOIN)] },
]);
const cryptoSector = layout('sector', [
    {
        id: 'crypto',
        rect: { x: 0, y: 0, w: 1000, h: 600 },
        tiles: [assetTile('bitcoin', { x: 0, y: 0, w: 700, h: 600 })],
    },
]);
// A variant category can share an id with a sector; it must never be mistaken for one.
const bitcoinAsset = layout('asset', [{ id: 'crypto', rect: { x: 0, y: 0, w: 500, h: 600 }, tiles: [] }]);

const OVERVIEW: HeatmapView = { level: 'overview' };
const SECTOR: HeatmapView = { level: 'sector', sectorId: 'crypto' };
const ASSET: HeatmapView = { level: 'asset', assetId: 'bitcoin' };

describe('viewKey', () => {
    test('is distinct per view', () => {
        expect([OVERVIEW, SECTOR, ASSET].map(viewKey)).toEqual(['overview', 'sector:crypto', 'asset:bitcoin']);
    });
});

describe('anchorFor', () => {
    test('finds a sector as a group of the overview only', () => {
        expect(anchorFor(overview, SECTOR)).toEqual(CRYPTO);
        expect(anchorFor(cryptoSector, SECTOR)).toBeNull();
        expect(anchorFor(bitcoinAsset, SECTOR)).toBeNull();
    });

    test('finds an asset as a tile of the overview or its sector', () => {
        expect(anchorFor(overview, ASSET)).toEqual(BITCOIN);
        expect(anchorFor(cryptoSector, ASSET)).toEqual({ x: 0, y: 0, w: 700, h: 600 });
        expect(anchorFor(overview, { level: 'asset', assetId: 'merged-away' })).toBeNull();
    });
});

describe('cameraMove', () => {
    test('zooms in on the tile being entered', () => {
        expect(cameraMove(overview, OVERVIEW, bitcoinAsset, ASSET)).toEqual({ mode: 'in', anchor: BITCOIN });
        expect(cameraMove(overview, OVERVIEW, cryptoSector, SECTOR)).toEqual({ mode: 'in', anchor: CRYPTO });
    });

    test('zooms out to the tile being left', () => {
        expect(cameraMove(bitcoinAsset, ASSET, overview, OVERVIEW)).toEqual({ mode: 'out', anchor: BITCOIN });
        expect(cameraMove(bitcoinAsset, ASSET, cryptoSector, SECTOR)).toEqual({
            mode: 'out',
            anchor: { x: 0, y: 0, w: 700, h: 600 },
        });
    });

    test('fades when neither view is drawn inside the other', () => {
        const other: HeatmapView = { level: 'asset', assetId: 'merged-away' };
        expect(cameraMove(overview, OVERVIEW, bitcoinAsset, other)).toEqual({ mode: 'fade' });
    });
});

describe('layer transforms', () => {
    function apply(point: { x: number; y: number }, t: ReturnType<typeof squeezeInto>) {
        return { x: t.x + point.x * t.scaleX, y: t.y + point.y * t.scaleY };
    }

    test('squeezeInto maps the stage corners onto the anchor', () => {
        const t = squeezeInto(BITCOIN, STAGE.width, STAGE.height);

        expect(apply({ x: 0, y: 0 }, t)).toEqual({ x: 600, y: 24 });
        expect(apply({ x: 1000, y: 600 }, t)).toEqual({ x: 900, y: 424 });
    });

    test('expandFrom maps the anchor corners onto the stage', () => {
        const t = expandFrom(BITCOIN, STAGE.width, STAGE.height);

        expect(apply({ x: 600, y: 24 }, t).x).toBeCloseTo(0);
        expect(apply({ x: 600, y: 24 }, t).y).toBeCloseTo(0);
        expect(apply({ x: 900, y: 424 }, t).x).toBeCloseTo(1000);
        expect(apply({ x: 900, y: 424 }, t).y).toBeCloseTo(600);
    });

    test('expandFrom caps the scale for tiny anchors but keeps them centred', () => {
        const tiny: Rect = { x: 100, y: 100, w: 10, h: 10 };
        const t = expandFrom(tiny, STAGE.width, STAGE.height);

        expect(t.scaleX).toBe(8);
        expect(t.scaleY).toBe(8);
        expect(apply({ x: 105, y: 105 }, t)).toEqual({ x: 500, y: 300 });
    });
});
