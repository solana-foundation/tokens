'use client';

import Link from 'next/link';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { trackEvent } from '@/lib/posthog-client';
import { changeBin, NO_DATA_FILL } from '../lib/color';
import { formatChange } from '../lib/labels';
import { layoutSector } from '../lib/treemap';
import type { HeatmapSector } from '../lib/types';

const MAP_HEIGHT = 104;

/**
 * A category's heat map at thumbnail size, for the floating market feed. The whole block is one
 * link into the full map, so tiles are plain coloured boxes: no per-tile links, hover cards or zoom.
 */
export function HeatmapMini({ sector }: { sector: HeatmapSector | null | undefined }) {
    const stageRef = useRef<HTMLDivElement>(null);
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

    const tiles = useMemo(() => {
        if (!sector || width <= 0) return [];
        // The category layout enlarges small tiles rather than folding them into "+N more": a thumbnail
        // has no use for a gray overflow box.
        return layoutSector(sector, width, MAP_HEIGHT).groups.flatMap(group => group.tiles);
    }, [sector, width]);

    const href = `/heatmap?sector=${encodeURIComponent(sector?.id ?? 'stocks')}`;

    return (
        <Link
            href={href}
            aria-label={`Open the ${sector?.label ?? 'Stocks'} heat map`}
            onClick={() =>
                trackEvent('nav_link_clicked', { destination: 'heatmap', link_url: href, source: 'market_feed' })
            }
            className="group block overflow-hidden rounded-[19px] border border-border-light/70 bg-gray-100/60 shadow-[0_14px_36px_rgba(20,20,21,0.12)] backdrop-blur-xl transition-[background-color] duration-150 hover:bg-gray-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
        >
            <div className="flex items-center justify-between gap-3 px-3 pt-2 text-xs font-medium">
                <span className="text-text-extra-high">{sector?.label ?? 'Stocks'} · 24h</span>
                <span className="inline-flex items-center gap-0.5 text-text-low transition-colors group-hover:text-text-extra-high">
                    Heat map
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </span>
            </div>
            <div className="p-1.5 pt-2">
                <div
                    ref={stageRef}
                    aria-hidden="true"
                    className={`relative w-full overflow-hidden rounded-[13px] bg-white ${tiles.length ? '' : 'animate-pulse'}`}
                    style={{ height: MAP_HEIGHT }}
                >
                    {tiles.map(tile => {
                        const { x, y, w, h } = tile.rect;
                        if (tile.kind !== 'asset') {
                            return (
                                <div
                                    key={tile.key}
                                    className="absolute rounded-[2px] bg-gray-100"
                                    style={{ left: x, top: y, width: w, height: h }}
                                />
                            );
                        }
                        const bin = changeBin(tile.asset.change24h, '24h');
                        const showSymbol = w >= 30 && h >= 16;
                        const showChange = w >= 46 && h >= 30;
                        return (
                            <div
                                key={tile.key}
                                className="absolute flex flex-col items-center justify-center overflow-hidden rounded-[2px] leading-none"
                                style={{
                                    left: x,
                                    top: y,
                                    width: w,
                                    height: h,
                                    background: bin?.fill ?? NO_DATA_FILL,
                                    color: bin?.ink,
                                }}
                            >
                                {showSymbol ? (
                                    <span className="max-w-full truncate px-0.5 text-[10px] font-semibold">
                                        {tile.asset.symbol}
                                    </span>
                                ) : null}
                                {showChange ? (
                                    <span className="mt-0.5 text-[9px] tabular-nums">
                                        {formatChange(tile.asset.change24h)}
                                    </span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </div>
        </Link>
    );
}
