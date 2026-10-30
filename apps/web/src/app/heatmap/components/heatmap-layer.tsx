'use client';

import { memo, startTransition, useEffect, useMemo, useState } from 'react';

import type { HeatmapLayout } from '../lib/treemap';
import type { HeatmapPeriod } from '../lib/types';
import { GroupHeader } from './heatmap-group-header';
import { HeatmapTile } from './heatmap-tile';

/** Views with more tiles than this mount their largest tiles first and the rest in batches. */
const FIRST_BATCH = 48;
const NEXT_BATCH = 48;

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

/** One view's tiles. */
export const HeatmapLayer = memo(function HeatmapLayer({
    layout,
    period,
    onOpenAsset,
    onOpenSector,
}: HeatmapLayerProps) {
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
