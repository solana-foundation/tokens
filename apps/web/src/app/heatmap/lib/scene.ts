import { cameraMove, planCamera, type CameraPlan, type HeatmapView } from './camera';
import type { HeatmapLayout } from './treemap';

/** Room between the map and the stage's clipping edge, so an edge tile's hover ring is drawn whole. */
export const STAGE_PADDING = 4;
/** Sector and asset views fill the viewport below the page header; the overview is as tall as its rows. */
export const STAGE_MIN_HEIGHT = 440;
export const STAGE_VIEWPORT_INSET = 280;
/** Fixed site header plus breathing room, when scrolling a view into place. */
export const SCROLL_OFFSET = 96;

export const ZOOM_MS = 460;
export const FADE_MS = 180;

export interface StageSize {
    width: number;
    height: number;
}

/** A rendered view: its layout, and the key its DOM layer is kept under across transitions. */
export interface LayerSpec {
    key: string;
    view: HeatmapView;
    layout: HeatmapLayout;
}

/**
 * What the stage shows. At rest, one layer. Zooming, two: the outer view and the inner view drawn
 * at an anchor inside it, with the camera heading for `target` (0 = outer at rest, 1 = inner at
 * rest). Fading, the next view fades in over the previous one.
 */
export type Scene =
    | { kind: 'rest'; stageKey: string; id: number; layer: LayerSpec }
    | {
          kind: 'zoom';
          stageKey: string;
          id: number;
          outer: LayerSpec;
          inner: LayerSpec;
          plan: CameraPlan;
          /** The outer view's tile being zoomed into or out of, if the anchor is a tile. */
          anchorKey: string | null;
          /** Container height while the zoom runs: tall enough for both views and the box. */
          height: number;
          /** Page scroll to set when the zoom starts (zoom-out onto a row) or ends (zoom-in from one). */
          scrollTo: number | null;
          target: 0 | 1;
          /** Camera position to start from; null continues from wherever an interrupted zoom was. */
          startP: number | null;
      }
    | { kind: 'fade'; stageKey: string; id: number; under: LayerSpec; over: LayerSpec };

export interface ScrollContext {
    /** Page offset of the stage's top edge. */
    stageTop: number;
    scrollY: number;
}

export function destinationOf(scene: Scene): LayerSpec {
    if (scene.kind === 'rest') return scene.layer;
    if (scene.kind === 'fade') return scene.over;
    return scene.target === 1 ? scene.inner : scene.outer;
}

/** A view's height in the stage: the overview is as tall as its rows; the rest fill the viewport. */
export function layerHeight(layer: LayerSpec, stage: StageSize): number {
    return layer.layout.level === 'overview' ? layer.layout.height : stage.height;
}

export function nextScene(
    scene: Scene,
    to: LayerSpec,
    stage: StageSize,
    stageKey: string,
    animate: boolean,
    page: ScrollContext,
): Scene {
    const id = scene.id + 1;
    if (!animate) return { kind: 'rest', stageKey, id, layer: to };

    // Going back to where an in-flight zoom came from: turn the camera around instead of cutting.
    if (scene.kind === 'zoom') {
        const origin = scene.target === 1 ? scene.outer : scene.inner;
        if (origin.key === to.key) return { ...scene, target: scene.target === 1 ? 0 : 1, startP: null };
    }

    const from = destinationOf(scene);
    const move = cameraMove(from.layout, from.view, to.layout, to.view);
    if (move.mode === 'fade') return { kind: 'fade', stageKey, id, under: from, over: to };

    const outer = move.mode === 'in' ? from : to;
    const inner = move.mode === 'in' ? to : from;
    // The inner view rests in the part of the stage that is on screen. On the tall overview that
    // is wherever the page is scrolled to: zooming in, it is the viewport as it stands (the page
    // then jumps to put the finished view at the top, which looks the same); zooming out, the page
    // first jumps so the destination row sits at the top, and the view starts from there.
    const onOverview = outer.layout.level === 'overview';
    const scrollTo = onOverview
        ? move.mode === 'in'
            ? page.stageTop - SCROLL_OFFSET
            : page.stageTop + move.anchor.y - SCROLL_OFFSET
        : null;
    const stagedScroll = onOverview && move.mode === 'out' && scrollTo !== null ? scrollTo : page.scrollY;
    const boxY = onOverview ? Math.max(0, stagedScroll + SCROLL_OFFSET - page.stageTop) : 0;
    const box = { x: 0, y: boxY, w: stage.width, h: stage.height };
    const plan = planCamera(move.anchor, box);
    const anchorKey = move.anchorKey ?? null;
    const height = Math.max(layerHeight(outer, stage), layerHeight(inner, stage), box.y + box.h);

    return move.mode === 'in'
        ? { kind: 'zoom', stageKey, id, outer, inner, plan, anchorKey, height, scrollTo, target: 1, startP: 0 }
        : { kind: 'zoom', stageKey, id, outer, inner, plan, anchorKey, height, scrollTo, target: 0, startP: 1 };
}

/**
 * Drive `onFrame` with an eased 0→1 over `duration` ms, then `onDone`. Returns a cancel function;
 * the caller's effect cleanup must call it so no frame runs after unmount.
 */
export function runTween(
    duration: number,
    ease: (t: number) => number,
    onFrame: (eased: number) => void,
    onDone: () => void,
): () => void {
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        onFrame(ease(t));
        if (t < 1) frame = requestAnimationFrame(step);
        else onDone();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
}
