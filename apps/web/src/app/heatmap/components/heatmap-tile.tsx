'use client';

import Image, { getImageProps } from 'next/image';
import Link from 'next/link';
import { memo, useState, type CSSProperties, type ReactNode } from 'react';

import { buildCoinHref } from '@/lib/coin-href';
import { changeBin, NO_DATA_FILL, NO_DATA_HATCH, NO_DATA_INK } from '../lib/color';
import { formatChange, formatVolume, tileAriaLabel, tileChange } from '../lib/labels';
import type { HeatmapLayout, LayoutTile } from '../lib/treemap';
import type { HeatmapPeriod } from '../lib/types';

// `data-camera-anchor`: the tile a view is zooming out of or into. Its label would be a blurred giant
// behind that view, so it fades out as the view fades in (the camera drives the variable).
const TILE_CLASS =
    'absolute overflow-hidden rounded-[3px] text-left outline-none transition-[filter] duration-150 ring-offset-white hover:z-10 hover:brightness-[1.06] hover:ring-2 hover:ring-gray-1400 hover:ring-offset-1 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-gray-1400 focus-visible:ring-offset-1 [&[data-camera-anchor]>*]:opacity-(--camera-label-opacity)';

/** What a tile has room to say. Below `symbol` it is colour only and relies on the tooltip. */
type Detail = 'full' | 'change' | 'symbol' | 'none';

/** Requested logo size; the tile scales it to 20–44 px. Shared with the preloader so URLs match. */
const LOGO_SOURCE_SIZE = 40;

function detailFor(width: number, height: number): Detail {
    if (width >= 104 && height >= 78) return 'full';
    if (width >= 56 && height >= 36) return 'change';
    if (width >= 28 && height >= 15) return 'symbol';
    return 'none';
}

/** Rough width of a bold label in em: wide and narrow glyphs differ too much to count characters. */
function labelWidthEm(label: string): number {
    let width = 0;
    for (const char of label) width += 'WMwm'.includes(char) ? 0.98 : 'Iil1.'.includes(char) ? 0.4 : 0.72;
    return Math.max(width, 1.4);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function TileLogo({ src, alt, size }: { src: string; alt: string; size: number }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;

    return (
        <Image
            src={src}
            alt={alt}
            width={LOGO_SOURCE_SIZE}
            height={LOGO_SOURCE_SIZE}
            className="shrink-0 rounded-full bg-white/80 object-cover"
            style={{ width: size, height: size }}
            // A view's logos are few (only roomy tiles draw one) and on screen the moment it opens.
            loading="eager"
            decoding="async"
            onError={() => setFailed(true)}
            referrerPolicy="no-referrer"
        />
    );
}

const preloaded = new Set<string>();
const MAX_PRELOADS_PER_LAYOUT = 48;

/**
 * Warm the browser cache with the logos `layout` will draw, using the same
 * optimizer URLs the tiles request, so a view opens with its logos in place.
 */
export function preloadTileLogos(layout: HeatmapLayout): void {
    let started = 0;
    for (const group of layout.groups) {
        for (const tile of group.tiles) {
            if (tile.kind === 'more' || detailFor(tile.rect.w, tile.rect.h) !== 'full') continue;
            const src = faceFor(tile).logoURI;
            if (!src || preloaded.has(src)) continue;
            preloaded.add(src);

            const { props } = getImageProps({ src, alt: '', width: LOGO_SOURCE_SIZE, height: LOGO_SOURCE_SIZE });
            const image = new window.Image();
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            if (props.srcSet) image.srcset = props.srcSet;
            image.src = props.src;
            if (++started >= MAX_PRELOADS_PER_LAYOUT) return;
        }
    }
}

interface TileFace {
    symbol: string;
    logoURI?: string;
    variantCount: number;
}

function faceFor(tile: Exclude<LayoutTile, { kind: 'more' }>): TileFace {
    if (tile.kind === 'variant') return { symbol: tile.variant.symbol, logoURI: tile.variant.logoURI, variantCount: 0 };
    return { symbol: tile.asset.symbol, logoURI: tile.asset.logoURI, variantCount: tile.asset.variants.length };
}

/** Stacked-layers glyph for the variant count: one path, where an icon component would cost four nodes per tile. */
function VariantsGlyph() {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="size-[11px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
        >
            <path d="M6 1.5 10.5 4 6 6.5 1.5 4ZM1.5 6.2 6 8.7l4.5-2.5M1.5 8.4 6 10.9l4.5-2.5" />
        </svg>
    );
}

/**
 * Layout classes for the tile element itself. The tile is the flex container, so a label costs no
 * wrapper element: a big view mounts hundreds of these and style work scales with element count.
 */
const DETAIL_CLASS: Record<Detail, string> = {
    full: 'flex flex-col items-center justify-center gap-[0.18em] px-1.5 text-center leading-none',
    change: 'flex flex-col items-center justify-center gap-[0.18em] px-1.5 text-center leading-none',
    symbol: 'flex items-center justify-center px-0.5 font-semibold leading-none',
    none: 'block',
};

function TileContent({
    tile,
    detail,
    period,
    inkMuted,
}: {
    tile: Exclude<LayoutTile, { kind: 'more' }>;
    detail: Detail;
    period: HeatmapPeriod;
    inkMuted: string;
}) {
    if (detail === 'none') return null;

    const { w, h } = tile.rect;
    const face = faceFor(tile);
    // Size text to the tile from estimated glyph widths: cheaper than measuring a few hundred
    // labels, and `truncate` catches whatever the estimate gets wrong.
    const fitWidth = (w - 14) / labelWidthEm(face.symbol);

    if (detail === 'symbol') {
        return (
            <span className="max-w-full truncate" style={{ fontSize: clamp(Math.min(fitWidth, h * 0.6), 9, 12) }}>
                {face.symbol}
            </span>
        );
    }

    const change = formatChange(tileChange(tile, period));
    const symbolSize = clamp(Math.min(fitWidth, h * (detail === 'full' ? 0.2 : 0.3)), 11, 34);
    const changeSize = clamp(Math.min(symbolSize * 0.7, (w - 10) / (change.length * 0.58)), 9, 20);

    return (
        <>
            {detail === 'full' && face.logoURI ? (
                <TileLogo src={face.logoURI} alt="" size={Math.round(clamp(Math.min(w, h) * 0.2, 20, 44))} />
            ) : null}
            <span className="max-w-full truncate font-semibold" style={{ fontSize: symbolSize }}>
                {face.symbol}
            </span>
            <span className="font-medium tabular-nums" style={{ fontSize: changeSize }}>
                {change}
            </span>
            {detail === 'full' ? (
                <span className="tabular-nums" style={{ fontSize: clamp(changeSize * 0.82, 10, 14), color: inkMuted }}>
                    {formatVolume(tile.value)}
                </span>
            ) : null}
            {face.variantCount > 1 && (detail === 'full' || (w >= 76 && h >= 58)) ? (
                <span
                    className="absolute right-1.5 top-1.5 flex items-center gap-0.5 text-[10px] font-medium leading-none tabular-nums"
                    style={{ color: inkMuted }}
                >
                    <VariantsGlyph />
                    {face.variantCount}
                </span>
            ) : null}
        </>
    );
}

export interface HeatmapTileProps {
    tile: LayoutTile;
    period: HeatmapPeriod;
    onOpenAsset: (assetId: string) => void;
    onOpenSector: (sectorId: string) => void;
}

export const HeatmapTile = memo(function HeatmapTile({ tile, period, onOpenAsset, onOpenSector }: HeatmapTileProps) {
    const { x, y, w, h } = tile.rect;
    const box: CSSProperties = { left: x, top: y, width: w, height: h };
    const shared = { 'data-tile': tile.key, 'aria-label': tileAriaLabel(tile, period) };

    if (tile.kind === 'more') {
        const roomy = w >= 44 && h >= 30;
        return (
            <button
                type="button"
                {...shared}
                className={`${TILE_CLASS} block border border-dashed border-gray-1400/30 bg-white text-text-low`}
                style={box}
                onClick={() => onOpenSector(tile.groupId)}
            >
                {w >= 26 && h >= 14 ? (
                    <span className="flex size-full flex-col items-center justify-center text-[10px] font-semibold leading-tight">
                        <span>+{tile.count}</span>
                        {roomy ? <span className="font-normal">more</span> : null}
                    </span>
                ) : null}
            </button>
        );
    }

    const bin = changeBin(tileChange(tile, period), period);
    const style: CSSProperties = bin
        ? { ...box, background: bin.fill, color: bin.ink }
        : {
              ...box,
              color: NO_DATA_INK,
              background: `repeating-linear-gradient(135deg, ${NO_DATA_HATCH} 0 2px, transparent 2px 7px), ${NO_DATA_FILL}`,
          };
    const detail = detailFor(w, h);
    const className = `${TILE_CLASS} ${DETAIL_CLASS[detail]}`;
    const content: ReactNode = (
        <TileContent tile={tile} detail={detail} period={period} inkMuted={bin?.inkMuted ?? NO_DATA_INK} />
    );

    if (tile.kind === 'variant') {
        if (!tile.variant.hasTokenPage) {
            return (
                <div {...shared} role="img" tabIndex={0} className={className} style={style}>
                    {content}
                </div>
            );
        }

        return (
            <Link href={`/token/${tile.variant.mint}`} prefetch={false} {...shared} className={className} style={style}>
                {content}
            </Link>
        );
    }

    if (tile.asset.variants.length > 1) {
        return (
            <button
                type="button"
                {...shared}
                className={className}
                style={style}
                onClick={() => onOpenAsset(tile.asset.assetId)}
            >
                {content}
            </button>
        );
    }

    return (
        <Link
            href={buildCoinHref(tile.asset.assetId, undefined)}
            prefetch={false}
            {...shared}
            className={className}
            style={style}
        >
            {content}
        </Link>
    );
});
