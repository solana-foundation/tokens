import type { HeatmapLayout, Rect } from './treemap';

export type HeatmapView =
    { level: 'overview' } | { level: 'sector'; sectorId: string } | { level: 'asset'; assetId: string };

export function viewKey(view: HeatmapView): string {
    if (view.level === 'sector') return `sector:${view.sectorId}`;
    if (view.level === 'asset') return `asset:${view.assetId}`;
    return 'overview';
}

/**
 * How one view hands over to the next. `in`: the next view is drawn inside the
 * previous one at `anchor`; `out`: the previous view is drawn inside the next
 * one at `anchor`; `fade`: neither contains the other.
 */
export type CameraMove = { mode: 'fade' } | { mode: 'in' | 'out'; anchor: Rect };

export interface LayerTransform {
    x: number;
    y: number;
    /** Uniform: text keeps its proportions while it flies. */
    scale: number;
}

const MIN_ANCHOR_SIDE = 4;
/** Below this the outer layer would be magnified past any visible benefit (and its bitmap past ~64×). */
const MIN_FIT = 1 / 64;

/** Where `target` is drawn inside `layout`, if that layout shows it as a tile or group. */
export function anchorFor(layout: HeatmapLayout, target: HeatmapView): Rect | null {
    if (target.level === 'sector' && layout.level === 'overview') {
        return layout.groups.find(group => group.id === target.sectorId)?.rect ?? null;
    }

    if (target.level === 'asset' && layout.level !== 'asset') {
        const key = `asset:${target.assetId}`;
        for (const group of layout.groups) {
            const tile = group.tiles.find(candidate => candidate.key === key);
            if (tile) return tile.rect;
        }
    }

    return null;
}

function usable(anchor: Rect | null): anchor is Rect {
    return anchor !== null && anchor.w >= MIN_ANCHOR_SIDE && anchor.h >= MIN_ANCHOR_SIDE;
}

export function cameraMove(
    previousLayout: HeatmapLayout,
    previousView: HeatmapView,
    nextLayout: HeatmapLayout,
    nextView: HeatmapView,
): CameraMove {
    const entering = anchorFor(previousLayout, nextView);
    if (usable(entering)) return { mode: 'in', anchor: entering };

    const leaving = anchorFor(nextLayout, previousView);
    if (usable(leaving)) return { mode: 'out', anchor: leaving };

    return { mode: 'fade' };
}

/**
 * The geometry of one zoom between an outer view and the inner view drawn at
 * `anchor` inside it. The inner view keeps the stage's aspect ratio, so it
 * occupies `viewport`: the largest stage-shaped rect centred in the anchor.
 */
export interface CameraPlan {
    stageWidth: number;
    stageHeight: number;
    viewport: Rect;
    /** viewport size / stage size; the inner view's scale when the camera is all the way out. */
    fit: number;
    /** The outer-view point that stays put on screen while the camera zooms. */
    focusX: number;
    focusY: number;
}

export function planCamera(anchor: Rect, stageWidth: number, stageHeight: number): CameraPlan {
    const fit = Math.max(MIN_FIT, Math.min(anchor.w / stageWidth, anchor.h / stageHeight, 1));
    const viewport = {
        x: anchor.x + (anchor.w - stageWidth * fit) / 2,
        y: anchor.y + (anchor.h - stageHeight * fit) / 2,
        w: stageWidth * fit,
        h: stageHeight * fit,
    };
    // Zooming from the whole stage onto the viewport is a similarity transform; its fixed point
    // is the one place on screen that never moves, which is what makes the zoom read as a camera.
    const shrink = 1 - fit;
    return {
        stageWidth,
        stageHeight,
        viewport,
        fit,
        focusX: shrink > 1e-3 ? viewport.x / shrink : stageWidth / 2,
        focusY: shrink > 1e-3 ? viewport.y / shrink : stageHeight / 2,
    };
}

export interface CameraFrame {
    outer: LayerTransform;
    inner: LayerTransform;
    innerOpacity: number;
}

/**
 * Inner view opacity over the zoom, as a function of camera position. Zooming in it is solid within
 * the first few frames. Zooming out the camera lingers near the outer view (that is the slow end of
 * the ease), so the thumbnail fades later and over a shorter span, keeping the overlap brief.
 */
const FADE_IN: readonly [number, number] = [0, 0.3];
const FADE_OUT: readonly [number, number] = [0.1, 0.32];

function smoothstep(edge0: number, edge1: number, value: number): number {
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * Camera at progress `p`: 0 shows the outer view at rest, 1 the inner view at
 * rest. Scale changes geometrically, so equal steps of `p` feel like equal
 * steps of zoom. Both layers use transform-origin 0 0.
 */
export function cameraFrame(plan: CameraPlan, p: number, zoomingIn = true): CameraFrame {
    const { fit, viewport, focusX, focusY } = plan;
    const ratio = fit ** p;
    const scale = 1 / ratio;
    // Camera rect in outer coordinates: the stage shrunk towards the fixed point.
    const cameraX = focusX * (1 - ratio);
    const cameraY = focusY * (1 - ratio);

    return {
        outer: { x: -cameraX * scale, y: -cameraY * scale, scale },
        inner: { x: (viewport.x - cameraX) * scale, y: (viewport.y - cameraY) * scale, scale: scale * fit },
        innerOpacity: smoothstep(...(zoomingIn ? FADE_IN : FADE_OUT), p),
    };
}

export function transformCss({ x, y, scale }: LayerTransform): string {
    return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

/** Fast out, gentle landing: the view starts moving on the first frame after the click. */
export function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
}
