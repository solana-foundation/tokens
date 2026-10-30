'use client';

import { useCallback, useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';

import { cameraFrame, easeOutCubic, transformCss } from '../lib/camera';
import { destinationOf, FADE_MS, runTween, ZOOM_MS, type Scene } from '../lib/scene';

function clearLayerStyle(element: HTMLElement | undefined): void {
    if (!element) return;
    element.style.transform = '';
    element.style.opacity = '';
    element.style.willChange = '';
}

/**
 * Runs the scene's camera move: one style write per layer per frame, with no React work while it
 * runs. Returns the ref callback that registers each layer's element, and a ref to the current
 * scene for code that must not re-run on scene changes.
 */
export function useCameraMotion(
    scene: Scene | null,
    setScene: Dispatch<SetStateAction<Scene | null>>,
    stageRef: RefObject<HTMLDivElement | null>,
) {
    const layerElements = useRef(new Map<string, HTMLDivElement>());
    const layerRef = useCallback(
        (key: string) => (element: HTMLDivElement | null) => {
            if (element) layerElements.current.set(key, element);
            else layerElements.current.delete(key);
        },
        [],
    );
    const progress = useRef(0);
    const sceneRef = useRef(scene);
    useLayoutEffect(() => {
        sceneRef.current = scene;
    });

    const motionKey =
        scene && scene.kind !== 'rest' ? `${scene.id}:${scene.kind === 'zoom' ? scene.target : 'fade'}` : null;
    useLayoutEffect(() => {
        const active = sceneRef.current;
        if (!active || active.kind === 'rest') return;
        const elements = layerElements.current;
        const stageElement = stageRef.current;
        const destination = destinationOf(active);

        let anchorTile: HTMLElement | null = null;
        const settle = () => {
            // Only the layer that stays is reset; the other keeps its final frame until React removes it,
            // so it never flashes back at full size for a frame.
            const staying = elements.get(destination.key);
            clearLayerStyle(staying);
            // Focus inside the layer about to be removed would be dropped: park it on the stage. Done
            // here rather than at the click, where focus() would force a layout of the new tiles.
            const focused = document.activeElement;
            if (
                stageElement &&
                focused instanceof HTMLElement &&
                stageElement.contains(focused) &&
                !staying?.contains(focused)
            ) {
                stageElement.focus({ preventScroll: true });
            }
            anchorTile?.removeAttribute('data-camera-anchor');
            anchorTile?.style.removeProperty('--camera-label-opacity');
            if (active.kind === 'zoom' && active.target === 0 && document.activeElement === stageElement) {
                anchorTile?.focus({ preventScroll: true });
            }
            const rest = () =>
                setScene(latest =>
                    latest &&
                    latest.kind !== 'rest' &&
                    latest.id === active.id &&
                    destinationOf(latest).key === destination.key
                        ? { kind: 'rest', stageKey: latest.stageKey, id: latest.id, layer: destination }
                        : latest,
                );
            if (active.kind === 'zoom' && active.target === 1 && active.scrollTo !== null) {
                // The view finished in the visible part of a tall stage; collapse the stage to the view
                // and move the page so nothing on screen changes. Both in one paint.
                flushSync(rest);
                window.scrollTo({ top: Math.max(0, active.scrollTo), behavior: 'auto' });
            } else {
                rest();
            }
        };

        if (active.kind === 'fade') {
            const under = elements.get(active.under.key);
            const over = elements.get(active.over.key);
            clearLayerStyle(under);
            if (!over) {
                settle();
                return;
            }
            over.style.willChange = 'opacity';
            over.style.opacity = '0';
            return runTween(FADE_MS, easeOutCubic, eased => (over.style.opacity = String(eased)), settle);
        }

        const outer = elements.get(active.outer.key);
        const inner = elements.get(active.inner.key);
        if (!outer || !inner) {
            settle();
            return;
        }
        anchorTile = active.anchorKey
            ? outer.querySelector<HTMLElement>(`[data-tile="${CSS.escape(active.anchorKey)}"]`)
            : null;
        anchorTile?.setAttribute('data-camera-anchor', '');

        const from = active.startP ?? progress.current;
        const to = active.target;
        const duration = ZOOM_MS * Math.abs(to - from);
        if (to === 0 && active.scrollTo !== null && active.startP !== null) {
            // Zooming out onto a row: the stage is already tall; put the row's page position where
            // the view is, before the first frame, so the view appears to shrink into it in place.
            window.scrollTo({ top: Math.max(0, active.scrollTo), behavior: 'auto' });
        }
        outer.style.willChange = 'transform';
        inner.style.willChange = 'transform, opacity';
        outer.style.opacity = '';
        const apply = (p: number) => {
            progress.current = p;
            const camera = cameraFrame(active.plan, p, to === 1);
            outer.style.transform = transformCss(camera.outer);
            inner.style.transform = transformCss(camera.inner);
            inner.style.opacity = String(camera.innerOpacity);
            anchorTile?.style.setProperty('--camera-label-opacity', String(1 - camera.innerOpacity));
        };
        // Starting position is written before the browser paints the newly mounted layer.
        apply(from);
        if (duration <= 0) {
            settle();
            return;
        }
        const cancel = runTween(duration, easeOutCubic, eased => apply(from + (to - from) * eased), settle);
        return () => {
            cancel();
            anchorTile?.removeAttribute('data-camera-anchor');
            anchorTile?.style.removeProperty('--camera-label-opacity');
        };
    }, [motionKey, setScene, stageRef]);

    return { layerRef, sceneRef };
}
