'use client';

import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type PointerEvent,
} from 'react';
import { AnimatePresence, domAnimation, LazyMotion, m, useIsPresent, useReducedMotion } from 'motion/react';
import { parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';

import { buildCoinHref } from '@/lib/coin-href';
import {
    cameraMove,
    expandFrom,
    squeezeInto,
    viewKey,
    type CameraMove,
    type HeatmapView,
    type LayerTransform,
} from '../lib/camera';
import { formatUsdCompact } from '../lib/labels';
import {
    layoutAsset,
    layoutOverview,
    layoutSector,
    type HeatmapLayout,
    type LayoutGroup,
    type LayoutTile,
} from '../lib/treemap';
import {
    HEATMAP_PERIODS,
    type HeatmapAsset,
    type HeatmapData,
    type HeatmapPeriod,
    type HeatmapSector,
} from '../lib/types';
import { HeatmapLegend } from './heatmap-legend';
import { HeatmapTile } from './heatmap-tile';
import { HeatmapToolbar, type HeatmapCrumb } from './heatmap-toolbar';
import { HeatmapTooltip, type HeatmapTooltipHandle } from './heatmap-tooltip';

interface StageSize {
    width: number;
    height: number;
}

interface CameraCustom {
    move: CameraMove;
    width: number;
    height: number;
}

const REST: LayerTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

const LAYER_VARIANTS = {
    enter: ({ move, width, height }: CameraCustom) => {
        if (move.mode === 'in') return { ...squeezeInto(move.anchor, width, height), opacity: 0 };
        if (move.mode === 'out') return { ...expandFrom(move.anchor, width, height), opacity: 0 };
        return { ...REST, opacity: 0 };
    },
    center: { ...REST, opacity: 1 },
    exit: ({ move, width, height }: CameraCustom) => {
        if (move.mode === 'in') return { ...expandFrom(move.anchor, width, height), opacity: 0 };
        if (move.mode === 'out') return { ...squeezeInto(move.anchor, width, height), opacity: 0 };
        return { ...REST, opacity: 0 };
    },
};

const CAMERA_TRANSITION = {
    type: 'spring',
    stiffness: 240,
    damping: 30,
    mass: 0.9,
    opacity: { duration: 0.24, ease: 'easeOut' },
} as const;

function GroupHeader({
    group,
    onOpenSector,
}: {
    group: LayoutGroup;
    /** Absent where the group is not a sector (variant categories inside an asset). */
    onOpenSector?: (sectorId: string) => void;
}) {
    const style = { left: group.rect.x, top: group.rect.y, width: group.rect.w, height: group.headerHeight };
    const label = (
        <>
            <span className="truncate font-semibold text-text-extra-high">{group.label}</span>
            {group.total > 0 && group.rect.w >= 150 ? (
                <span className="shrink-0 tabular-nums text-text-low">{formatUsdCompact(group.total)}</span>
            ) : null}
            {group.rect.w >= 210 ? (
                <span className="shrink-0 tabular-nums text-text-extra-low">{group.itemCount}</span>
            ) : null}
        </>
    );
    const className = 'absolute flex items-center gap-2 overflow-hidden px-0.5 pb-1 text-left text-[12px] leading-none';

    if (!onOpenSector) {
        return (
            <div className={className} style={style}>
                {label}
            </div>
        );
    }

    return (
        <button
            type="button"
            aria-label={`${group.label}, ${group.itemCount} assets. Show this category.`}
            className={`${className} rounded-sm outline-none hover:[&>span:first-child]:underline focus-visible:ring-2 focus-visible:ring-gray-1400`}
            style={style}
            onClick={() => onOpenSector(group.id)}
        >
            {label}
        </button>
    );
}

interface HeatmapLayerProps {
    layout: HeatmapLayout;
    period: HeatmapPeriod;
    onOpenAsset: (assetId: string) => void;
    onOpenSector: (sectorId: string) => void;
}

const HeatmapLayer = memo(function HeatmapLayer({ layout, period, onOpenAsset, onOpenSector }: HeatmapLayerProps) {
    // The outgoing layer keeps animating on top of the incoming one; it must not swallow clicks.
    const isPresent = useIsPresent();

    return (
        <div className="absolute inset-0" style={{ pointerEvents: isPresent ? 'auto' : 'none' }}>
            {layout.groups.map(group => (
                <div key={group.id}>
                    {group.headerHeight > 0 ? (
                        <GroupHeader
                            group={group}
                            onOpenSector={layout.level === 'overview' ? onOpenSector : undefined}
                        />
                    ) : null}
                    {group.tiles.map(tile => (
                        <HeatmapTile
                            key={tile.key}
                            tile={tile}
                            period={period}
                            onOpenAsset={onOpenAsset}
                            onOpenSector={onOpenSector}
                        />
                    ))}
                </div>
            ))}
        </div>
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
 */
export function Heatmap({ data }: { data: HeatmapData }) {
    const [query, setQuery] = useQueryStates(
        {
            sector: parseAsString,
            asset: parseAsString,
            period: parseAsStringEnum<HeatmapPeriod>([...HEATMAP_PERIODS]).withDefault('24h'),
        },
        { history: 'push', scroll: false },
    );
    const { period } = query;

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
            const width = Math.floor(element.clientWidth);
            const height = Math.floor(element.clientHeight);
            setStage(current => (current?.width === width && current.height === height ? current : { width, height }));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const layoutFor = useCallback(
        (target: HeatmapView, size: StageSize): HeatmapLayout => {
            if (target.level === 'asset') {
                const asset = index.assets.get(target.assetId);
                if (asset) return layoutAsset(asset, size.width, size.height);
            }
            if (target.level === 'sector') {
                const sector = index.sectors.get(target.sectorId);
                if (sector) return layoutSector(sector, size.width, size.height);
            }
            return layoutOverview(data, size.width, size.height);
        },
        [data, index],
    );

    const layout = useMemo(() => (stage ? layoutFor(view, stage) : null), [layoutFor, view, stage]);

    // Camera: when the layer changes, work out how the old one hands over to the new one.
    const layerKey = viewKey(view);
    const [camera, setCamera] = useState<{ layerKey: string; view: HeatmapView; move: CameraMove }>({
        layerKey,
        view,
        move: { mode: 'fade' },
    });
    let move = camera.move;
    if (camera.layerKey !== layerKey) {
        move =
            stage && layout ? cameraMove(layoutFor(camera.view, stage), camera.view, layout, view) : { mode: 'fade' };
        setCamera({ layerKey, view, move });
    }

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
            if (event.pointerType === 'touch') return;
            const hit = tileAt(event.target);
            if (hit) tooltipRef.current?.show(hit.tile, event.clientX, event.clientY);
            else tooltipRef.current?.hide();
        },
        [tileAt],
    );
    const onFocus = useCallback(
        (event: FocusEvent<HTMLDivElement>) => {
            const hit = tileAt(event.target);
            if (!hit || !hit.element.matches(':focus-visible')) return;
            const box = hit.element.getBoundingClientRect();
            tooltipRef.current?.show(hit.tile, box.left + Math.min(box.width, 28), box.bottom - 10);
        },
        [tileAt],
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

    const tableSectorId = viewAsset?.sectorId ?? viewSectorId;
    const reduceMotion = useReducedMotion();
    const custom: CameraCustom = { move, width: stage?.width ?? 1, height: stage?.height ?? 1 };
    const isEmpty = layout !== null && layout.groups.length === 0;

    return (
        <div>
            <HeatmapToolbar
                crumbs={crumbs}
                assetHref={viewAsset ? buildCoinHref(viewAsset.assetId, undefined) : undefined}
                tableHref={tableSectorId ? `/?category=${encodeURIComponent(tableSectorId)}` : '/'}
                period={period}
                onPeriodChange={next => void setQuery({ period: next }, { history: 'replace' })}
            />

            <div
                ref={stageRef}
                className={`relative h-[max(440px,calc(100dvh-280px))] w-full overflow-hidden rounded-lg ${layout ? '' : 'animate-pulse bg-gray-50'}`}
                onPointerMove={onPointerMove}
                onPointerLeave={hideTooltip}
                onFocus={onFocus}
                onBlur={hideTooltip}
            >
                {isEmpty ? (
                    <p className="absolute inset-0 flex items-center justify-center text-[14px] text-text-low">
                        Nothing to show for this view.
                    </p>
                ) : null}
                <LazyMotion features={domAnimation}>
                    <AnimatePresence initial={false} custom={custom}>
                        {layout && !isEmpty ? (
                            <m.div
                                key={layerKey}
                                custom={custom}
                                variants={LAYER_VARIANTS}
                                initial="enter"
                                animate="center"
                                exit="exit"
                                transition={reduceMotion ? { duration: 0 } : CAMERA_TRANSITION}
                                className="absolute inset-0 will-change-transform"
                                style={{ originX: 0, originY: 0 }}
                            >
                                <HeatmapLayer
                                    layout={layout}
                                    period={period}
                                    onOpenAsset={openAsset}
                                    onOpenSector={openSector}
                                />
                            </m.div>
                        ) : null}
                    </AnimatePresence>
                </LazyMotion>
            </div>

            <HeatmapLegend period={period} />
            <HeatmapTooltip ref={tooltipRef} />
        </div>
    );
}
