'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Effect } from 'effect';
import { ChevronDown } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import { Drawer, DrawerClose, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@tokens/ui/drawer';
import { HoverCard, HoverCardArrow, HoverCardContent, HoverCardTrigger } from '@tokens/ui/hover-card';
import type { VariantHub } from '@tokens/asset-registry';
import { getVariantByMint, type VariantKind } from '@tokens/asset-registry';
import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import { SOL_MINT, isPreIpoVariant } from '@/lib/asset-variant-categories';
import { getMintLogoOverride } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { apiJson } from '@/effect/api-client';
import { trackEvent } from '@/lib/posthog-client';
import { formatUsd } from '../lib/format';
import { IconChevronRight, IconCircleDottedAndCircle, IconDrop } from 'symbols-react';

interface TokenVariantsBadgeProps {
    group: VariantHub;
    currentAddress: string;
    linkMode?: 'token' | 'coingecko';
    coingeckoCoinId?: string;
}

function getAddressLabel(group: VariantHub, address: string): string | undefined {
    return group.addresses.find(item => item.address === address)?.label;
}

function normalizeVariantBadgeLabel(label: string | undefined): string | undefined {
    const trimmed = label?.trim();
    if (!trimmed) return undefined;
    if (trimmed === 'xStock') return 'xStocks';
    return trimmed;
}

function normalizeOptionalText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '???') return '';
    if (trimmed === '—') return '';
    if (trimmed.toLowerCase() === 'unknown') return '';
    return trimmed;
}

function isLikelyTickerSymbol(value: string): boolean {
    return /^[A-Z0-9_]{2,16}$/.test(value.trim().toUpperCase());
}

function normalizeBadgeToken(value: string): string {
    return value.trim().replace(/^\$/, '').replace(/\s+/g, '').toUpperCase();
}

function extractFallbackSymbolFromLabel(label: string | undefined): string | undefined {
    const generic = new Set(['SPDR', 'ISHARES', 'ONDO', 'XSTOCK', 'XSTOCKS']);
    const trimmed = label?.trim() ?? '';
    if (!trimmed) return undefined;
    const firstToken = trimmed.split(/[\s(]/)[0]?.trim() ?? '';
    if (!firstToken) return undefined;
    const cleaned = firstToken.replace(/[^a-z0-9_]/gi, '').trim();
    if (!cleaned) return undefined;
    const upper = cleaned.toUpperCase();
    if (generic.has(upper)) return undefined;
    if (!isLikelyTickerSymbol(upper)) return undefined;
    return upper;
}

interface VariantMarketSnapshot {
    liquidity: number | null;
    decimals: number | null;
    logoURI?: string | null;
}

interface VariantRow {
    mint: string;
    kind?: VariantKind;
    symbol?: string;
    name?: string;
    label?: string;
    market: VariantMarketSnapshot | null;
    /** `{ status, reason, url, since } | null`; `/variants` keeps `blocked` rows visible. */
    advisory?: unknown;
}

interface AssetVariantsResponse {
    assetId: string;
    variants: VariantRow[];
}

interface VariantListItem {
    address: string;
    symbol: string;
    name: string;
    label?: string;
    decimals: number;
    logoURI?: string;
    liquidity: number;
    kind?: VariantKind;
    isPreIpo?: boolean;
    advisory?: AssetAdvisory | null;
}

type VariantsPanelAppearance = 'dark' | 'light';

function TokenLogo({ token, appearance = 'dark' }: { token: VariantListItem; appearance?: VariantsPanelAppearance }) {
    const [hasError, setHasError] = React.useState(false);

    const symbol = token.symbol || token.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const resolvedLogoURI = normalizeLogoSrc((token.logoURI ?? '').trim() || undefined);
    const isLight = appearance === 'light';

    if (!resolvedLogoURI || hasError) {
        return (
            <div
                className={cn(
                    'flex size-10 items-center justify-center rounded-full text-[10px] font-bold',
                    isLight ? 'bg-sand-200 text-sand-700' : 'bg-white/10 text-[var(--tooltip-text)]',
                )}
            >
                {initials}
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={40}
            height={40}
            className={cn('size-10 rounded-full object-cover', isLight ? 'bg-sand-100' : 'bg-white/10')}
            onError={() => setHasError(true)}
            loading="lazy"
        />
    );
}

const VariantsTriggerButton = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<'button'> & { isOpen: boolean; variantCountLabel: string }
>(({ isOpen: triggerOpen, variantCountLabel, className, type, 'aria-label': ariaLabel, ...props }, ref) => {
    return (
        <button
            ref={ref}
            type={type ?? 'button'}
            aria-label={ariaLabel ?? 'Open variants'}
            className={cn(
                'bg-[var(--badge-default-bg)] backdrop-blur-sm hover:cursor-crosshair px-2 py-1 text-[var(--badge-default-text)] font-medium text-xs inline-flex items-center gap-1 transition-colors cursor-crosshair rounded-full',
                className,
            )}
            {...props}
        >
            <span className="font-sans tabular-nums">{variantCountLabel}</span>
            VARIANTS
            <ChevronDown
                aria-hidden="true"
                className={cn(
                    'ml-0.5 size-3 text-[var(--badge-default-text)]/80 transition-transform duration-150 ease-out motion-reduce:transition-none',
                    triggerOpen && 'rotate-180',
                )}
            />
        </button>
    );
});
VariantsTriggerButton.displayName = 'VariantsTriggerButton';

interface VariantTokenRowProps {
    token: VariantListItem;
    group: VariantHub;
    currentAddress: string;
    routeName: string;
    closeOnSelect: boolean;
    isDrawer: boolean;
    appearance: VariantsPanelAppearance;
}

function VariantTokenRow({
    token,
    group,
    currentAddress,
    routeName,
    closeOnSelect,
    isDrawer,
    appearance,
}: VariantTokenRowProps) {
    const isLight = appearance === 'light';
    const isCurrent = token.address === currentAddress;
    const label =
        group.id === 'solana'
            ? undefined
            : normalizeVariantBadgeLabel(getAddressLabel(group, token.address) ?? token.label);
    const shouldShowLabelBadge =
        Boolean(label) && normalizeBadgeToken(label ?? '') !== normalizeBadgeToken(token.symbol);
    const href = `/${encodeURIComponent(routeName)}?solana=${encodeURIComponent(token.address)}`;

    const row = (
        <Link
            href={href}
            onClick={() =>
                trackEvent('variant_clicked', {
                    token_address: currentAddress,
                    variant_mint: token.address,
                    ...(token.symbol && token.symbol !== '???' ? { variant_symbol: token.symbol } : {}),
                    surface: isDrawer ? 'drawer' : 'hover_card',
                })
            }
            className={cn(
                'group flex items-center gap-3 rounded-xl px-2 py-2 active:scale-[0.98] transition-[color,background-color,border-color,transform] duration-200 ease-in-out',
                isLight ? 'hover:bg-sand-50' : 'hover:bg-white/5',
                isCurrent && (isLight ? 'bg-sand-100' : 'bg-white/10'),
            )}
        >
            <TokenLogo token={token} appearance={appearance} />
            <div className="min-w-0 flex-1">
                <div className="min-w-0">
                    <span className={cn('truncate text-sm font-medium', isLight ? 'text-sand-1500' : 'text-white')}>
                        {token.name}
                    </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                        className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                            isLight
                                ? 'bg-sand-200/50 text-sand-700 border border-sand-200'
                                : 'bg-white/10 text-[var(--tooltip-text)]/80',
                        )}
                    >
                        ${token.symbol}
                    </span>
                    <AssetAdvisoryBadge advisory={token.advisory} size="sm" appearance={appearance} />
                    {shouldShowLabelBadge ? (
                        <span
                            className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                                isLight
                                    ? 'bg-sand-200/50 text-sand-700 border border-sand-200'
                                    : 'bg-white/10 text-[var(--tooltip-text)]/80 border border-white/10',
                            )}
                        >
                            {label}
                        </span>
                    ) : null}
                </div>
            </div>
            <div className="shrink-0 text-right">
                <div className={cn('text-xs font-sans tabular-nums', isLight ? 'text-sand-700' : 'text-white')}>
                    {formatUsd(token.liquidity)}
                </div>
            </div>
            <IconChevronRight
                className={cn(
                    'ml-1 size-2 transition-colors',
                    isLight ? 'fill-sand-400 group-hover:fill-sand-700' : 'fill-white/40 group-hover:fill-white/80',
                )}
            />
        </Link>
    );

    if (closeOnSelect) {
        return <DrawerClose asChild>{row}</DrawerClose>;
    }

    return row;
}

function VariantsLoadingSkeleton({
    rowCount,
    appearance,
    className,
}: {
    rowCount: number;
    appearance: VariantsPanelAppearance;
    className: string;
}) {
    const isLight = appearance === 'light';

    return (
        <div className={className}>
            {Array.from({ length: rowCount }, (_, index) => (
                <div key={index} className="flex items-center gap-3 rounded-xl px-2 py-2">
                    <div className={cn('size-8 rounded-full animate-pulse', isLight ? 'bg-sand-200' : 'bg-white/10')} />
                    <div className="flex-1 space-y-1">
                        <div
                            className={cn('h-4 w-40 rounded animate-pulse', isLight ? 'bg-sand-200' : 'bg-white/10')}
                        />
                        <div className={cn('h-3 w-28 rounded animate-pulse', isLight ? 'bg-sand-100' : 'bg-white/5')} />
                    </div>
                    <div className={cn('h-4 w-20 rounded animate-pulse', isLight ? 'bg-sand-200' : 'bg-white/10')} />
                </div>
            ))}
        </div>
    );
}

interface VariantsBodyProps {
    group: VariantHub;
    tokens: VariantListItem[];
    currentAddress: string;
    assetId: string | undefined;
    coingeckoCoinId: string | undefined;
    isLoading: boolean;
    error: Error | null;
    closeOnSelect: boolean;
    isDrawer: boolean;
    appearance: VariantsPanelAppearance;
}

function VariantsBody({
    group,
    tokens,
    currentAddress,
    assetId,
    coingeckoCoinId,
    isLoading,
    error,
    closeOnSelect,
    isDrawer,
    appearance,
}: VariantsBodyProps) {
    const isLight = appearance === 'light';

    const scrollClassName = cn('space-y-1 overflow-auto', isDrawer ? 'max-h-[65dvh] px-4 pb-4' : 'max-h-72 px-1 pb-1');
    const groupedScrollClassName = cn(
        'space-y-3 overflow-auto',
        isDrawer ? 'max-h-[65dvh] px-4 pb-4' : 'max-h-72 px-1 pb-1',
    );

    if (error) {
        return (
            <div className={cn('px-2 pb-2 text-sm', isLight ? 'text-sand-700' : 'text-[var(--tooltip-text)]/80')}>
                Failed to load variants.
            </div>
        );
    }

    if (isLoading) {
        return (
            <VariantsLoadingSkeleton
                rowCount={Math.min(6, group.addresses.length)}
                appearance={appearance}
                className={scrollClassName}
            />
        );
    }

    const canonicalAssetId = (assetId ?? '').trim();
    const routeName = canonicalAssetId || (coingeckoCoinId ?? group.id).trim() || group.id;

    const renderTokenRow = (token: VariantListItem) => (
        <VariantTokenRow
            key={token.address}
            token={token}
            group={group}
            currentAddress={currentAddress}
            routeName={routeName}
            closeOnSelect={closeOnSelect}
            isDrawer={isDrawer}
            appearance={appearance}
        />
    );

    if (group.id === 'solana') {
        const nativeTokens = tokens.filter(token => token.address === SOL_MINT);
        const yieldBearingTokens = tokens.filter(token => token.address !== SOL_MINT);
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/50',
        );

        return (
            <div className={groupedScrollClassName}>
                {nativeTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Native</div>
                        <div className="space-y-1">{nativeTokens.map(renderTokenRow)}</div>
                    </div>
                )}
                {yieldBearingTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Yield-bearing</div>
                        <div className="space-y-1">{yieldBearingTokens.map(renderTokenRow)}</div>
                    </div>
                )}
            </div>
        );
    }

    if (group.id === 'bitcoin') {
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/50',
        );
        return (
            <div className={groupedScrollClassName}>
                <div>
                    <div className={sectionHeadingClassName}>Wrapped</div>
                    <div className="space-y-1">{tokens.map(renderTokenRow)}</div>
                </div>
            </div>
        );
    }

    if (group.id === 'usd') {
        const nativeTokens = tokens.filter(token => token.kind !== 'yield');
        const yieldBearingTokens = tokens.filter(token => token.kind === 'yield');
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/70',
        );

        return (
            <div className={groupedScrollClassName}>
                {nativeTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Native</div>
                        <div className="space-y-1">{nativeTokens.map(renderTokenRow)}</div>
                    </div>
                )}
                {yieldBearingTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Yield-bearing</div>
                        <div className="space-y-1">{yieldBearingTokens.map(renderTokenRow)}</div>
                    </div>
                )}
            </div>
        );
    }

    if (group.id === 'eur') {
        const nativeTokens = tokens.filter(token => token.kind !== 'yield');
        const yieldBearingTokens = tokens.filter(token => token.kind === 'yield');
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/70',
        );

        return (
            <div className={groupedScrollClassName}>
                {nativeTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Native</div>
                        <div className="space-y-1">{nativeTokens.map(renderTokenRow)}</div>
                    </div>
                )}
                {yieldBearingTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Yield-bearing</div>
                        <div className="space-y-1">{yieldBearingTokens.map(renderTokenRow)}</div>
                    </div>
                )}
            </div>
        );
    }

    // Equities with pre-IPO variants (e.g. PreStocks): separate them from the
    // tokenized stock variants, mirroring the Native / Yield-bearing split above.
    const preIpoTokens = tokens.filter(token => token.isPreIpo);
    if (preIpoTokens.length > 0) {
        const stockTokens = tokens.filter(token => !token.isPreIpo);
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/70',
        );

        return (
            <div className={groupedScrollClassName}>
                {stockTokens.length > 0 && (
                    <div>
                        <div className={sectionHeadingClassName}>Stocks</div>
                        <div className="space-y-1">{stockTokens.map(renderTokenRow)}</div>
                    </div>
                )}
                <div>
                    <div className={sectionHeadingClassName}>Pre-IPO</div>
                    <div className="space-y-1">{preIpoTokens.map(renderTokenRow)}</div>
                </div>
            </div>
        );
    }

    return <div className={scrollClassName}>{tokens.map(renderTokenRow)}</div>;
}

export function TokenVariantsBadge({
    group,
    currentAddress,
    linkMode: _linkMode = 'token',
    coingeckoCoinId,
}: TokenVariantsBadgeProps) {
    const [hoverOpen, setHoverOpen] = React.useState(false);
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const isOpen = hoverOpen || drawerOpen;

    const { data, isLoading, error } = useQuery<AssetVariantsResponse>({
        queryKey: ['assets', 'variants', group.id, currentAddress],
        queryFn: ({ signal }) =>
            Effect.runPromise(
                apiJson<AssetVariantsResponse>({
                    url:
                        group.id === 'solana'
                            ? `/api/v1/assets/${encodeURIComponent(group.id)}/variants?mint=${encodeURIComponent(
                                  currentAddress,
                              )}`
                            : `/api/v1/assets/${encodeURIComponent(group.id)}/variants`,
                }),
                { signal },
            ),
        enabled: isOpen,
        staleTime: 60 * 1000,
    });

    const variantCount = React.useMemo(() => {
        // API variants (registry ∪ DB) are the source of truth so admin-added
        // variants show without a redeploy; fall back to the static registry
        // hub until the query has loaded.
        const apiCount = new Set((data?.variants ?? []).map(v => v.mint)).size;
        if (apiCount > 0) return apiCount;
        return new Set(group.addresses.map(item => item.address)).size;
    }, [data?.variants, group.addresses]);
    const variantCountLabel = variantCount > 1 ? `${variantCount}+` : `${variantCount}`;

    const tokens: VariantListItem[] = React.useMemo(() => {
        const variants = data?.variants ?? [];
        const byMint = new Map(variants.map(v => [v.mint, v]));

        const items: VariantListItem[] = [];
        const addresses = variants.length > 0 ? variants.map(v => ({ address: v.mint })) : group.addresses;
        for (const item of addresses) {
            const v = byMint.get(item.address);
            const market = v?.market ?? null;
            const itemLabel = normalizeOptionalText((item as { label?: string }).label);

            const apiSymbol = normalizeOptionalText(v?.symbol);
            const apiName = normalizeOptionalText(v?.name);
            const apiLabel = normalizeOptionalText(v?.label);

            const registryMatch = getVariantByMint(item.address);
            const registrySymbol = normalizeOptionalText(registryMatch?.variant.symbol ?? registryMatch?.asset.symbol);
            const registryName = normalizeOptionalText(
                registryMatch?.variant.name ?? registryMatch?.variant.label ?? registryMatch?.asset.name,
            );
            const kind = v?.kind ?? registryMatch?.variant.kind;

            const fallbackSymbol = extractFallbackSymbolFromLabel(apiLabel || itemLabel);
            const symbol = apiSymbol || fallbackSymbol || registrySymbol || '???';
            const name = apiName || apiLabel || registryName || itemLabel || symbol;
            const decimals = (market?.decimals ?? 0) || 0;
            const liquidity = (market?.liquidity ?? 0) || 0;
            const isPreIpo = isPreIpoVariant({
                tags: registryMatch?.variant.tags ?? [],
                labels: [apiLabel, itemLabel, registryMatch?.variant.label],
            });
            const logoURI = normalizeOptionalText(market?.logoURI) || getMintLogoOverride(item.address);
            const advisory = normalizeAdvisory(v?.advisory);

            const rowLabel = itemLabel || apiLabel;
            items.push({
                address: item.address,
                symbol,
                name,
                ...(rowLabel ? { label: rowLabel } : {}),
                decimals,
                ...(logoURI ? { logoURI } : {}),
                liquidity,
                ...(kind ? { kind } : {}),
                ...(isPreIpo ? { isPreIpo } : {}),
                ...(advisory ? { advisory } : {}),
            });
        }

        return items.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    }, [data?.variants, group.addresses]);

    return (
        <>
            <div className="hidden sm:block">
                <HoverCard
                    open={hoverOpen}
                    onOpenChange={open => {
                        setHoverOpen(open);
                        if (open) {
                            trackEvent('variants_panel_opened', {
                                token_address: currentAddress,
                                surface: 'hover_card',
                            });
                        }
                    }}
                    openDelay={200}
                    closeDelay={120}
                >
                    <HoverCardTrigger asChild>
                        <VariantsTriggerButton isOpen={hoverOpen} variantCountLabel={variantCountLabel} />
                    </HoverCardTrigger>
                    <HoverCardContent
                        side="bottom"
                        align="start"
                        sideOffset={8}
                        className="w-[440px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border-strong bg-[var(--tooltip-bg)] p-1 text-[var(--tooltip-text)] shadow-[0_16px_48px_rgba(0,0,0,0.12)]"
                    >
                        <HoverCardArrow className="fill-[var(--tooltip-bg)]" width={12} height={6} />

                        <div className="flex items-center justify-between gap-4 px-2.5 pt-1.5 pb-2">
                            <div className="flex items-center gap-1 text-xs font-medium text-white">
                                <IconCircleDottedAndCircle className="size-3.5 fill-[var(--tooltip-text)]/70" />
                                <span>Variants</span>
                            </div>
                            <div className="flex items-center gap-1 text-xs font-medium text-white">
                                <IconDrop className="size-3 fill-white/70" />
                                Liquidity
                            </div>
                        </div>

                        <VariantsBody
                            group={group}
                            tokens={tokens}
                            currentAddress={currentAddress}
                            assetId={data?.assetId}
                            coingeckoCoinId={coingeckoCoinId}
                            isLoading={isLoading}
                            error={error}
                            closeOnSelect={false}
                            isDrawer={false}
                            appearance="dark"
                        />
                    </HoverCardContent>
                </HoverCard>
            </div>

            <div className="sm:hidden">
                <Drawer
                    open={drawerOpen}
                    onOpenChange={open => {
                        setDrawerOpen(open);
                        if (open) {
                            trackEvent('variants_panel_opened', {
                                token_address: currentAddress,
                                surface: 'drawer',
                            });
                        }
                    }}
                >
                    <DrawerTrigger asChild>
                        <VariantsTriggerButton isOpen={drawerOpen} variantCountLabel={variantCountLabel} />
                    </DrawerTrigger>
                    <DrawerContent>
                        <DrawerHeader className="px-6 pt-6 pb-4 text-left">
                            <div className="flex items-center justify-between gap-4">
                                <DrawerTitle className="text-title-5 text-sand-1500">Variants</DrawerTitle>
                                <div className="flex items-center gap-1 text-xs font-medium text-sand-600">
                                    Liquidity
                                </div>
                            </div>
                        </DrawerHeader>

                        <VariantsBody
                            group={group}
                            tokens={tokens}
                            currentAddress={currentAddress}
                            assetId={data?.assetId}
                            coingeckoCoinId={coingeckoCoinId}
                            isLoading={isLoading}
                            error={error}
                            closeOnSelect={true}
                            isDrawer={true}
                            appearance="light"
                        />
                    </DrawerContent>
                </Drawer>
            </div>
        </>
    );
}
