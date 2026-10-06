'use client';

import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';

import { formatPrice } from '@/lib/format';
import { changeBin, NO_DATA_FILL } from '../lib/color';
import { formatChange, formatUsdCompact, formatVolume, marketCapLabel } from '../lib/labels';
import type { LayoutTile } from '../lib/treemap';
import type { HeatmapPeriod } from '../lib/types';

export interface HeatmapTooltipHandle {
    /** Show `tile` near a viewport point (pointer position, or a focused tile's corner). */
    show: (tile: LayoutTile, clientX: number, clientY: number) => void;
    hide: () => void;
}

const POINTER_OFFSET = 14;
const VIEWPORT_MARGIN = 8;

function ChangeRow({ label, change, period }: { label: string; change: number | null; period: HeatmapPeriod }) {
    const bin = changeBin(change, period);
    return (
        <>
            <dt className="text-text-low">{label}</dt>
            <dd className="flex items-center justify-end gap-1.5 font-medium tabular-nums text-text-extra-high">
                <span
                    aria-hidden="true"
                    className="size-2 rounded-[2px] border border-black/10"
                    style={{ background: bin?.fill ?? NO_DATA_FILL }}
                />
                {formatChange(change)}
            </dd>
        </>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="text-text-low">{label}</dt>
            <dd className="text-right font-medium tabular-nums text-text-extra-high">{value}</dd>
        </>
    );
}

function TooltipBody({ tile }: { tile: LayoutTile }) {
    if (tile.kind === 'more') {
        return (
            <>
                <p className="font-semibold text-text-extra-high">+{tile.count} more</p>
                <p className="mt-1 text-text-low">Too small to draw at this size. Click to open the category.</p>
            </>
        );
    }

    if (tile.kind === 'variant') {
        const { variant } = tile;
        return (
            <>
                <p className="font-semibold text-text-extra-high">
                    {variant.symbol} <span className="font-normal text-text-low">{variant.name}</span>
                </p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <Row label="Price" value={formatPrice(variant.price)} />
                    <ChangeRow label="24h" change={variant.change24h} period="24h" />
                    <ChangeRow label="1h" change={variant.change1h} period="1h" />
                    <Row label="24h volume" value={formatVolume(variant.volume24h)} />
                    <Row label="On-Solana value" value={formatUsdCompact(variant.marketCap)} />
                    <Row label="Liquidity" value={formatUsdCompact(variant.liquidity)} />
                </dl>
                <p className="mt-2 text-text-extra-low">
                    {variant.groupLabel}
                    {variant.hasTokenPage ? ' · click to open the token page' : ''}
                </p>
            </>
        );
    }

    const { asset } = tile;
    return (
        <>
            <p className="font-semibold text-text-extra-high">
                {asset.symbol} <span className="font-normal text-text-low">{asset.name}</span>
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <Row label="Price" value={formatPrice(asset.price)} />
                <ChangeRow label="24h" change={asset.change24h} period="24h" />
                <ChangeRow label="1h" change={asset.change1h} period="1h" />
                <Row label="24h volume" value={formatVolume(asset.volume24h)} />
                <Row label={marketCapLabel(asset)} value={formatUsdCompact(asset.marketCap)} />
            </dl>
            <p className="mt-2 text-text-extra-low">
                {asset.variants.length > 1
                    ? `${asset.variants.length} variants · click to see them`
                    : 'Click to open the asset page'}
            </p>
        </>
    );
}

/**
 * One tooltip for the whole map. The stage delegates pointer/focus events and
 * drives this imperatively, so moving the pointer never re-renders the tiles.
 */
export function HeatmapTooltip({ ref }: { ref: Ref<HeatmapTooltipHandle> }) {
    const elementRef = useRef<HTMLDivElement>(null);
    const [tile, setTile] = useState<LayoutTile | null>(null);
    const pointRef = useRef({ x: 0, y: 0 });

    const place = useCallback(() => {
        const element = elementRef.current;
        if (!element) return;

        const { x, y } = pointRef.current;
        const { offsetWidth: width, offsetHeight: height } = element;
        // Prefer below-right of the point; flip when that would leave the viewport.
        let left = x + POINTER_OFFSET;
        if (left + width > window.innerWidth - VIEWPORT_MARGIN) left = x - POINTER_OFFSET - width;
        let top = y + POINTER_OFFSET;
        if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = y - POINTER_OFFSET - height;

        element.style.transform = `translate3d(${Math.max(VIEWPORT_MARGIN, left)}px, ${Math.max(VIEWPORT_MARGIN, top)}px, 0)`;
    }, []);

    useImperativeHandle(
        ref,
        () => ({
            show(nextTile, clientX, clientY) {
                pointRef.current = { x: clientX, y: clientY };
                setTile(current => (current?.key === nextTile.key ? current : nextTile));
                place();
            },
            hide() {
                setTile(null);
            },
        }),
        [place],
    );

    // Re-place once the new tile's content has rendered and changed the tooltip's size.
    useLayoutEffect(() => {
        place();
    }, [tile, place]);

    return (
        <div
            ref={elementRef}
            role="tooltip"
            className="pointer-events-none fixed left-0 top-0 z-50 w-max max-w-[280px] rounded-xl border border-border-light bg-white px-3 py-2.5 text-[12px] leading-[1.35] shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
            style={{ visibility: tile ? 'visible' : 'hidden' }}
        >
            {tile ? <TooltipBody tile={tile} /> : null}
        </div>
    );
}
