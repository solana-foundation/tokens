'use client';

import Link from 'next/link';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { trackEvent } from '@/lib/posthog-client';
import { changeBin, NO_DATA_FILL } from '../lib/color';
import { formatChange } from '../lib/labels';
import { TRENDING_SECTOR_ID, type HeatmapMiniResponse } from '../lib/preview';
import { layoutSector, type LayoutTile } from '../lib/treemap';
import { HeatmapTooltip, type HeatmapTooltipHandle } from './heatmap-tooltip';

const MAP_HEIGHT = 104;

interface HeatmapMiniProps {
    data: HeatmapMiniResponse | undefined;
    /** Move to the next category (the selector cycles, like the feed's Pull setting). */
    onCycle: () => void;
    /** Hovering the selector warms the next category so the click swaps instantly. */
    onCycleIntent?: () => void;
}

/**
 * A heat map category at thumbnail size, for the floating market feed. The header cycles through the
 * categories; the map links into the full heat map, and each tile shows the dark hover card.
 */
export function HeatmapMini({ data, onCycle, onCycleIntent }: HeatmapMiniProps) {
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

    const sector = data?.sector;
    const tiles = useMemo(() => {
        if (!sector || width <= 0) return [];
        // The category layout enlarges small tiles rather than folding them into "+N more": a thumbnail
        // has no use for a gray overflow box.
        return layoutSector(sector, width, MAP_HEIGHT).groups.flatMap(group => group.tiles);
    }, [sector, width]);
    const tilesByKey = useMemo(() => new Map(tiles.map(tile => [tile.key, tile])), [tiles]);

    const onPointerMove = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (event.pointerType === 'touch') return;
            const element = event.target instanceof Element ? event.target.closest('[data-tile]') : null;
            const tile: LayoutTile | undefined = element
                ? tilesByKey.get(element.getAttribute('data-tile') ?? '')
                : undefined;
            if (tile) tooltipRef.current?.show(tile, event.clientX, event.clientY);
            else tooltipRef.current?.hide();
        },
        [tilesByKey],
    );
    const hideTooltip = useCallback(() => tooltipRef.current?.hide(), []);

    const sectors = data?.sectors ?? [];
    const label = sector?.label ?? 'Heat map';
    // Trending has no full heat map; it opens the home page's Trending tab instead.
    const isTrending = sector?.id === TRENDING_SECTOR_ID;
    const href = !sector
        ? '/heatmap'
        : isTrending
          ? '/?category=trending'
          : `/heatmap?sector=${encodeURIComponent(sector.id)}`;
    const trackOpen = () =>
        trackEvent('nav_link_clicked', {
            destination: isTrending ? 'trending' : 'heatmap',
            link_url: href,
            source: 'market_feed',
        });

    return (
        <section
            aria-label="Heat map"
            className="overflow-hidden rounded-[27px] border border-border-light/50 bg-gray-100/50 shadow-[0_22px_60px_rgba(20,20,21,0.16)] backdrop-blur-xl"
        >
            <div className="flex items-center justify-between gap-3 px-2 pt-2">
                <button
                    type="button"
                    aria-label={`Heat map category: ${label}. Click for the next category.`}
                    disabled={sectors.length < 2}
                    onClick={onCycle}
                    onPointerEnter={onCycleIntent}
                    onFocus={onCycleIntent}
                    className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 transition-[transform,background-color] duration-150 ease-out hover:bg-white/70 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium enabled:cursor-pointer disabled:active:scale-100"
                >
                    <span className="text-xs font-semibold text-text-extra-high">{label}</span>
                    {sectors.length > 1 ? (
                        <span className="flex items-center gap-1" aria-hidden>
                            {sectors.map(option => (
                                <span
                                    key={option.id}
                                    className={cn(
                                        'size-1 rounded-full transition-colors',
                                        option.id === sector?.id ? 'bg-text-high' : 'bg-border-medium',
                                    )}
                                />
                            ))}
                        </span>
                    ) : null}
                </button>
                <Link
                    href={href}
                    onClick={trackOpen}
                    className="inline-flex items-center gap-0.5 rounded-lg px-1.5 py-1 text-xs font-medium text-text-low transition-colors hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                >
                    {isTrending ? 'View all' : 'Heat map'}
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
            </div>

            <div className="mt-2 rounded-[29px] border border-border-medium bg-white p-2">
                <Link
                    href={href}
                    onClick={trackOpen}
                    aria-label={isTrending ? 'Open trending tokens' : `Open the ${label} heat map`}
                    className="block rounded-[21px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                >
                    <div
                        ref={stageRef}
                        className={cn(
                            'relative w-full overflow-hidden rounded-[21px] bg-white',
                            !tiles.length && 'animate-pulse',
                        )}
                        style={{ height: MAP_HEIGHT }}
                        onPointerMove={onPointerMove}
                        onPointerLeave={hideTooltip}
                    >
                        {tiles.map(tile => {
                            const { x, y, w, h } = tile.rect;
                            const box = { left: x, top: y, width: w, height: h };
                            if (tile.kind !== 'asset') {
                                return (
                                    <div key={tile.key} className="absolute rounded-[2px] bg-gray-100" style={box} />
                                );
                            }
                            const bin = changeBin(tile.asset.change24h, '24h');
                            return (
                                <div
                                    key={tile.key}
                                    data-tile={tile.key}
                                    className="absolute flex flex-col items-center justify-center overflow-hidden rounded-[2px] leading-none transition-[filter] duration-150 hover:brightness-[1.08]"
                                    style={{ ...box, background: bin?.fill ?? NO_DATA_FILL, color: bin?.ink }}
                                >
                                    {w >= 30 && h >= 16 ? (
                                        <span className="max-w-full truncate px-0.5 text-[10px] font-semibold">
                                            {tile.asset.symbol}
                                        </span>
                                    ) : null}
                                    {w >= 46 && h >= 30 ? (
                                        <span className="mt-0.5 text-[9px] tabular-nums">
                                            {formatChange(tile.asset.change24h)}
                                        </span>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </Link>
            </div>
            <HeatmapTooltip ref={tooltipRef} />
        </section>
    );
}
