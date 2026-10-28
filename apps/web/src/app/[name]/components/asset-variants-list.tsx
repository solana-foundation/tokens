'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import * as React from 'react';

import { Tab, TabList, Tabs } from '@solana/design-system/tabs';
import { cn } from '@tokens/ui/cn';
import type { VariantKind } from '@tokens/asset-registry';
import { CHAIN_KINDS, CHAINS, chainSupports, type ChainKind } from '@tokens/asset-registry/chains';
import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { ChainLogo } from '@/components/chain-logo';
import { MarketQualityPill } from '@/components/market-quality-pill';
import { PegStatusPill } from '@/components/peg-status-pill';
import { isTradeBlocked } from '@/lib/asset-advisory';
import type { AssetPageVariantLite } from '@/lib/asset-page-variant';
import { buildVariantHref } from '@/lib/coin-href';
import { formatLargeNumber } from '@/lib/format';
import { compareMarketInclusion, isMarketIncluded, marketQualityVerdict } from '@/lib/market-quality-label';
import {
    chainDisplayLabel,
    groupAssetVariantsByDisplayCategory,
    hasMultipleChains,
    paginateAssetVariantGroups,
} from '@/lib/asset-variant-categories';
import { trackEvent } from '@/lib/posthog-client';
import { formatCompactAddress } from '@/app/token/[address]/lib/format';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { AssetVariantTokenLogo } from './asset-variant-token-logo';

export type VariantWithMarketLite = AssetPageVariantLite;

/** `groupAssetVariantsByDisplayCategory` keys rows by `mint`; v2 rows are `(chain, address)`. */
function toCategorySource<T extends AssetPageVariantLite>(variant: T): T & { mint: string } {
    return { ...variant, mint: variant.address };
}

function kindLabel(kind: VariantKind): string {
    switch (kind) {
        case 'native':
            return 'Native';
        case 'wrapped':
            return 'Wrapped';
        case 'bridged':
            return 'Bridged';
        case 'stablecoin':
            return 'Stablecoin';
        case 'lst':
            return 'LST';
        case 'tokenized_equity':
            return 'Equity';
        case 'etf':
            return 'ETF';
        case 'yield':
            return 'Yield';
        case 'leveraged':
            return 'Leveraged';
        case 'basket':
            return 'Basket';
        default:
            return kind;
    }
}

function normalizeOptionalText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '???') return '';
    if (trimmed === '—') return '';
    if (trimmed.toLowerCase() === 'unknown') return '';
    return trimmed;
}

function formatCompactCount(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return Math.round(value).toLocaleString();
}

function formatExecutionScore(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString();
}

export function AssetVariantsList({
    canonicalAssetId,
    variants,
}: {
    canonicalAssetId: string;
    variants: VariantWithMarketLite[];
}) {
    const PAGE_SIZE = 12;

    // One tab per chain the asset lives on, in config order; Solana leads because the v2 API
    // ranks swap-capable chains first for the primary variant.
    const chainTabs = React.useMemo(() => {
        const present = new Set(variants.map(variant => variant.chain));
        return CHAIN_KINDS.filter(chain => present.has(chain));
    }, [variants]);
    const showChainTabs = chainTabs.length > 1;
    const defaultChain: ChainKind | null = chainTabs.includes('solana') ? 'solana' : (chainTabs[0] ?? null);
    const [selectedChain, setSelectedChain] = React.useState<ChainKind | null>(null);
    const activeChain = selectedChain && chainTabs.includes(selectedChain) ? selectedChain : defaultChain;
    const tabVariants = React.useMemo(
        () => (showChainTabs && activeChain ? variants.filter(variant => variant.chain === activeChain) : variants),
        [activeChain, showChainTabs, variants],
    );

    // Rows the quality guard left out of the totals sort last: a dead pool's
    // reported liquidity must not put it ahead of the pools people trade on.
    const sortedRows = React.useMemo(
        () =>
            tabVariants
                .slice()
                .sort(
                    (a, b) =>
                        compareMarketInclusion(a, b) ||
                        (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0) ||
                        (b.market?.volume24hUSD ?? 0) - (a.market?.volume24hUSD ?? 0),
                ),
        [tabVariants],
    );
    const categorizedRows = React.useMemo(
        () => groupAssetVariantsByDisplayCategory(canonicalAssetId, sortedRows.map(toCategorySource)),
        [canonicalAssetId, sortedRows],
    );
    // Inside a chain tab every card is on the same chain, so the per-card chain pill only shows untabbed.
    const multiChain = React.useMemo(() => hasMultipleChains(tabVariants), [tabVariants]);
    const shouldShowCategorySections = categorizedRows.length > 1;
    // Grouped once over the full list; pages slice through the groups so headings stay stable.
    const groups = React.useMemo(
        () =>
            shouldShowCategorySections
                ? categorizedRows
                : [
                      {
                          category: { id: 'variants', label: 'Variants', order: 0 },
                          variants: sortedRows.map(toCategorySource),
                      },
                  ],
        [categorizedRows, shouldShowCategorySections, sortedRows],
    );

    const [page, setPage] = React.useState(1);
    const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));

    React.useEffect(() => {
        setPage(prev => Math.min(Math.max(1, prev), pageCount));
    }, [pageCount]);

    const pageGroups = paginateAssetVariantGroups(groups, (page - 1) * PAGE_SIZE, PAGE_SIZE);

    return (
        <div className="mt-6">
            {showChainTabs && activeChain ? (
                // Same underline tabs as the dashboard's sub-nav (Overview / API Manager / Lists), with the
                // tab x-padding zeroed so the first label sits flush with the heading (`gap-6` spaces them) and
                // chain logos sized to the label text.
                <div className="mb-5 overflow-x-auto border-b border-border-light [--tab-icon-md:12px] [--tab-padding-x-md:0px]">
                    <Tabs
                        size="md"
                        bordered={false}
                        value={activeChain}
                        onValueChange={value => {
                            const next = chainTabs.find(chain => chain === value);
                            if (!next || next === activeChain) return;
                            trackEvent('variants_chain_tab_changed', {
                                ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                                chain: next,
                                previous_chain: activeChain,
                            });
                            setSelectedChain(next);
                            setPage(1);
                        }}
                    >
                        <TabList className="w-max gap-6">
                            {chainTabs.map(chain => (
                                <Tab
                                    key={chain}
                                    value={chain}
                                    icon={<ChainLogo chain={chain} className="size-3" />}
                                    className="whitespace-nowrap"
                                >
                                    {CHAINS[chain].label}
                                </Tab>
                            ))}
                        </TabList>
                    </Tabs>
                </div>
            ) : null}
            <div className={shouldShowCategorySections ? 'space-y-7' : undefined}>
                {pageGroups.map(group => (
                    <section key={group.category.id}>
                        {shouldShowCategorySections ? (
                            <div className="mb-3 flex items-center gap-3">
                                <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-low">
                                    {group.category.label}
                                </h3>
                                <div className="h-px min-w-6 flex-1 bg-border-extra-light" />
                            </div>
                        ) : null}

                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {group.variants.map(variant => (
                                <AssetVariantCard
                                    key={variant.key}
                                    canonicalAssetId={canonicalAssetId}
                                    variant={variant}
                                    showChain={multiChain}
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </div>

            {sortedRows.length > PAGE_SIZE ? (
                <div className="mt-4 flex items-center justify-between gap-3">
                    <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-full border border-border-light bg-white px-3 py-1.5 text-[12px] text-text-medium shadow-sm transition-colors hover:bg-gray-50 disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => {
                            const next = Math.max(1, page - 1);
                            trackEvent('variants_page_changed', {
                                ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                                page_index: next - 1,
                                previous_page_index: page - 1,
                            });
                            setPage(next);
                        }}
                        disabled={page <= 1}
                    >
                        Prev
                    </button>

                    <div className="flex items-center gap-1.5">
                        {(() => {
                            const maxButtons = 5;
                            const half = Math.floor(maxButtons / 2);
                            const start = Math.max(1, Math.min(page - half, pageCount - maxButtons + 1));
                            const end = Math.min(pageCount, start + maxButtons - 1);

                            return Array.from({ length: end - start + 1 }, (_, i) => start + i).map(p => (
                                <button
                                    key={p}
                                    type="button"
                                    aria-current={p === page ? 'page' : undefined}
                                    className={`inline-flex size-8 items-center justify-center rounded-full border text-[12px] shadow-sm transition-colors ${
                                        p === page
                                            ? 'border-border-medium bg-gray-50 text-text-extra-high'
                                            : 'border-border-light bg-white text-text-medium hover:bg-gray-50'
                                    }`}
                                    onClick={() => {
                                        trackEvent('variants_page_changed', {
                                            ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                                            page_index: p - 1,
                                            previous_page_index: page - 1,
                                        });
                                        setPage(p);
                                    }}
                                >
                                    {p}
                                </button>
                            ));
                        })()}
                    </div>

                    <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-full border border-border-light bg-white px-3 py-1.5 text-[12px] text-text-medium shadow-sm transition-colors hover:bg-gray-50 disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => {
                            const next = Math.min(pageCount, page + 1);
                            trackEvent('variants_page_changed', {
                                ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                                page_index: next - 1,
                                previous_page_index: page - 1,
                            });
                            setPage(next);
                        }}
                        disabled={page >= pageCount}
                    >
                        Next
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function AssetVariantCard({
    canonicalAssetId,
    variant,
    showChain,
}: {
    canonicalAssetId: string;
    variant: VariantWithMarketLite;
    showChain: boolean;
}) {
    const symbol = normalizeOptionalText(variant.displaySymbol);
    const fallbackSymbol = symbol || formatCompactAddress(variant.address);
    const name = (variant.displayName ?? '').trim() || fallbackSymbol;
    const href = buildVariantHref(canonicalAssetId, variant);
    const marketIncluded = isMarketIncluded(variant.market);
    const marketVerdict = marketIncluded ? null : marketQualityVerdict(variant.market?.quality.reasons ?? []);
    const metricClassName = cn(
        'mt-0.5 text-[12px] tabular-nums',
        marketIncluded ? 'text-text-extra-high' : 'text-text-extra-low',
    );
    const logoURI = normalizeLogoSrc(normalizeOptionalText(variant.logoURI) || undefined);
    const textureLogoURI = logoURI ?? null;
    const showTradeCount = typeof variant.market?.trade24h === 'number';
    const executionQuality = chainSupports(variant.chain, 'executionQuality')
        ? (variant.executionQuality ?? null)
        : null;
    const hasExecutionQuality = executionQuality !== null && Number.isFinite(executionQuality.executionScore);
    const advisory = variant.advisory ?? null;
    const explorerName = CHAINS[variant.chain].explorer.name;
    // The card link is internal (`/{asset}?{chain}=`), so it stays
    // enabled for flagged variants; only the frame changes color.
    const isAdvisoryBlocked = isTradeBlocked(advisory);

    return (
        <div className="group relative">
            <Link
                href={href}
                onClick={() =>
                    trackEvent('variant_clicked', {
                        ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                        variant_key: variant.key,
                        variant_chain: variant.chain,
                        variant_address: variant.address,
                        variant_mint: variant.address,
                        ...(symbol ? { variant_symbol: symbol } : {}),
                        ...(advisory ? { advisory_status: advisory.status } : {}),
                        surface: 'asset_variants_list',
                    })
                }
                className={cn(
                    'relative flex h-[144px] flex-col overflow-hidden rounded-2xl border bg-white p-3 shadow-[0_8px_40px_rgba(0,0,0,0.03)] transition-[border-color,background-color] hover:shadow-[0_12px_48px_rgba(0,0,0,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                    isAdvisoryBlocked
                        ? 'border-rose-200 hover:border-rose-300 focus-visible:ring-rose-300'
                        : 'border-border-light hover:border-border-medium focus-visible:ring-border-medium',
                )}
            >
                <div className="pointer-events-none absolute right-2 top-2 flex size-7 items-center justify-center rounded-full border border-border-light bg-white/80 shadow-sm backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <ArrowUpRight
                        className="h-4 w-4 text-text-extra-low transition-colors group-hover:text-text-low"
                        aria-hidden="true"
                    />
                </div>

                {textureLogoURI ? (
                    <Image
                        src={textureLogoURI}
                        alt=""
                        aria-hidden="true"
                        width={96}
                        height={96}
                        className="pointer-events-none absolute -left-5 -top-5 size-[274px] rounded-full object-cover opacity-10 blur-2xl saturate-150"
                        loading="lazy"
                        decoding="async"
                    />
                ) : null}

                <div className="relative z-10 flex h-full flex-col">
                    <div className="flex items-start gap-3">
                        <AssetVariantTokenLogo
                            symbol={symbol}
                            name={name}
                            logoURI={logoURI}
                            tier={variant.liquidityTier}
                        />

                        <div className="min-w-0 flex-1 pr-8">
                            <div className="flex min-w-0 items-baseline gap-1">
                                <span className="truncate text-[13px] font-semibold text-text-extra-high">{name}</span>
                                {symbol ? (
                                    <span className="shrink-0 text-[11px] text-text-low tabular-nums">{symbol}</span>
                                ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                                {showChain ? (
                                    <span className="rounded-full border border-border-light bg-white px-2 py-0.5 text-[10px] font-medium text-text-high">
                                        {chainDisplayLabel(variant.chain)}
                                    </span>
                                ) : null}
                                <span className="rounded-full border border-border-light bg-gray-50 px-2 py-0.5 text-[10px] text-text-medium">
                                    {kindLabel(variant.kind)}
                                </span>
                                <AssetAdvisoryBadge advisory={advisory} size="sm" />
                                <PegStatusPill pegHealth={variant.pegHealth} size="sm" />
                                <MarketQualityPill market={variant.market} size="sm" />
                            </div>
                        </div>
                    </div>

                    <div className="mt-auto grid grid-cols-3 gap-2 pt-2">
                        <div>
                            <div className="text-[9px] text-text-extra-low">Liquidity</div>
                            <div className={metricClassName} title={marketVerdict?.detail}>
                                {variant.market ? formatLargeNumber(variant.market.liquidity) : '—'}
                            </div>
                        </div>
                        <div>
                            <div className="text-[9px] text-text-extra-low">24h Vol</div>
                            <div className={metricClassName} title={marketVerdict?.detail}>
                                {variant.market ? formatLargeNumber(variant.market.volume24hUSD) : '—'}
                            </div>
                        </div>
                        <div>
                            <div className="text-[9px] text-text-extra-low">
                                {hasExecutionQuality ? 'Exec Q' : showTradeCount ? 'Trades' : '1h Vol'}
                            </div>
                            <div className={metricClassName} title={marketVerdict?.detail}>
                                {hasExecutionQuality
                                    ? formatExecutionScore(executionQuality.executionScore)
                                    : showTradeCount
                                      ? formatCompactCount(variant.market?.trade24h)
                                      : variant.market
                                        ? formatLargeNumber(variant.market.volume1hUSD)
                                        : '—'}
                            </div>
                        </div>
                    </div>
                </div>
            </Link>
            <a
                href={variant.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View on ${explorerName}`}
                title={`View on ${explorerName}`}
                className="absolute right-2 top-[42px] z-20 flex size-7 items-center justify-center rounded-full border border-border-light bg-white/80 text-text-extra-low shadow-sm backdrop-blur-sm opacity-0 transition-opacity hover:text-text-high group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100"
                onClick={event => {
                    event.stopPropagation();
                    trackEvent('external_link_clicked', {
                        link_type: 'explorer',
                        link_url: variant.explorerUrl,
                        variant_key: variant.key,
                        variant_chain: variant.chain,
                        surface: 'asset_variants_list',
                    });
                }}
            >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
        </div>
    );
}
