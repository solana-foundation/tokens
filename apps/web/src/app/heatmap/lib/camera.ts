import type { HeatmapLayout, Rect } from './treemap';

export type HeatmapView =
    { level: 'overview' } | { level: 'sector'; sectorId: string } | { level: 'asset'; assetId: string };

export function viewKey(view: HeatmapView): string {
    if (view.level === 'sector') return `sector:${view.sectorId}`;
    if (view.level === 'asset') return `asset:${view.assetId}`;
    return 'overview';
}

/**
 * How one view hands over to the next. Each view is laid out for the full
 * stage, so a zoom is two whole layers moving at once: `in` grows the outgoing
 * layer until `anchor` (the tile being entered) fills the stage while the
 * incoming layer unfolds from that same rect; `out` is the reverse.
 */
export type CameraMove = { mode: 'fade' } | { mode: 'in' | 'out'; anchor: Rect };

export interface LayerTransform {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
}

/** Past this the outgoing layer is long faded out; capping keeps the composited surface small. */
const MAX_SCALE = 8;
const MIN_ANCHOR_SIDE = 4;

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

/** Transform (origin top-left) that fits a full-stage layer into `anchor`. */
export function squeezeInto(anchor: Rect, width: number, height: number): LayerTransform {
    return { x: anchor.x, y: anchor.y, scaleX: anchor.w / width, scaleY: anchor.h / height };
}

/** Transform (origin top-left) that grows a layer until `anchor` covers the stage. */
export function expandFrom(anchor: Rect, width: number, height: number): LayerTransform {
    const scaleX = Math.min(width / anchor.w, MAX_SCALE);
    const scaleY = Math.min(height / anchor.h, MAX_SCALE);
    // Keep the anchor's centre on the stage centre even when the scale is capped.
    return {
        x: width / 2 - (anchor.x + anchor.w / 2) * scaleX,
        y: height / 2 - (anchor.y + anchor.h / 2) * scaleY,
        scaleX,
        scaleY,
    };
}
