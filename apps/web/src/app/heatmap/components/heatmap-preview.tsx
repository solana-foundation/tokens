'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { trackEvent } from '@/lib/posthog-client';
import type { HeatmapPreviewData } from '../lib/preview';
import { layoutOverview, type LayoutTile } from '../lib/treemap';
import { GroupHeader } from './heatmap-group-header';
import { HeatmapTile } from './heatmap-tile';
import { HeatmapTooltip, type HeatmapTooltipHandle } from './heatmap-tooltip';

/**
 * Map height inside the card. The card matches a highlight card's 206px inner card (24px padding
 * around a 128px chart, 4px gap, and a 26px name row); the map takes 12px padding instead.
 */
export const PREVIEW_MAP_HEIGHT = 182;

function openHeatmapEvent(source: string, url: string) {
    trackEvent('nav_link_clicked', { destination: 'heatmap', link_url: url, source });
}

/**
 * The heat map's overview as a home-page card, styled like the highlight cards above it. Tiles and
 * category labels lead into the full /heatmap; there is no zoom here.
 */
export function HeatmapPreview({ preview }: { preview: HeatmapPreviewData }) {
    const router = useRouter();
    const stageRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HeatmapTooltipHandle>(null);
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const element = stageRef.current;
        if (!element) return;
        const measure = () => setWidth(Math.floor(element.clientWidth));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const layout = useMemo(
        () => (width > 0 ? layoutOverview(preview.data, width, PREVIEW_MAP_HEIGHT) : null),
        [preview.data, width],
    );
    const tilesByKey = useMemo(() => {
        const tiles = new Map<string, LayoutTile>();
        for (const group of layout?.groups ?? []) for (const tile of group.tiles) tiles.set(tile.key, tile);
        return tiles;
    }, [layout]);

    const openSector = useCallback(
        (sectorId: string) => {
            const url = `/heatmap?sector=${encodeURIComponent(sectorId)}`;
            openHeatmapEvent('home_heatmap_preview', url);
            router.push(url);
        },
        [router],
    );
    const openAsset = useCallback(
        (assetId: string) => router.push(preview.hrefs[assetId] ?? `/heatmap?asset=${encodeURIComponent(assetId)}`),
        [router, preview.hrefs],
    );

    const onPointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (event.pointerType === 'touch') return;
            const element = event.target instanceof Element ? event.target.closest('[data-tile]') : null;
            const tile = element ? tilesByKey.get(element.getAttribute('data-tile') ?? '') : undefined;
            if (tile) tooltipRef.current?.show(tile, event.clientX, event.clientY);
            else tooltipRef.current?.hide();
        },
        [tilesByKey],
    );
    const hideTooltip = useCallback(() => tooltipRef.current?.hide(), []);

    return (
        <>
            <article className="rounded-[22px] bg-border-light/30">
                <div className="flex items-center justify-between gap-4 px-[24px] pt-[10px]">
                    <p className="text-[15px] text-text-high">Heat map</p>
                    <Link
                        href="/heatmap"
                        className="inline-flex items-center gap-1 text-[13px] font-medium text-text-low transition-colors hover:text-text-extra-high"
                        onClick={() => openHeatmapEvent('home_heatmap_preview_header', '/heatmap')}
                    >
                        Explore
                        <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </Link>
                </div>

                <div className="mt-3 rounded-[22px] border border-border-medium bg-white p-3">
                    <div
                        ref={stageRef}
                        className={`relative w-full ${layout ? '' : 'animate-pulse rounded-lg bg-gray-50'}`}
                        style={{ height: PREVIEW_MAP_HEIGHT }}
                        onPointerMove={onPointerMove}
                        onPointerLeave={hideTooltip}
                    >
                        {layout?.groups.map(group => (
                            <div key={group.id}>
                                {group.headerHeight > 0 ? (
                                    <GroupHeader group={group} onOpenSector={openSector} />
                                ) : null}
                                {group.tiles.map(tile => (
                                    <HeatmapTile
                                        key={tile.key}
                                        tile={tile}
                                        period="24h"
                                        onOpenAsset={openAsset}
                                        onOpenSector={openSector}
                                        href={tile.kind === 'asset' ? preview.hrefs[tile.asset.assetId] : undefined}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            </article>
            <HeatmapTooltip ref={tooltipRef} />
        </>
    );
}

/** Same footprint as the loaded card, so the page doesn't shift when it streams in. */
export function HeatmapPreviewFallback() {
    return (
        <div className="rounded-[22px] bg-border-light/30">
            <div className="px-[24px] pt-[10px] text-[15px] text-text-high">Heat map</div>
            <div className="mt-3 rounded-[22px] border border-border-medium bg-white p-3">
                <div className="w-full animate-pulse rounded-lg bg-gray-50" style={{ height: PREVIEW_MAP_HEIGHT }} />
            </div>
        </div>
    );
}
