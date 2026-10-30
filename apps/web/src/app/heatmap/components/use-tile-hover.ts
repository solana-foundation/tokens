'use client';

import { useCallback, useEffect, useMemo, useRef, type FocusEvent, type PointerEvent } from 'react';

import { viewKey, type HeatmapView } from '../lib/camera';
import { preloadTileLogos } from '../lib/preload-logos';
import type { StageSize } from '../lib/scene';
import type { HeatmapLayout, LayoutTile } from '../lib/treemap';
import type { HeatmapTooltipHandle } from './heatmap-tooltip';

interface TileHoverArgs {
    layout: HeatmapLayout | null;
    stage: StageSize | null;
    /** Key of the view on screen; hovering something that opens it prepares nothing. */
    layerKey: string;
    getLayout: (target: HeatmapView, size: StageSize) => HeatmapLayout;
}

/**
 * Stage-level pointer and focus handling: one shared tooltip driven by delegation (tiles carry no
 * handlers), and preparing the view a hovered tile or label would open, so the click only mounts it.
 */
export function useTileHover({ layout, stage, layerKey, getLayout }: TileHoverArgs) {
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
            if (tile?.kind === 'asset' && tile.asset.variants.length > 1) {
                next = { level: 'asset', assetId: tile.asset.assetId };
            } else if (tile?.kind === 'more') {
                next = { level: 'sector', sectorId: tile.groupId };
            } else {
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
    const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => prepare(event.target), [prepare]);
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

    return { tooltipRef, onPointerMove, onPointerDown, onFocus, hideTooltip };
}
