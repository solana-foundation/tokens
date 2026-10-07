'use client';

import Link from 'next/link';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { ChevronRight } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { buildCoinHref } from '@/lib/coin-href';
import { trackEvent } from '@/lib/posthog-client';
import { changeBin, NO_DATA_FILL } from '../lib/color';
import { formatChange } from '../lib/labels';
import { TRENDING_SECTOR_ID, type HeatmapMiniResponse } from '../lib/preview';
import { layoutSector, type LayoutTile } from '../lib/treemap';
import { HeatmapTooltip, type HeatmapTooltipHandle } from './heatmap-tooltip';

const MAP_HEIGHT = 104;

/** Four rounded squares; the news panel's icon treatment (18px, extra-low text colour). */
function HeatmapIcon() {
    return (
        <span className="flex size-[18px] shrink-0 items-center justify-center text-text-extra-low" aria-hidden>
            <svg className="size-[18px]" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                    d="M11.33 5H8.67C6.64 5 5 6.64 5 8.67V11.33C5 13.36 6.64 15 8.67 15H11.33C13.36 15 15 13.36 15 11.33V8.67C15 6.64 13.36 5 11.33 5Z"
                    fill="currentColor"
                />
                <path
                    d="M23.33 5H20.67C18.64 5 17 6.64 17 8.67V11.33C17 13.36 18.64 15 20.67 15H23.33C25.36 15 27 13.36 27 11.33V8.67C27 6.64 25.36 5 23.33 5Z"
                    fill="currentColor"
                />
                <path
                    d="M11.33 17H8.67C6.64 17 5 18.64 5 20.67V23.33C5 25.36 6.64 27 8.67 27H11.33C13.36 27 15 25.36 15 23.33V20.67C15 18.64 13.36 17 11.33 17Z"
                    fill="currentColor"
                />
                <path
                    d="M23.33 17H20.67C18.64 17 17 18.64 17 20.67V23.33C17 25.36 18.64 27 20.67 27H23.33C25.36 27 27 25.36 27 23.33V20.67C27 18.64 25.36 17 23.33 17Z"
                    fill="currentColor"
                />
            </svg>
        </span>
    );
}

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
    const tooltipRef = useRef<HeatmapTooltipHandle>(null);
    const [width, setWidth] = useState(0);

    // The stage element is recreated when the category changes between link-wrapped and not
    // (Trending), so it is tracked as state and re-observed; a detached node would report width 0.
    const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!stageElement) return;
        const measure = () => {
            if (stageElement.isConnected) setWidth(Math.floor(stageElement.clientWidth));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(stageElement);
        return () => observer.disconnect();
    }, [stageElement]);

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
    const label = sector?.label ?? 'Stocks';
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

    // Trending tiles each open their asset page, so the map is not one link there.
    const stage = (
        <div
            ref={setStageElement}
            className={cn('relative w-full overflow-hidden rounded-[21px] bg-white', !tiles.length && 'animate-pulse')}
            style={{ height: MAP_HEIGHT }}
            onPointerMove={onPointerMove}
            onPointerLeave={hideTooltip}
        >
            {tiles.map(tile => {
                const { x, y, w, h } = tile.rect;
                const box = { left: x, top: y, width: w, height: h };
                if (tile.kind !== 'asset') {
                    return <div key={tile.key} className="absolute rounded-[2px] bg-gray-100" style={box} />;
                }
                const bin = changeBin(tile.asset.change24h, '24h');
                const face = (
                    <>
                        {w >= 30 && h >= 16 ? (
                            <span className="max-w-full truncate px-0.5 text-[10px] font-semibold">
                                {tile.asset.symbol}
                            </span>
                        ) : null}
                        {w >= 46 && h >= 30 ? (
                            <span className="mt-0.5 text-[9px] tabular-nums">{formatChange(tile.asset.change24h)}</span>
                        ) : null}
                    </>
                );
                const tileClass =
                    'absolute flex flex-col items-center justify-center overflow-hidden rounded-[2px] leading-none transition-[filter] duration-150 hover:brightness-[1.08]';
                const style = { ...box, background: bin?.fill ?? NO_DATA_FILL, color: bin?.ink };
                if (isTrending) {
                    return (
                        <Link
                            key={tile.key}
                            href={buildCoinHref(tile.asset.assetId, tile.asset.mint)}
                            prefetch={false}
                            data-tile={tile.key}
                            aria-label={`${tile.asset.name} (${tile.asset.symbol}), ${formatChange(tile.asset.change24h)} 24h. Open asset page.`}
                            onClick={() =>
                                trackEvent('feed_ticker_clicked', {
                                    token_symbol: tile.asset.symbol,
                                    token_price_change_24h: tile.asset.change24h,
                                    source: 'market_feed_heatmap',
                                })
                            }
                            className={`${tileClass} focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-1400`}
                            style={style}
                        >
                            {face}
                        </Link>
                    );
                }
                return (
                    <div key={tile.key} data-tile={tile.key} className={tileClass} style={style}>
                        {face}
                    </div>
                );
            })}
        </div>
    );

    return (
        <section
            aria-label="Heatmap"
            className="overflow-hidden rounded-[27px] border border-border-light/50 bg-gray-100/50 shadow-[0_22px_60px_rgba(20,20,21,0.16)] backdrop-blur-xl"
        >
            <div className="flex items-center justify-between gap-3 px-3.5 pt-2.5">
                <Link
                    href="/heatmap"
                    onClick={() =>
                        trackEvent('nav_link_clicked', {
                            destination: 'heatmap',
                            link_url: '/heatmap',
                            source: 'market_feed',
                        })
                    }
                    className="group flex min-w-0 items-center gap-1.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                >
                    <HeatmapIcon />
                    <h2 className="min-w-0 truncate text-base font-semibold text-text-extra-high">Heatmap</h2>
                    <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-text-extra-low transition-transform duration-150 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none"
                    />
                </Link>
                <button
                    type="button"
                    aria-label={`Showing ${label}. Click for the next category.`}
                    disabled={sectors.length < 2}
                    onClick={onCycle}
                    onPointerEnter={onCycleIntent}
                    onFocus={onCycleIntent}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg px-2 py-1 transition-[transform,background-color] duration-150 ease-out hover:bg-white/70 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium enabled:cursor-pointer disabled:active:scale-100"
                >
                    <span className="text-sm font-semibold text-text-extra-high">{label}</span>
                    {sectors.length > 1 ? (
                        <span className="flex shrink-0 flex-col items-center gap-1" aria-hidden>
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
            </div>

            <div className="mt-2 rounded-[29px] border border-border-medium bg-white p-2">
                {isTrending ? (
                    stage
                ) : (
                    <Link
                        href={href}
                        onClick={trackOpen}
                        aria-label={`Open the ${label} heat map`}
                        className="block rounded-[21px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                    >
                        {stage}
                    </Link>
                )}
            </div>
            <HeatmapTooltip ref={tooltipRef} />
        </section>
    );
}
