import { describe, expect, test } from 'bun:test';

import {
    anchorFor,
    cameraFrame,
    cameraMove,
    planCamera,
    viewKey,
    type HeatmapView,
    type LayerTransform,
} from './camera';
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

describe('camera', () => {
    function apply(point: { x: number; y: number }, t: LayerTransform) {
        return { x: t.x + point.x * t.scale, y: t.y + point.y * t.scale };
    }
    const plan = planCamera(BITCOIN, STAGE.width, STAGE.height);

    test('fits a stage-shaped viewport, centred, inside the anchor', () => {
        // BITCOIN is 300×400 in a 1000×600 stage: width binds, fit = 0.3.
        expect(plan.fit).toBeCloseTo(0.3);
        expect(plan.viewport).toEqual({ x: 600, y: 134, w: 300, h: 180 });
    });

    test('p = 0 is the outer view at rest, with the inner view parked in the viewport', () => {
        const frame = cameraFrame(plan, 0);

        expect(frame.outer).toEqual({ x: -0, y: -0, scale: 1 });
        expect(frame.inner.scale).toBeCloseTo(0.3);
        expect(frame.inner.x).toBeCloseTo(600);
        expect(frame.inner.y).toBeCloseTo(134);
        expect(frame.innerOpacity).toBe(0);
    });

    test('p = 1 is the inner view at rest, with the viewport blown up to the stage', () => {
        const frame = cameraFrame(plan, 1);

        expect(frame.inner.scale).toBeCloseTo(1);
        expect(frame.inner.x).toBeCloseTo(0);
        expect(frame.inner.y).toBeCloseTo(0);
        expect(frame.innerOpacity).toBe(1);
        expect(apply({ x: 600, y: 134 }, frame.outer).x).toBeCloseTo(0);
        expect(apply({ x: 900, y: 314 }, frame.outer).y).toBeCloseTo(600);
    });

    test('zooms about a fixed point, with both layers moving as one', () => {
        const focus = { x: plan.focusX, y: plan.focusY };
        for (const p of [0.1, 0.35, 0.5, 0.8]) {
            const frame = cameraFrame(plan, p);
            const still = apply(focus, frame.outer);
            expect(still.x).toBeCloseTo(focus.x);
            expect(still.y).toBeCloseTo(focus.y);
            // The inner layer's origin is wherever the outer layer currently draws the viewport.
            const viewportOrigin = apply({ x: plan.viewport.x, y: plan.viewport.y }, frame.outer);
            expect(frame.inner.x).toBeCloseTo(viewportOrigin.x);
            expect(frame.inner.y).toBeCloseTo(viewportOrigin.y);
            expect(frame.inner.scale).toBeCloseTo(frame.outer.scale * plan.fit);
        }
    });

    test('scale changes geometrically and opacity only ever rises', () => {
        const scales = [0, 0.25, 0.5, 0.75, 1].map(p => cameraFrame(plan, p).outer.scale);
        for (let i = 1; i < scales.length; i++) {
            expect(scales[i]! / scales[i - 1]!).toBeCloseTo(scales[1]! / scales[0]!);
        }
        let previous = -1;
        for (let p = 0; p <= 1; p += 0.05) {
            const opacity = cameraFrame(plan, p).innerOpacity;
            expect(opacity).toBeGreaterThanOrEqual(previous);
            previous = opacity;
        }
    });

    test('clamps the zoom for tiny anchors', () => {
        expect(planCamera({ x: 10, y: 10, w: 5, h: 5 }, STAGE.width, STAGE.height).fit).toBeCloseTo(1 / 64);
    });
});
