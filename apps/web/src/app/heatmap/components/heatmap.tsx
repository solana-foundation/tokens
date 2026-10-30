'use client';

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';

import { viewKey, type HeatmapView } from '../lib/camera';
import { populatedOnly } from '../lib/populated';
import {
    destinationOf,
    layerHeight,
    nextScene,
    SCROLL_OFFSET,
    STAGE_MIN_HEIGHT,
    STAGE_PADDING,
    type LayerSpec,
    type Scene,
    type ScrollContext,
    type StageSize,
} from '../lib/scene';
import { layoutAsset, layoutOverviewRows, layoutSector, type HeatmapLayout } from '../lib/treemap';
import {
    HEATMAP_PERIODS,
    type HeatmapAsset,
    type HeatmapData,
    type HeatmapPeriod,
    type HeatmapSector,
} from '../lib/types';
import { HeatmapLayer } from './heatmap-layer';
import { HeatmapToolbar, type HeatmapCrumb } from './heatmap-toolbar';
import { HeatmapTooltip } from './heatmap-tooltip';
import { useCameraMotion } from './use-camera-motion';
import { useStageSize } from './use-stage-size';
import { useTileHover } from './use-tile-hover';

function isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Sector and asset lookups; the Trending row repeats assets from other rows without their variants. */
function indexData(data: HeatmapData) {
    const sectors = new Map<string, HeatmapSector>();
    const assets = new Map<string, HeatmapAsset>();
    for (const sector of data.sectors) {
        sectors.set(sector.id, sector);
        // The asset's own row's entry is the one that drills down.
        for (const asset of sector.assets) {
            if (sector.id !== 'trending' || !assets.has(asset.assetId)) assets.set(asset.assetId, asset);
        }
    }
    return { sectors, assets };
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
    const index = useMemo(() => indexData(data), [data]);

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
    const stage = useStageSize(stageRef);

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
            const result = computed ?? layoutOverviewRows(data, size.width);
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
            // Read during render, only when the view changes: the zoom's geometry depends on where
            // the page is scrolled, and the first frame must be right before paint.
            const stageTop = (stageRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY + STAGE_PADDING;
            const page: ScrollContext = { stageTop, scrollY: window.scrollY };
            setScene(nextScene(scene, current, stage, stageKey, !reduceMotion, page));
        }
    }
    const { layerRef, sceneRef } = useCameraMotion(scene, setScene, stageRef);

    const setPeriod = useCallback(
        (next: HeatmapPeriod) => void setQuery({ period: next }, { history: 'replace' }),
        [setQuery],
    );
    // Views deeper than the overview fill the stage: bring it into view. Coming back, land on the
    // row that was open, which may be anywhere down the page.
    const previousViewRef = useRef(view);
    useEffect(() => {
        const previous = previousViewRef.current;
        previousViewRef.current = view;
        if (previous === view) return;
        const element = stageRef.current;
        if (!element) return;
        // A zoom places the page itself (see nextScene); this is for cuts and fades.
        if (sceneRef.current?.kind === 'zoom') return;

        const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
        if (view.level !== 'overview') {
            const top = element.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
            if (window.scrollY > top + 1) window.scrollTo({ top: Math.max(0, top), behavior });
            return;
        }
        const sectorId =
            previous.level === 'sector'
                ? previous.sectorId
                : previous.level === 'asset'
                  ? index.assets.get(previous.assetId)?.sectorId
                  : null;
        const row = sectorId
            ? element.querySelector<HTMLElement>(`[data-sector-header="${CSS.escape(sectorId)}"]`)
            : null;
        if (row) {
            window.scrollTo({
                top: Math.max(0, row.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET),
                behavior,
            });
        }
    }, [view, index, reduceMotion, sceneRef]);

    const openAsset = useCallback((assetId: string) => void setQuery({ asset: assetId }), [setQuery]);
    const openSector = useCallback((sectorId: string) => void setQuery({ sector: sectorId, asset: null }), [setQuery]);
    const openOverview = useCallback(() => void setQuery({ sector: null, asset: null }), [setQuery]);
    const level = view.level;
    // Escape steps out one level. Leaving an asset lands on the sector it was opened from, if any.
    const stepOut = useEffectEvent(() => {
        if (level === 'asset') void setQuery({ asset: null });
        else if (level === 'sector') void setQuery({ sector: null });
    });
    useEffect(() => {
        if (level === 'overview') return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return;
            stepOut();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
        // An effect event is not a dependency; eslint-plugin-react-hooks 5 predates useEffectEvent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [level]);

    const { tooltipRef, onPointerMove, onPointerDown, onFocus, hideTooltip } = useTileHover({
        layout,
        stage,
        layerKey,
        getLayout,
    });

    // Explore › Heatmaps › <category> › <asset>: the site's Explore page, then the heat map's levels.
    const crumbs = useMemo<HeatmapCrumb[]>(() => {
        const sector = viewAsset ? index.sectors.get(viewAsset.sectorId) : viewSector;
        const explore: HeatmapCrumb = { key: 'explore', label: 'Explore', href: '/' };
        const root: HeatmapCrumb = {
            key: 'heatmaps',
            label: 'Heatmaps',
            ...(sector ? { onSelect: openOverview } : {}),
        };
        if (!sector) return [explore, root];

        const sectorCrumb: HeatmapCrumb = {
            key: `sector:${sector.id}`,
            label: sector.label,
            ...(viewAsset ? { onSelect: () => openSector(sector.id) } : {}),
        };
        if (!viewAsset) return [explore, root, sectorCrumb];

        return [
            explore,
            root,
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
    // The overview is as tall as its rows; other views fill the viewport.
    const stageHeight =
        (scene?.kind === 'zoom'
            ? scene.height
            : destination && stage
              ? layerHeight(destination, stage)
              : (stage?.height ?? STAGE_MIN_HEIGHT - STAGE_PADDING * 2)) +
        STAGE_PADDING * 2;

    return (
        <div>
            <HeatmapToolbar crumbs={crumbs} period={period} onPeriodChange={setPeriod} />

            <div
                ref={stageRef}
                // Focus lands here while a zoom retires the layer that held it.
                tabIndex={-1}
                className={`relative w-full overflow-hidden rounded-lg outline-none ${scene ? '' : 'animate-pulse bg-gray-50'}`}
                style={{ height: stageHeight }}
                onPointerMove={onPointerMove}
                onPointerDown={onPointerDown}
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
                        style={{
                            left: STAGE_PADDING,
                            top: STAGE_PADDING,
                            width: stage?.width,
                            height: stage ? layerHeight(spec, stage) : undefined,
                            zIndex: z,
                        }}
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
