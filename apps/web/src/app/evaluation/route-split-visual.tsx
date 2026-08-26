'use client';

import * as React from 'react';
import { Ellipsis } from 'lucide-react';
import { motion } from 'motion/react';

import { colorFromTokenImage } from '../assets-api/demos/wallet-demo-data';
import { usePrimaryVariantColors } from '../assets-api/demos/use-primary-variant-colors';
import type { ExecutionRouteResponse } from '@/hooks/queries/use-execution-route';
import { formatExecutionRouterLabel } from '@/lib/execution-quote-format';
import { getTokenLogoURLForMintWithSecondarySymbol } from '@/lib/logo-overrides';

const STACK_EASE = [0.32, 0.72, 0, 1] as const;
const STACK_TRANSITION = { duration: 0.24, ease: STACK_EASE };
const PRESS_TRANSITION = { duration: 0.14, ease: STACK_EASE };
const COLLAPSED_Y = [22, 46, 64, 82, 96, 108] as const;
const COLLAPSED_FADE = [0.82, 0.48, 0.22, 0.1, 0.04, 0] as const;
const COLLAPSED_CONTENT_OPACITY = [0.56, 0.18, 0.06, 0, 0, 0] as const;
const ROW_HEIGHT = 72;
const EXPANDED_ROW_GAP = 76;
const EXPANDED_FIRST_ROW_Y = 112;
const FRAME_Y = 92;

interface SplitLeg {
    id: string;
    name: string;
    symbol: string;
    logoUrl: string;
    /** Local override to try when the remote logo fails to load. */
    fallbackLogoUrl: string;
    weight: number;
    amountLabel: string;
    detailLabel: string;
    muted: boolean;
}

interface SplitModel {
    assetName: string;
    assetSymbol: string;
    assetLogoUrl: string;
    totalLabel: string;
    targetLabel: string;
    legs: SplitLeg[];
}

function formatUsdCompact(value: number): string {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1_000_000) return `$${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
    if (value >= 10_000) return `$${Math.round(value / 1_000).toLocaleString('en-US')}K`;
    return `$${value.toLocaleString('en-US')}`;
}

/** The live route response, reshaped for the stacked-card visual. */
function buildSplitModel(args: {
    data: ExecutionRouteResponse;
    asset: { name: string; symbol: string; logoUrl: string } | null;
    logoByMint: ReadonlyMap<string, string>;
}): SplitModel | null {
    const allocation = args.data.allocation;
    if (!allocation || allocation.legs.length === 0) return null;
    const target = Number(allocation.targetUsd);
    const unallocated = Number(allocation.unallocatedUsd);
    const variantByMint = new Map(args.data.variants.map(variant => [variant.mint, variant]));

    const legs: SplitLeg[] = allocation.legs.map(leg => {
        const variant = variantByMint.get(leg.mint);
        const provider = leg.provider === 'titan' ? 'Titan' : leg.provider === 'jupiter' ? 'Jupiter' : '—';
        const router = leg.router ? ` · ${formatExecutionRouterLabel(leg.router)}` : '';
        // The distinctive remote logo leads (legs must be tellable apart); a
        // local override backs it up when the remote host is flaky (ipfs
        // gateways), then a letter avatar.
        const remoteLogo = args.logoByMint.get(leg.mint) ?? '';
        const overrideLogo =
            getTokenLogoURLForMintWithSecondarySymbol(leg.mint, leg.symbol, args.asset?.symbol, undefined) ?? '';
        return {
            id: leg.mint,
            name: variant?.name ?? leg.symbol,
            symbol: `${provider}${router}${leg.shareConfidence === 'soft' ? ' · size may move' : ''}`,
            logoUrl: remoteLogo || overrideLogo,
            fallbackLogoUrl: overrideLogo !== remoteLogo ? overrideLogo : '',
            weight: Number(leg.amountUsd) / (target || 1),
            amountLabel: formatUsdCompact(Number(leg.amountUsd)),
            detailLabel: `${Math.round(leg.shareOfTarget * 1000) / 10}% · ${leg.symbol}`,
            muted: false,
        };
    });
    if (unallocated > 0) {
        legs.push({
            id: 'unallocated',
            name: 'Unallocated',
            symbol: 'beyond proven depth at this size',
            logoUrl: '',
            fallbackLogoUrl: '',
            weight: unallocated / (target || 1),
            amountLabel: formatUsdCompact(unallocated),
            detailLabel: `${Math.round((unallocated / (target || 1)) * 1000) / 10}%`,
            muted: true,
        });
    }

    return {
        assetName: args.asset?.name ?? args.data.assetId,
        assetSymbol: args.asset?.symbol ?? args.data.assetId,
        // The canonical card shows the asset's own image from the API return.
        assetLogoUrl: args.asset?.logoUrl ?? '',
        totalLabel: allocation.totalExpectedOut
            ? `${Number(allocation.totalExpectedOut.amount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${allocation.outputUnit.symbol}`
            : '—',
        targetLabel: `${formatUsdCompact(target)} routed`,
        legs,
    };
}

/**
 * The split, drawn: canonical asset card whose composition bar is the actual
 * leg allocation, fanning out into one card per leg. Adapted from the
 * assets-api wallet demo, wired to live /route data.
 */
export function RouteSplitVisual({
    data,
    isPending,
    asset,
    logoByMint,
}: {
    data: ExecutionRouteResponse | null;
    isPending: boolean;
    asset: { name: string; symbol: string; logoUrl: string } | null;
    logoByMint: ReadonlyMap<string, string>;
}) {
    const model = React.useMemo(
        () => (data ? buildSplitModel({ data, asset, logoByMint }) : null),
        [data, asset, logoByMint],
    );
    const [expanded, setExpanded] = React.useState(true);
    if (!model) return null;

    const stackHeight = expanded
        ? EXPANDED_FIRST_ROW_Y + Math.max(1, model.legs.length) * EXPANDED_ROW_GAP + 24
        : ROW_HEIGHT + (COLLAPSED_Y[Math.min(model.legs.length, COLLAPSED_Y.length) - 1] ?? 82) + 24;

    return (
        <section
            className={`relative mb-4 overflow-hidden rounded-[24px] border border-black/60 bg-[#0a0a0b] px-5 py-6 shadow-[0_8px_40px_rgba(0,0,0,0.18)] transition-opacity ${isPending ? 'opacity-60' : ''}`}
        >
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                    backgroundImage: 'radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px)',
                    backgroundSize: '18px 18px',
                }}
            />
            <motion.div
                className="relative mx-auto w-full max-w-[520px]"
                initial={false}
                animate={{ height: stackHeight }}
                transition={STACK_TRANSITION}
            >
                <SplitStack model={model} expanded={expanded} onToggleExpanded={() => setExpanded(value => !value)} />
            </motion.div>
        </section>
    );
}

interface StackRow {
    kind: 'canonical' | 'leg';
    key: string;
    transform: string;
    fade: number;
    contentOpacity: number;
    legIndex?: number;
    insetClassName?: string;
    leg?: SplitLeg;
}

function SplitStack({
    model,
    expanded,
    onToggleExpanded,
}: {
    model: SplitModel;
    expanded: boolean;
    onToggleExpanded: () => void;
}) {
    const colorInputs = React.useMemo(
        () =>
            model.legs.map(leg => ({
                id: leg.id,
                name: leg.name,
                symbol: leg.symbol,
                logoUrl: leg.logoUrl,
                balanceLabel: leg.amountLabel,
                accountLabel: leg.detailLabel,
            })),
        [model.legs],
    );
    const sampledColors = usePrimaryVariantColors(colorInputs);
    // Logo-less legs would all hash the empty string to one color; hash the
    // mint instead so every leg stays distinguishable.
    const segmentColor = (leg: SplitLeg, index: number): string =>
        leg.muted
            ? 'rgba(255,255,255,0.16)'
            : leg.logoUrl
              ? (sampledColors[index] ?? colorFromTokenImage(leg.id))
              : colorFromTokenImage(leg.id);
    const rows = React.useMemo(() => buildStackRows(model.legs, expanded), [model.legs, expanded]);
    const [pressedRowKey, setPressedRowKey] = React.useState<string | null>(null);
    const [hoveredLegIndex, setHoveredLegIndex] = React.useState<number | null>(null);

    return (
        <div className="relative h-full">
            <SplitFrame expanded={expanded} itemCount={model.legs.length} />
            {rows.map(row => {
                const rowOpacity =
                    row.kind === 'leg' && hoveredLegIndex !== null && hoveredLegIndex !== row.legIndex ? 0.28 : 1;
                return (
                    <RowTransformShell key={row.key} row={row} isPressed={pressedRowKey === row.key}>
                        <motion.div
                            className="relative flex items-center overflow-hidden rounded-[22px] px-4 shadow-[0_24px_80px_rgba(0,0,0,0.42)] ring-[2px] ring-inset ring-black/40 backdrop-blur-xl"
                            initial={false}
                            animate={{
                                opacity: rowOpacity,
                                backgroundColor: `rgba(255,255,255,${0.06 * row.fade})`,
                                borderColor: `rgba(255,255,255,${0.06 * row.fade})`,
                            }}
                            transition={STACK_TRANSITION}
                            style={{ borderWidth: 1, borderStyle: 'solid', height: ROW_HEIGHT }}
                        >
                            {row.kind === 'canonical' ? <CanonicalCardOverlay /> : null}
                            <TokenImageWash
                                src={row.kind === 'canonical' ? model.assetLogoUrl : row.leg!.logoUrl}
                                variant={row.kind === 'canonical' ? 'canonical' : 'variant'}
                            />
                            <div className={`relative z-10 w-full ${row.kind === 'canonical' ? 'mt-1' : ''}`}>
                                {row.kind === 'canonical' ? (
                                    <CanonicalRow
                                        model={model}
                                        expanded={expanded}
                                        segmentColors={model.legs.map(segmentColor)}
                                        hoveredLegIndex={hoveredLegIndex}
                                        onToggleExpanded={onToggleExpanded}
                                        onPressChange={pressed => setPressedRowKey(pressed ? row.key : null)}
                                        onHoverLegChange={setHoveredLegIndex}
                                    />
                                ) : (
                                    <LegRow leg={row.leg!} contentOpacity={row.contentOpacity} />
                                )}
                            </div>
                        </motion.div>
                    </RowTransformShell>
                );
            })}
        </div>
    );
}

function SplitFrame({ expanded, itemCount }: { expanded: boolean; itemCount: number }) {
    return (
        <motion.div
            className="absolute inset-x-0 rounded-[26px] px-3 pt-2 shadow-[0_20px_70px_rgba(0,0,0,0.28)] backdrop-blur-xl"
            initial={false}
            animate={{
                opacity: expanded ? 1 : 0,
                transform: expanded
                    ? `translateY(${FRAME_Y}px) scale(1) translateZ(0)`
                    : `translateY(${FRAME_Y + 14}px) scale(0.98) translateZ(0)`,
                height: expanded ? 110 + Math.max(0, itemCount - 1) * EXPANDED_ROW_GAP : ROW_HEIGHT,
            }}
            transition={STACK_TRANSITION}
            style={{ pointerEvents: 'none', transformOrigin: 'top center' }}
        >
            <svg className="absolute inset-0 h-full w-full" aria-hidden>
                <rect
                    x="0.5"
                    y="0.5"
                    width="calc(100% - 1px)"
                    height="calc(100% - 1px)"
                    rx="26"
                    fill="none"
                    stroke="rgba(255,255,255,0.14)"
                    strokeWidth="1"
                    strokeDasharray="14 10"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-md border border-white/10 bg-[#121213] px-3 py-1 font-berkeley-mono text-[11px] uppercase leading-none tracking-[0.16em] text-white/44">
                Route Split
            </div>
        </motion.div>
    );
}

function TokenImageWash({ src, variant }: { src: string; variant: 'canonical' | 'variant' }) {
    const [failed, setFailed] = React.useState(false);
    if (!src || failed) return null;
    return (
        <img
            src={src}
            alt=""
            aria-hidden
            onError={() => setFailed(true)}
            className={`pointer-events-none absolute left-[-18px] top-1/2 z-[1] -translate-y-1/2 rounded-full object-cover blur-2xl ${
                variant === 'canonical' ? 'size-[108px] opacity-22' : 'size-[88px] opacity-18'
            }`}
        />
    );
}

function CanonicalCardOverlay() {
    return (
        <>
            <div
                className="pointer-events-none absolute inset-0 z-0 size-full opacity-30 dark:opacity-20"
                style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='6' height='6' viewBox='0 0 6 6' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='2' cy='2' r='1' fill='rgba(255,250,250,0.2)'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'repeat',
                }}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-full w-full bg-gradient-to-t from-zinc-950/0 via-zinc-900/55 to-zinc-900/68" />
        </>
    );
}

function RowTransformShell({
    row,
    isPressed,
    children,
}: {
    row: StackRow;
    isPressed: boolean;
    children: React.ReactNode;
}) {
    return (
        <motion.div
            className={`absolute will-change-transform ${row.insetClassName ?? 'inset-x-0'}`}
            initial={false}
            animate={{ transform: row.transform }}
            transition={STACK_TRANSITION}
            style={{ transformOrigin: 'top center' }}
        >
            <motion.div
                className="h-full"
                initial={false}
                animate={{ transform: isPressed ? 'scale(0.98) translateZ(0)' : 'scale(1) translateZ(0)' }}
                transition={PRESS_TRANSITION}
                style={{ transformOrigin: 'center' }}
            >
                {children}
            </motion.div>
        </motion.div>
    );
}

function buildStackRows(legs: ReadonlyArray<SplitLeg>, expanded: boolean): StackRow[] {
    const legRows = legs
        .map((leg, index) => {
            const y = expanded ? EXPANDED_FIRST_ROW_Y + index * EXPANDED_ROW_GAP : (COLLAPSED_Y[index] ?? 108);
            const scale = expanded ? 1 : 1 - 0.035 * (index + 1);
            return {
                kind: 'leg' as const,
                key: leg.id,
                transform: `translateY(${y}px) scale(${scale}) translateZ(0)`,
                fade: expanded ? 0.78 : (COLLAPSED_FADE[index] ?? 0),
                contentOpacity: expanded ? 1 : (COLLAPSED_CONTENT_OPACITY[index] ?? 0),
                legIndex: index,
                insetClassName: expanded ? 'left-4 right-4' : 'inset-x-0',
                leg,
            };
        })
        .reverse();

    return [
        ...legRows,
        {
            kind: 'canonical',
            key: 'canonical',
            transform: 'translateY(0px) scale(1) translateZ(0)',
            fade: 1,
            contentOpacity: 1,
            insetClassName: 'inset-x-0',
        },
    ];
}

function CanonicalRow({
    model,
    expanded,
    segmentColors,
    hoveredLegIndex,
    onToggleExpanded,
    onPressChange,
    onHoverLegChange,
}: {
    model: SplitModel;
    expanded: boolean;
    segmentColors: string[];
    hoveredLegIndex: number | null;
    onToggleExpanded: () => void;
    onPressChange: (pressed: boolean) => void;
    onHoverLegChange: (index: number | null) => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggleExpanded}
            onPointerDown={() => onPressChange(true)}
            onPointerCancel={() => onPressChange(false)}
            onPointerLeave={() => onPressChange(false)}
            onPointerUp={() => onPressChange(false)}
            onBlur={() => onPressChange(false)}
            className="h-full w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-expanded={expanded}
        >
            <div className="flex translate-y-[-1px] items-center gap-3.5">
                <AssetIcon src={model.assetLogoUrl} symbol={model.assetSymbol} />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium leading-6 text-white">{model.assetName}</div>
                    <div className="mt-1.5 w-2/3">
                        <SplitBar
                            segments={model.legs.map((leg, index) => ({
                                weight: leg.weight,
                                color: segmentColors[index]!,
                            }))}
                            hoveredIndex={hoveredLegIndex}
                            onHoverSegment={onHoverLegChange}
                        />
                    </div>
                </div>
                <div className="shrink-0 text-right">
                    <div className="text-[14px] font-medium text-white">{model.totalLabel}</div>
                    <div className="mt-0.5 text-[12px] font-medium text-white/52">{model.targetLabel}</div>
                </div>
                <Ellipsis className="size-5 shrink-0 rotate-90 text-white/44" strokeWidth={2.5} aria-hidden />
            </div>
        </button>
    );
}

function LegRow({ leg, contentOpacity }: { leg: SplitLeg; contentOpacity: number }) {
    return (
        <motion.div
            className="flex h-full items-center justify-between gap-4"
            initial={false}
            animate={{ opacity: contentOpacity }}
            transition={{ duration: 0.18, ease: STACK_EASE }}
        >
            <div className="flex min-w-0 items-center gap-3.5">
                <LegIcon src={leg.logoUrl} fallbackSrc={leg.fallbackLogoUrl} symbol={leg.name} muted={leg.muted} />
                <div className="min-w-0">
                    <div
                        className={`truncate text-[13px] font-medium leading-5 ${leg.muted ? 'text-white/48' : 'text-white/92'}`}
                    >
                        {leg.name}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] font-medium text-white/44">{leg.symbol}</div>
                </div>
            </div>
            <div className="shrink-0 text-right">
                <div className={`text-[13px] font-medium ${leg.muted ? 'text-white/48' : 'text-white/86'}`}>
                    {leg.amountLabel}
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-white/44">{leg.detailLabel}</div>
            </div>
        </motion.div>
    );
}

function AssetIcon({ src, symbol }: { src: string; symbol: string }) {
    const [failed, setFailed] = React.useState(false);
    if (src && !failed) {
        return (
            <img
                src={src}
                alt=""
                onError={() => setFailed(true)}
                className="size-[42px] shrink-0 rounded-[14px] border-2 border-black/90 bg-white object-cover"
            />
        );
    }
    return (
        <div className="flex size-[42px] shrink-0 items-center justify-center rounded-[14px] bg-white/[0.06] text-[20px] font-semibold text-white/70">
            {symbol.slice(0, 1) || '$'}
        </div>
    );
}

function SplitBar({
    segments,
    hoveredIndex,
    onHoverSegment,
}: {
    segments: ReadonlyArray<{ weight: number; color: string }>;
    hoveredIndex: number | null;
    onHoverSegment: (index: number | null) => void;
}) {
    const normalized = normalizeSegments(segments);
    return (
        <div className="flex h-[8px] w-full max-w-[200px] gap-1.5" onPointerLeave={() => onHoverSegment(null)}>
            {normalized.map((segment, index) => (
                <div
                    key={index}
                    className="h-full min-w-2 rounded-full border-[0.5px] border-white/20 ring ring-black/80 backdrop-blur-xl"
                    onPointerEnter={() => onHoverSegment(index)}
                    style={{
                        flexGrow: segment.weight,
                        backgroundColor: segment.color,
                        opacity: hoveredIndex === null || hoveredIndex === index ? 1 : 0.3,
                        transition: 'opacity 160ms cubic-bezier(0.23, 1, 0.32, 1)',
                    }}
                />
            ))}
        </div>
    );
}

function normalizeSegments(segments: ReadonlyArray<{ weight: number; color: string }>) {
    const cleaned = segments
        .map(segment => ({
            weight: Number.isFinite(segment.weight) ? Math.max(0, segment.weight) : 0,
            color: segment.color,
        }))
        .filter(segment => segment.weight > 0);
    const sum = cleaned.reduce((acc, segment) => acc + segment.weight, 0);
    if (sum <= 0) return [];
    return cleaned.map(segment => ({ ...segment, weight: segment.weight / sum }));
}

function LegIcon({
    src,
    fallbackSrc,
    symbol,
    muted,
}: {
    src: string;
    fallbackSrc: string;
    symbol: string;
    muted: boolean;
}) {
    // Remote logo → local override → letter avatar.
    const candidates = [src, fallbackSrc].filter(Boolean);
    const [candidateIndex, setCandidateIndex] = React.useState(0);
    const activeSrc = candidates[candidateIndex];
    return (
        <div
            className={`flex size-[34px] shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-black/80 backdrop-blur-xl ${muted ? 'border-dashed border-white/20 bg-transparent' : 'bg-white/[0.06]'}`}
        >
            {activeSrc ? (
                <img
                    key={activeSrc}
                    src={activeSrc}
                    alt=""
                    onError={() => setCandidateIndex(index => index + 1)}
                    className="h-full w-full object-cover"
                />
            ) : (
                <span className="text-[13px] font-semibold text-white/60">{symbol.slice(0, 1)}</span>
            )}
        </div>
    );
}
