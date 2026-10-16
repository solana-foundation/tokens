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
import {
    CHAINS,
    CHAIN_KINDS,
    chainAddressKey,
    parseChainAddressKey,
    type ChainKind,
} from '@tokens/asset-registry/chains';
import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import type { V2AssetVariantsResponse, V2Variant } from '@/lib/api-v2-types';
import { normalizeAdvisory, type AssetAdvisory } from '@/lib/asset-advisory';
import { SOL_MINT, hasMultipleChains, isPreIpoVariant } from '@/lib/asset-variant-categories';
import { buildVariantHref } from '@/lib/coin-href';
import { getMintLogoOverride } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { apiJson } from '@/effect/api-client';
import { trackEvent } from '@/lib/posthog-client';
import { formatUsd } from '../lib/format';
import { IconChevronRight, IconCircleDottedAndCircle, IconDrop } from 'symbols-react';

interface TokenVariantsBadgeProps {
    group: VariantHub;
    /** `<chain>:<address>` of the variant being viewed (highlighted row). */
    currentKey?: string;
    linkMode?: 'token' | 'coingecko';
    coingeckoCoinId?: string;
}

/** Hub entries are Solana unless they say otherwise (static registry hubs carry no chain). */
function hubEntryKey(item: VariantHub['addresses'][number]): string {
    return chainAddressKey(item.chain ?? 'solana', item.address);
}

function getAddressLabel(group: VariantHub, key: string): string | undefined {
    return group.addresses.find(item => hubEntryKey(item) === key)?.label;
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

interface VariantListItem {
    /** `<chain>:<address>` — the one identifier of a variant. */
    key: string;
    chain: ChainKind;
    address: string;
    symbol: string;
    name: string;
    label?: string;
    logoURI?: string;
    liquidity: number;
    kind?: VariantKind;
    isPreIpo?: boolean;
    advisory: AssetAdvisory | null;
}

type VariantsPanelAppearance = 'dark' | 'light';

/** Analytics props for the viewed variant, derived from its key. */
function currentTrackingProperties(currentKey: string | undefined): Record<string, unknown> {
    const parsed = currentKey ? parseChainAddressKey(currentKey) : null;
    if (!parsed) return currentKey ? { token_key: currentKey } : {};
    return { token_key: currentKey, token_address: parsed.address, token_chain: parsed.chain };
}

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
    /** Show the chain chip (every row, once the panel spans more than one chain). */
    showChain: boolean;
    group: VariantHub;
    currentKey: string | undefined;
    routeName: string;
    closeOnSelect: boolean;
    isDrawer: boolean;
    appearance: VariantsPanelAppearance;
}

function VariantTokenRow({
    token,
    showChain,
    group,
    currentKey,
    routeName,
    closeOnSelect,
    isDrawer,
    appearance,
}: VariantTokenRowProps) {
    const isLight = appearance === 'light';
    const isCurrent = token.key === currentKey;
    const label =
        group.id === 'solana'
            ? undefined
            : normalizeVariantBadgeLabel(getAddressLabel(group, token.key) ?? token.label);
    const shouldShowLabelBadge =
        Boolean(label) && normalizeBadgeToken(label ?? '') !== normalizeBadgeToken(token.symbol);
    const href = buildVariantHref(routeName, token);

    const row = (
        <Link
            href={href}
            onClick={() =>
                trackEvent('variant_clicked', {
                    ...currentTrackingProperties(currentKey),
                    asset_id: group.id,
                    variant_key: token.key,
                    variant_chain: token.chain,
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
                    {showChain ? (
                        <span
                            className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                                isLight
                                    ? 'bg-white text-sand-800 border border-sand-300'
                                    : 'bg-white/15 text-[var(--tooltip-text)] border border-white/20',
                            )}
                        >
                            {CHAINS[token.chain].label}
                        </span>
                    ) : null}
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
    currentKey: string | undefined;
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
    currentKey,
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

    const multiChain = hasMultipleChains(tokens);
    const renderTokenRow = (token: VariantListItem) => (
        <VariantTokenRow
            key={token.key}
            token={token}
            showChain={multiChain}
            group={group}
            currentKey={currentKey}
            routeName={routeName}
            closeOnSelect={closeOnSelect}
            isDrawer={isDrawer}
            appearance={appearance}
        />
    );

    // Cross-chain assets: one section per chain (canonical order) so the
    // deployments read side by side; the kind-based splits below stay for
    // single-chain assets.
    if (multiChain) {
        const sectionHeadingClassName = cn(
            'px-2 py-1 text-[11px] font-medium',
            isLight ? 'text-sand-600' : 'text-white/50',
        );
        return (
            <div className={groupedScrollClassName}>
                {CHAIN_KINDS.map(chain => {
                    const rows = tokens.filter(token => token.chain === chain);
                    if (rows.length === 0) return null;
                    return (
                        <div key={chain}>
                            <div className={sectionHeadingClassName}>{CHAINS[chain].label}</div>
                            <div className="space-y-1">{rows.map(renderTokenRow)}</div>
                        </div>
                    );
                })}
            </div>
        );
    }

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

/** Row from the v2 variants API; registry / logo-override fallbacks are Solana-only. */
function listItemFromV2Variant(v: V2Variant, hubLabel: string | undefined): VariantListItem {
    const itemLabel = normalizeOptionalText(hubLabel);
    const apiSymbol = normalizeOptionalText(v.symbol);
    const apiName = normalizeOptionalText(v.name);
    const apiLabel = normalizeOptionalText(v.label);

    const registryMatch = v.chain === 'solana' ? getVariantByMint(v.address) : null;
    const registrySymbol = normalizeOptionalText(registryMatch?.variant.symbol ?? registryMatch?.asset.symbol);
    const registryName = normalizeOptionalText(
        registryMatch?.variant.name ?? registryMatch?.variant.label ?? registryMatch?.asset.name,
    );
    const kind = v.kind ?? registryMatch?.variant.kind;

    const fallbackSymbol = extractFallbackSymbolFromLabel(apiLabel || itemLabel);
    const symbol = apiSymbol || fallbackSymbol || registrySymbol || '???';
    const name = apiName || apiLabel || registryName || itemLabel || symbol;
    const liquidity = v.market?.liquidity ?? 0;
    const isPreIpo = isPreIpoVariant({
        tags: [...v.tags, ...(registryMatch?.variant.tags ?? [])],
        labels: [apiLabel, itemLabel, registryMatch?.variant.label],
    });
    const logoURI =
        normalizeOptionalText(v.logoURI) || (v.chain === 'solana' ? getMintLogoOverride(v.address) : undefined);
    const rowLabel = itemLabel || apiLabel;

    return {
        key: v.key,
        chain: v.chain,
        address: v.address,
        symbol,
        name,
        ...(rowLabel ? { label: rowLabel } : {}),
        ...(logoURI ? { logoURI } : {}),
        liquidity,
        ...(kind ? { kind } : {}),
        ...(isPreIpo ? { isPreIpo } : {}),
        advisory: normalizeAdvisory(v.advisory),
    };
}

/** Row for a hub entry the API did not return (capped list, or still loading). */
function listItemFromHubEntry(item: VariantHub['addresses'][number]): VariantListItem {
    const chain: ChainKind = item.chain ?? 'solana';
    const itemLabel = normalizeOptionalText(item.label);

    const registryMatch = chain === 'solana' ? getVariantByMint(item.address) : null;
    const registrySymbol = normalizeOptionalText(registryMatch?.variant.symbol ?? registryMatch?.asset.symbol);
    const registryName = normalizeOptionalText(
        registryMatch?.variant.name ?? registryMatch?.variant.label ?? registryMatch?.asset.name,
    );
    const kind = registryMatch?.variant.kind;

    const fallbackSymbol = extractFallbackSymbolFromLabel(itemLabel);
    const symbol = fallbackSymbol || registrySymbol || itemLabel || '???';
    const name = registryName || itemLabel || symbol;
    const isPreIpo = isPreIpoVariant({
        tags: registryMatch?.variant.tags ?? [],
        labels: [itemLabel, registryMatch?.variant.label],
    });
    const logoURI = chain === 'solana' ? getMintLogoOverride(item.address) : undefined;

    return {
        key: chainAddressKey(chain, item.address),
        chain,
        address: item.address,
        symbol,
        name,
        ...(itemLabel ? { label: itemLabel } : {}),
        ...(logoURI ? { logoURI } : {}),
        liquidity: 0,
        ...(kind ? { kind } : {}),
        ...(isPreIpo ? { isPreIpo } : {}),
        advisory: null,
    };
}

export function TokenVariantsBadge({
    group,
    currentKey,
    linkMode: _linkMode = 'token',
    coingeckoCoinId,
}: TokenVariantsBadgeProps) {
    const [hoverOpen, setHoverOpen] = React.useState(false);
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const isOpen = hoverOpen || drawerOpen;

    const { data, isLoading, error } = useQuery<V2AssetVariantsResponse>({
        queryKey: ['assets', 'v2', 'variants', group.id],
        queryFn: ({ signal }) =>
            Effect.runPromise(
                apiJson<V2AssetVariantsResponse>({
                    url: `/api/v2/assets/${encodeURIComponent(group.id)}/variants?sort=liquidity&limit=300`,
                }),
                { signal },
            ),
        enabled: isOpen,
        staleTime: 60 * 1000,
    });

    const tokens: VariantListItem[] = React.useMemo(() => {
        const variants = data?.variants ?? [];
        const hubByKey = new Map(group.addresses.map(item => [hubEntryKey(item), item]));

        // API variants (registry ∪ DB) are the source of truth so admin-added
        // variants show without a redeploy; hub entries the response lacks
        // (capped list, or not loaded yet) are appended so the viewed row is
        // always present.
        const items: VariantListItem[] = [];
        const seen = new Set<string>();
        for (const v of variants) {
            if (seen.has(v.key)) continue;
            seen.add(v.key);
            items.push(listItemFromV2Variant(v, hubByKey.get(v.key)?.label));
        }
        for (const item of group.addresses) {
            const key = hubEntryKey(item);
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(listItemFromHubEntry(item));
        }

        return items.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    }, [data?.variants, group.addresses]);

    const variantCount = React.useMemo(() => {
        // `total` counts every variant the API knows (beyond the 300 cap);
        // the union covers hub-only rows until the query has loaded.
        return Math.max(data?.total ?? 0, tokens.length);
    }, [data?.total, tokens.length]);
    const variantCountLabel = variantCount > 1 ? `${variantCount}+` : `${variantCount}`;

    const panelTrackingProperties = { ...currentTrackingProperties(currentKey), asset_id: group.id };

    return (
        <>
            <div className="hidden sm:block">
                <HoverCard
                    open={hoverOpen}
                    onOpenChange={open => {
                        setHoverOpen(open);
                        if (open) {
                            trackEvent('variants_panel_opened', {
                                ...panelTrackingProperties,
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
                            currentKey={currentKey}
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
                                ...panelTrackingProperties,
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
                            currentKey={currentKey}
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
