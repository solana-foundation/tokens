'use client';

import Image from 'next/image';
import Link from 'next/link';
import { memo, useState, type CSSProperties, type ReactNode } from 'react';
import { Layers } from 'lucide-react';

import { buildCoinHref } from '@/lib/coin-href';
import { changeBin, NO_DATA_FILL, NO_DATA_HATCH, NO_DATA_INK } from '../lib/color';
import { formatChange, formatVolume, tileAriaLabel, tileChange } from '../lib/labels';
import type { LayoutTile } from '../lib/treemap';
import type { HeatmapPeriod } from '../lib/types';

const TILE_CLASS =
    'absolute block overflow-hidden rounded-[3px] text-left outline-none transition-[filter] duration-150 hover:z-10 hover:brightness-[1.06] hover:ring-2 hover:ring-gray-1400/70 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-gray-1400';

/** What a tile has room to say. Below `symbol` it is colour only and relies on the tooltip. */
type Detail = 'full' | 'change' | 'symbol' | 'none';

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
            width={40}
            height={40}
            className="shrink-0 rounded-full bg-white/80 object-cover"
            style={{ width: size, height: size }}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            referrerPolicy="no-referrer"
        />
    );
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

function TileContent({
    tile,
    period,
    inkMuted,
}: {
    tile: Exclude<LayoutTile, { kind: 'more' }>;
    period: HeatmapPeriod;
    inkMuted: string;
}) {
    const { w, h } = tile.rect;
    const detail = detailFor(w, h);
    if (detail === 'none') return null;

    const face = faceFor(tile);
    const change = formatChange(tileChange(tile, period));
    // Size text to the tile from estimated glyph widths: cheaper than measuring a few hundred
    // labels, and `truncate` catches whatever the estimate gets wrong.
    const fitWidth = (w - 14) / labelWidthEm(face.symbol);

    if (detail === 'symbol') {
        return (
            <span
                className="flex size-full items-center justify-center px-0.5 font-semibold leading-none"
                style={{ fontSize: clamp(Math.min(fitWidth, h * 0.6), 9, 12) }}
            >
                <span className="truncate">{face.symbol}</span>
            </span>
        );
    }

    const symbolSize = clamp(Math.min(fitWidth, h * (detail === 'full' ? 0.2 : 0.3)), 11, 34);
    const changeSize = clamp(Math.min(symbolSize * 0.7, (w - 10) / (change.length * 0.58)), 9, 20);

    return (
        <span className="flex size-full flex-col items-center justify-center gap-[0.18em] px-1.5 text-center leading-none">
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
                    <Layers aria-hidden="true" className="size-[11px]" />
                    {face.variantCount}
                </span>
            ) : null}
        </span>
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
                className={`${TILE_CLASS} border border-dashed border-gray-1400/30 bg-white text-text-low`}
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
    const content: ReactNode = <TileContent tile={tile} period={period} inkMuted={bin?.inkMuted ?? NO_DATA_INK} />;

    if (tile.kind === 'variant') {
        if (!tile.variant.hasTokenPage) {
            return (
                <div {...shared} role="img" tabIndex={0} className={TILE_CLASS} style={style}>
                    {content}
                </div>
            );
        }

        return (
            <Link
                href={`/token/${tile.variant.mint}`}
                prefetch={false}
                {...shared}
                className={TILE_CLASS}
                style={style}
            >
                {content}
            </Link>
        );
    }

    if (tile.asset.variants.length > 1) {
        return (
            <button
                type="button"
                {...shared}
                className={TILE_CLASS}
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
            className={TILE_CLASS}
            style={style}
        >
            {content}
        </Link>
    );
});
