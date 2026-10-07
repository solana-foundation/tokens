'use client';

import {
    memo,
    startTransition,
    useCallback,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type PointerEvent,
} from 'react';
import { useReducedMotion } from 'motion/react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';

import { buildCoinHref } from '@/lib/coin-href';
import {
    cameraFrame,
    cameraMove,
    easeOutCubic,
    planCamera,
    transformCss,
    viewKey,
    type CameraPlan,
    type HeatmapView,
} from '../lib/camera';
import { populatedOnly } from '../lib/populated';
import { layoutAsset, layoutOverview, layoutSector, type HeatmapLayout, type LayoutTile } from '../lib/treemap';
import {
    HEATMAP_PERIODS,
    type HeatmapAsset,
    type HeatmapData,
    type HeatmapPeriod,
    type HeatmapSector,
} from '../lib/types';
import { GroupHeader } from './heatmap-group-header';
import { HeatmapTile, preloadTileLogos } from './heatmap-tile';
import { HeatmapToolbar, type HeatmapCrumb } from './heatmap-toolbar';
import { HeatmapTooltip, type HeatmapTooltipHandle } from './heatmap-tooltip';

interface StageSize {
    width: number;
    height: number;
}

/** A rendered view: its layout, and the key its DOM layer is kept under across transitions. */
interface LayerSpec {
    key: string;
    view: HeatmapView;
    layout: HeatmapLayout;
}

/**
 * What the stage shows. At rest, one layer. Zooming, two: the outer view and
 * the inner view drawn at an anchor inside it, with the camera heading for
 * `target` (0 = outer at rest, 1 = inner at rest). Fading, the next view
 * fades in over the previous one.
 */
type Scene =
    | { kind: 'rest'; stageKey: string; id: number; layer: LayerSpec }
    | {
          kind: 'zoom';
          stageKey: string;
          id: number;
          outer: LayerSpec;
          inner: LayerSpec;
          plan: CameraPlan;
          target: 0 | 1;
          /** Camera position to start from; null continues from wherever an interrupted zoom was. */
          startP: number | null;
      }
    | { kind: 'fade'; stageKey: string; id: number; under: LayerSpec; over: LayerSpec };

/**
 * Room between the map and the stage's clipping edge, so the hover/focus ring (2px plus a 1px
 * offset) of a tile on the edge is drawn whole instead of cut off.
 */
const STAGE_PADDING = 4;

const ZOOM_MS = 460;
const FADE_MS = 180;

/** Views with more tiles than this mount their largest tiles first and the rest in batches. */
const FIRST_BATCH = 48;
const NEXT_BATCH = 48;

function destinationOf(scene: Scene): LayerSpec {
    if (scene.kind === 'rest') return scene.layer;
    if (scene.kind === 'fade') return scene.over;
    return scene.target === 1 ? scene.inner : scene.outer;
}

function nextScene(scene: Scene, to: LayerSpec, stage: StageSize, stageKey: string, animate: boolean): Scene {
    const id = scene.id + 1;
    if (!animate) return { kind: 'rest', stageKey, id, layer: to };

    // Going back to where an in-flight zoom came from: turn the camera around instead of cutting.
    if (scene.kind === 'zoom') {
        const origin = scene.target === 1 ? scene.outer : scene.inner;
        if (origin.key === to.key) return { ...scene, target: scene.target === 1 ? 0 : 1, startP: null };
    }

    const from = destinationOf(scene);
    const move = cameraMove(from.layout, from.view, to.layout, to.view);
    if (move.mode === 'in') {
        const plan = planCamera(move.anchor, stage.width, stage.height);
        return { kind: 'zoom', stageKey, id, outer: from, inner: to, plan, target: 1, startP: 0 };
    }
    if (move.mode === 'out') {
        const plan = planCamera(move.anchor, stage.width, stage.height);
        return { kind: 'zoom', stageKey, id, outer: to, inner: from, plan, target: 0, startP: 1 };
    }
    return { kind: 'fade', stageKey, id, under: from, over: to };
}

/** The tile in the outer view that the inner view grows out of, when it is a tile rather than a group. */
function anchorTileKey(inner: LayerSpec): string | null {
    return inner.view.level === 'asset' ? `asset:${inner.view.assetId}` : null;
}

function clearLayerStyle(element: HTMLElement | undefined): void {
    if (!element) return;
    element.style.transform = '';
    element.style.opacity = '';
    element.style.willChange = '';
}

interface HeatmapLayerProps {
    layout: HeatmapLayout;
    period: HeatmapPeriod;
    onOpenAsset: (assetId: string) => void;
    onOpenSector: (sectorId: string) => void;
}

/** Tile keys, largest on screen first. */
function tilesBySize(layout: HeatmapLayout): string[] {
    return layout.groups
        .flatMap(group => group.tiles)
        .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
        .map(tile => tile.key);
}

const HeatmapLayer = memo(function HeatmapLayer({ layout, period, onOpenAsset, onOpenSector }: HeatmapLayerProps) {
    // A big view (all ~400 stocks) mounts its largest tiles in the click's frame and the rest in
    // interruptible batches while the camera is still moving, instead of one long blocking task.
    const ranking = useMemo(() => tilesBySize(layout), [layout]);
    const [mounted, setMounted] = useState(() => Math.min(ranking.length, FIRST_BATCH));
    const total = ranking.length;
    useEffect(() => {
        if (mounted >= total) return;
        startTransition(() => setMounted(count => Math.min(total, count + NEXT_BATCH)));
    }, [mounted, total]);
    const visible = useMemo(
        () => (mounted >= total ? null : new Set(ranking.slice(0, mounted))),
        [mounted, total, ranking],
    );

    return (
        <>
            {layout.groups.map(group => (
                <div key={group.id}>
                    {group.headerHeight > 0 ? (
                        <GroupHeader
                            group={group}
                            onOpenSector={layout.level === 'overview' ? onOpenSector : undefined}
                        />
                    ) : null}
                    {group.tiles.map(tile =>
                        visible && !visible.has(tile.key) ? null : (
                            <HeatmapTile
                                key={tile.key}
                                tile={tile}
                                period={period}
                                onOpenAsset={onOpenAsset}
                                onOpenSector={onOpenSector}
                            />
                        ),
                    )}
                </div>
            ))}
        </>
    );
});

function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * URL IS THE STORE for the heat map, so every zoom level is linkable and the
 * browser's back button steps out:
 *   sector — home-page category (curated list slug) filling the stage
 *   asset  — canonical asset whose variants fill the stage (wins over sector)
 *   period — which price change colours the tiles
 *   showEmpty — internal only: also draw assets with no 24h price change
 */
export function Heatmap({ data: allData }: { data: HeatmapData }) {
    const [query, setQuery] = useQueryStates(
        {
            sector: parseAsString,
            asset: parseAsString,
            showEmpty: parseAsBoolean.withDefault(false),
            period: parseAsStringEnum<HeatmapPeriod>([...HEATMAP_PERIODS]).withDefault('24h'),
        },
        { history: 'push', scroll: false },
    );
    const { period } = query;
    // Assets with no 24h price change are hidden; `?showEmpty=true` brings them back
    // for internal checks. Deliberately not in the UI.
    const data = useMemo(() => (query.showEmpty ? allData : populatedOnly(allData)), [allData, query.showEmpty]);

    const index = useMemo(() => {
        const sectors = new Map<string, HeatmapSector>();
        const assets = new Map<string, HeatmapAsset>();
        for (const sector of data.sectors) {
            sectors.set(sector.id, sector);
            for (const asset of sector.assets) assets.set(asset.assetId, asset);
        }
        return { sectors, assets };
    }, [data]);

    // Only assets with several variants have a level of their own; anything else falls back a level.
    const candidateAsset = query.asset ? index.assets.get(query.asset) : undefined;
    const viewAsset = candidateAsset && candidateAsset.variants.length > 1 ? candidateAsset : undefined;
    const viewSector = !viewAsset && query.sector ? index.sectors.get(query.sector) : undefined;
    const viewAssetId = viewAsset?.assetId;
    const viewSectorId = viewSector?.id;
    const view = useMemo<HeatmapView>(() => {
        if (viewAssetId) return { level: 'asset', assetId: viewAssetId };
        if (viewSectorId) return { level: 'sector', sectorId: viewSectorId };
        return { level: 'overview' };
    }, [viewAssetId, viewSectorId]);

    const stageRef = useRef<HTMLDivElement>(null);
    const [stage, setStage] = useState<StageSize | null>(null);
    useLayoutEffect(() => {
        const element = stageRef.current;
        if (!element) return;

        const measure = () => {
            const width = Math.floor(element.clientWidth) - STAGE_PADDING * 2;
            const height = Math.floor(element.clientHeight) - STAGE_PADDING * 2;
            setStage(current => (current?.width === width && current.height === height ? current : { width, height }));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Layouts are pure functions of (view, stage size): compute each once, so hovering a tile can
    // prepare the view it opens and the click only has to mount it.
    // A new data prop starts a new cache.
    const layoutCache = useMemo(() => ({ data, layouts: new Map<string, HeatmapLayout>() }), [data]).layouts;
    const getLayout = useCallback(
        (target: HeatmapView, size: StageSize): HeatmapLayout => {
            const cacheKey = `${viewKey(target)}@${size.width}x${size.height}`;
            const cached = layoutCache.get(cacheKey);
            if (cached) return cached;

            let computed: HeatmapLayout | null = null;
            if (target.level === 'asset') {
                const asset = index.assets.get(target.assetId);
                if (asset) computed = layoutAsset(asset, size.width, size.height);
            } else if (target.level === 'sector') {
                const sector = index.sectors.get(target.sectorId);
                if (sector) computed = layoutSector(sector, size.width, size.height);
            }
            const result = computed ?? layoutOverview(data, size.width, size.height);
            layoutCache.set(cacheKey, result);
            return result;
        },
        [data, index, layoutCache],
    );

    const layout = useMemo(() => (stage ? getLayout(view, stage) : null), [getLayout, view, stage]);
    const layerKey = viewKey(view);
    const stageKey = stage ? `${stage.width}x${stage.height}` : '';
    const reduceMotion = useReducedMotion();

    // Scene: derived from the view during render (React's "adjust state on prop change" pattern),
    // so the new layer and its starting camera position commit together, before the first paint.
    const [scene, setScene] = useState<Scene | null>(null);
    if (layout && stage) {
        const current: LayerSpec = { key: layerKey, view, layout };
        if (!scene || scene.stageKey !== stageKey) {
            // First measure, or the stage resized: every layout changed, so cut rather than zoom.
            setScene({ kind: 'rest', stageKey, id: (scene?.id ?? 0) + 1, layer: current });
        } else if (destinationOf(scene).key !== layerKey) {
            setScene(nextScene(scene, current, stage, stageKey, !reduceMotion));
        }
    }

    // Camera: drives the two layers' transforms directly, one style write per layer per frame,
    // with no React work while it runs.
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
        let frame = 0;
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
            setScene(latest =>
                latest &&
                latest.kind !== 'rest' &&
                latest.id === active.id &&
                destinationOf(latest).key === destination.key
                    ? { kind: 'rest', stageKey: latest.stageKey, id: latest.id, layer: destination }
                    : latest,
            );
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
            const start = performance.now();
            const step = (now: number) => {
                const t = Math.min(1, (now - start) / FADE_MS);
                over.style.opacity = String(easeOutCubic(t));
                if (t < 1) frame = requestAnimationFrame(step);
                else settle();
            };
            frame = requestAnimationFrame(step);
            return () => cancelAnimationFrame(frame);
        }

        const outer = elements.get(active.outer.key);
        const inner = elements.get(active.inner.key);
        if (!outer || !inner) {
            settle();
            return;
        }
        const tileKey = anchorTileKey(active.inner);
        anchorTile = tileKey ? outer.querySelector<HTMLElement>(`[data-tile="${CSS.escape(tileKey)}"]`) : null;
        anchorTile?.setAttribute('data-camera-anchor', '');

        const from = active.startP ?? progress.current;
        const to = active.target;
        const duration = ZOOM_MS * Math.abs(to - from);
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
        const start = performance.now();
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / duration);
            apply(from + (to - from) * easeOutCubic(t));
            if (t < 1) frame = requestAnimationFrame(step);
            else settle();
        };
        frame = requestAnimationFrame(step);
        return () => {
            cancelAnimationFrame(frame);
            anchorTile?.removeAttribute('data-camera-anchor');
            anchorTile?.style.removeProperty('--camera-label-opacity');
        };
    }, [motionKey]);

    const setPeriod = useCallback(
        (next: HeatmapPeriod) => void setQuery({ period: next }, { history: 'replace' }),
        [setQuery],
    );
    const openAsset = useCallback((assetId: string) => void setQuery({ asset: assetId }), [setQuery]);
    const openSector = useCallback((sectorId: string) => void setQuery({ sector: sectorId, asset: null }), [setQuery]);
    const openOverview = useCallback(() => void setQuery({ sector: null, asset: null }), [setQuery]);
    const level = view.level;
    const stepOut = useCallback(() => {
        // Leaving an asset lands on the sector it was opened from, if any.
        if (level === 'asset') void setQuery({ asset: null });
        else if (level === 'sector') void setQuery({ sector: null });
    }, [level, setQuery]);

    useEffect(() => {
        if (level === 'overview') return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return;
            stepOut();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [level, stepOut]);

    // Tooltip: delegated from the stage so tiles carry no handlers of their own.
    const tooltipRef = useRef<HeatmapTooltipHandle>(null);
    const tilesByKey = useMemo(() => {
        const tiles = new Map<string, LayoutTile>();
        for (const group of layout?.groups ?? []) for (const tile of group.tiles) tiles.set(tile.key, tile);
        return tiles;
    }, [layout]);

    // Hovering (or focusing, or pressing) something that opens a view prepares that view: its
    // layout is computed and cached for the click, and its logos start loading.
    const prepared = useRef<string | null>(null);
    const prepare = useCallback(
        (target: EventTarget | null) => {
            if (!stage || !(target instanceof Element)) return;
            let next: HeatmapView | null = null;
            const tileKey = target.closest('[data-tile]')?.getAttribute('data-tile');
            const tile = tileKey ? tilesByKey.get(tileKey) : undefined;
            if (tile?.kind === 'asset' && tile.asset.variants.length > 1)
                next = { level: 'asset', assetId: tile.asset.assetId };
            else if (tile?.kind === 'more') next = { level: 'sector', sectorId: tile.groupId };
            else {
                const sectorId = target.closest('[data-sector-header]')?.getAttribute('data-sector-header');
                if (sectorId) next = { level: 'sector', sectorId };
            }
            if (!next) return;
            const nextKey = viewKey(next);
            if (nextKey === prepared.current || nextKey === layerKey) return;
            prepared.current = nextKey;
            preloadTileLogos(getLayout(next, stage));
        },
        [stage, tilesByKey, getLayout, layerKey],
    );
    const tileAt = useCallback(
        (target: EventTarget | null): { tile: LayoutTile; element: Element } | null => {
            const element = target instanceof Element ? target.closest('[data-tile]') : null;
            const tile = element ? tilesByKey.get(element.getAttribute('data-tile') ?? '') : undefined;
            return element && tile ? { tile, element } : null;
        },
        [tilesByKey],
    );
    const onPointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            prepare(event.target);
            if (event.pointerType === 'touch') return;
            const hit = tileAt(event.target);
            if (hit) tooltipRef.current?.show(hit.tile, event.clientX, event.clientY);
            else tooltipRef.current?.hide();
        },
        [tileAt, prepare],
    );
    const onFocus = useCallback(
        (event: FocusEvent<HTMLDivElement>) => {
            prepare(event.target);
            const hit = tileAt(event.target);
            if (!hit || !hit.element.matches(':focus-visible')) return;
            const box = hit.element.getBoundingClientRect();
            tooltipRef.current?.show(hit.tile, box.left + Math.min(box.width, 28), box.bottom - 10);
        },
        [tileAt, prepare],
    );
    const hideTooltip = useCallback(() => tooltipRef.current?.hide(), []);
    // A tooltip for a tile of the previous layer would point at nothing.
    useEffect(() => {
        tooltipRef.current?.hide();
    }, [layerKey]);

    const crumbs = useMemo<HeatmapCrumb[]>(() => {
        const sector = viewAsset ? index.sectors.get(viewAsset.sectorId) : viewSector;
        const all: HeatmapCrumb = { key: 'all', label: 'All assets', ...(sector ? { onSelect: openOverview } : {}) };
        if (!sector) return [all];

        const sectorCrumb: HeatmapCrumb = {
            key: `sector:${sector.id}`,
            label: sector.label,
            ...(viewAsset ? { onSelect: () => openSector(sector.id) } : {}),
        };
        if (!viewAsset) return [all, sectorCrumb];

        return [
            all,
            sectorCrumb,
            { key: `asset:${viewAsset.assetId}`, label: `${viewAsset.name} (${viewAsset.symbol})` },
        ];
    }, [index, viewAsset, viewSector, openOverview, openSector]);

    // Recolouring every tile can trail the toggle by a frame; the toggle itself must not.
    const tilePeriod = useDeferredValue(period);
    const destination = scene ? destinationOf(scene) : null;
    const layers: Array<{ spec: LayerSpec; z: number }> = !scene
        ? []
        : scene.kind === 'rest'
          ? [{ spec: scene.layer, z: 1 }]
          : scene.kind === 'zoom'
            ? [
                  { spec: scene.outer, z: 1 },
                  { spec: scene.inner, z: 2 },
              ]
            : [
                  { spec: scene.under, z: 1 },
                  { spec: scene.over, z: 2 },
              ];
    const isEmpty = destination !== null && destination.layout.groups.length === 0;

    return (
        <div>
            <HeatmapToolbar
                crumbs={crumbs}
                assetHref={viewAsset ? buildCoinHref(viewAsset.assetId, viewAsset.mint) : undefined}
                period={period}
                onPeriodChange={setPeriod}
            />

            <div
                ref={stageRef}
                // Focus lands here while a zoom retires the layer that held it.
                tabIndex={-1}
                className={`relative h-[max(440px,calc(100dvh-280px))] w-full overflow-hidden rounded-lg outline-none ${scene ? '' : 'animate-pulse bg-gray-50'}`}
                onPointerMove={onPointerMove}
                onPointerDown={event => prepare(event.target)}
                onPointerLeave={hideTooltip}
                onFocus={onFocus}
                onBlur={hideTooltip}
            >
                {isEmpty ? (
                    <p className="absolute inset-0 flex items-center justify-center text-[14px] text-text-low">
                        Nothing to show for this view.
                    </p>
                ) : null}
                {layers.map(({ spec, z }) => (
                    <div
                        key={spec.key}
                        ref={layerRef(spec.key)}
                        // Opaque, so the outer view never shows through the gaps between the inner view's tiles.
                        className="absolute origin-top-left bg-white"
                        style={{ inset: STAGE_PADDING, zIndex: z }}
                    >
                        <HeatmapLayer
                            layout={spec.layout}
                            period={tilePeriod}
                            onOpenAsset={openAsset}
                            onOpenSector={openSector}
                        />
                    </div>
                ))}
                {scene && scene.kind !== 'rest' ? (
                    // Takes the pointer while the camera moves, so hover rings and the tooltip don't ride
                    // along. A shield rather than inert/pointer-events on the layers: those inherit, and
                    // toggling them restyles every tile twice per move.
                    <div aria-hidden="true" className="absolute inset-0 z-10" />
                ) : null}
            </div>

            <HeatmapTooltip ref={tooltipRef} />
        </div>
    );
}
