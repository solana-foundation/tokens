'use client';

import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import {
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type Ref,
} from 'react';
import { createPortal } from 'react-dom';

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

// Styling mirrors the token page's variants hover card (token-variants-badge.tsx, dark appearance).
const PILL_CLASS = 'shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-[var(--tooltip-text)]/80';
const HINT_CLASS = 'px-2 pt-1 pb-1.5 text-[11px] font-medium text-white/50';

function Logo({ src, symbol }: { src?: string; symbol: string }) {
    const [failed, setFailed] = useState(false);
    if (!src || failed) {
        return (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold text-[var(--tooltip-text)]">
                {symbol.slice(0, 2).toUpperCase()}
            </div>
        );
    }
    return (
        <Image
            src={src}
            alt=""
            // Same request size as the tiles, so the logo is already in the browser cache.
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-full bg-white/10 object-cover"
            onError={() => setFailed(true)}
            referrerPolicy="no-referrer"
        />
    );
}

interface HeaderProps {
    logo?: string;
    name: string;
    symbol: string;
    tag?: string;
    /** Clicking the tile leaves the map for a token or asset page. */
    opensPage?: boolean;
}

function Header({ logo, name, symbol, tag, opensPage }: HeaderProps) {
    return (
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <Logo key={logo ?? symbol} src={logo} symbol={symbol} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={PILL_CLASS}>${symbol}</span>
                    {tag ? <span className={`${PILL_CLASS} border border-white/10`}>{tag}</span> : null}
                </div>
            </div>
            {opensPage ? (
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 self-start text-white/50" />
            ) : null}
        </div>
    );
}

function Stats({ children }: { children: ReactNode }) {
    return <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 px-2 pt-1 pb-2 text-xs">{children}</dl>;
}

function ChangeRow({ label, change, period }: { label: string; change: number | null; period: HeatmapPeriod }) {
    const bin = changeBin(change, period);
    return (
        <>
            <dt className="text-white/50">{label}</dt>
            <dd className="flex items-center justify-end gap-1.5 font-sans tabular-nums text-white">
                <span
                    aria-hidden="true"
                    className="size-2 rounded-[2px] border border-white/20"
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
            <dt className="text-white/50">{label}</dt>
            <dd className="text-right font-sans tabular-nums text-white">{value}</dd>
        </>
    );
}

function TooltipBody({ tile }: { tile: LayoutTile }) {
    if (tile.kind === 'more') {
        return (
            <>
                <div className="px-2 pt-2 text-sm font-medium text-white">+{tile.count} more</div>
                <p className={HINT_CLASS}>Too small to draw here. Click to open the category.</p>
            </>
        );
    }

    if (tile.kind === 'variant') {
        const { variant } = tile;
        return (
            <>
                <Header
                    logo={variant.logoURI}
                    name={variant.name}
                    symbol={variant.symbol}
                    tag={variant.groupLabel}
                    opensPage={variant.hasTokenPage}
                />
                <Stats>
                    <Row label="Price" value={formatPrice(variant.price)} />
                    <ChangeRow label="24h" change={variant.change24h} period="24h" />
                    <ChangeRow label="1h" change={variant.change1h} period="1h" />
                    <Row label="24h volume" value={formatVolume(variant.volume24h)} />
                    <Row label="On-Solana value" value={formatUsdCompact(variant.marketCap)} />
                    <Row label="Liquidity" value={formatUsdCompact(variant.liquidity)} />
                </Stats>
            </>
        );
    }

    const { asset } = tile;
    const drills = asset.variants.length > 1;
    return (
        <>
            <Header
                logo={asset.logoURI}
                name={asset.name}
                symbol={asset.symbol}
                tag={drills ? `${asset.variants.length} variants` : undefined}
                opensPage={!drills}
            />
            <Stats>
                <Row label="Price" value={formatPrice(asset.price)} />
                <ChangeRow label="24h" change={asset.change24h} period="24h" />
                <ChangeRow label="1h" change={asset.change1h} period="1h" />
                <Row label="24h volume" value={formatVolume(asset.volume24h)} />
                <Row label={marketCapLabel(asset)} value={formatUsdCompact(asset.marketCap)} />
            </Stats>
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
        // Hidden: nothing to place, and measuring would force a layout in the middle of a zoom.
        if (tile) place();
    }, [tile, place]);

    // Rendered into <body>: inside the market feed, the popup's transform and the panel's backdrop-filter
    // make `position: fixed` relative to them instead of the viewport, which threw the card off-screen.
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    useEffect(() => setPortalTarget(document.body), []);
    if (!portalTarget) return null;

    return createPortal(
        <div
            ref={elementRef}
            role="tooltip"
            className="pointer-events-none fixed left-0 top-0 z-50 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border-strong bg-[var(--tooltip-bg)] p-1 text-[var(--tooltip-text)] shadow-[0_16px_48px_rgba(0,0,0,0.12)]"
            style={{ visibility: tile ? 'visible' : 'hidden' }}
        >
            {tile ? <TooltipBody tile={tile} /> : null}
        </div>,
        portalTarget,
    );
}
