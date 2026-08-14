'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import * as React from 'react';

import { formatLargeNumber } from '@/lib/format';
import { groupAssetVariantsByDisplayCategory } from '@/lib/asset-variant-categories';
import { trackEvent } from '@/lib/posthog-client';
import { formatCompactAddress } from '@/app/token/[address]/lib/format';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { AssetVariantTokenLogo } from './asset-variant-token-logo';

import type { LiquidityTier, StockVariantTier, TrustTier, VariantKind } from '@tokens/asset-registry';

interface MarketSnapshotLite {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    trade24h?: number | null;
    logoURI: string | null;
}

interface VariantExecutionQualityLite {
    executionScore: number;
    isEligibleForPrimary: boolean;
    volume24hUSD: number;
    trade24h: number;
    flowSourceCount: number;
}

export interface VariantWithMarketLite {
    mint: string;
    kind: VariantKind;
    liquidityTier?: LiquidityTier;
    trustTier: TrustTier;
    label?: string;
    tags?: readonly string[];
    stockVariantTier?: StockVariantTier;
    market: MarketSnapshotLite | null;
    executionQuality?: VariantExecutionQualityLite | null;
    displaySymbol: string;
    displayName: string;
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
    return Math.round(value).toLocaleString('en-US');
}

function formatExecutionScore(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString('en-US');
}

export function AssetVariantsList({
    canonicalAssetId,
    variants,
}: {
    canonicalAssetId: string;
    variants: VariantWithMarketLite[];
}) {
    const PAGE_SIZE = 12;

    const sortedRows = React.useMemo(
        () =>
            variants
                .slice()
                .sort(
                    (a, b) =>
                        (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0) ||
                        (b.market?.volume24hUSD ?? 0) - (a.market?.volume24hUSD ?? 0),
                ),
        [variants],
    );
    const categorizedRows = React.useMemo(
        () => groupAssetVariantsByDisplayCategory(canonicalAssetId, sortedRows),
        [canonicalAssetId, sortedRows],
    );
    const shouldShowCategorySections = categorizedRows.length > 1;
    const rows = React.useMemo(
        () => (shouldShowCategorySections ? categorizedRows.flatMap(group => group.variants) : sortedRows),
        [categorizedRows, shouldShowCategorySections, sortedRows],
    );

    const [page, setPage] = React.useState(1);
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

    React.useEffect(() => {
        setPage(prev => Math.min(Math.max(1, prev), pageCount));
    }, [pageCount]);

    const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const pageGroups = shouldShowCategorySections
        ? groupAssetVariantsByDisplayCategory(canonicalAssetId, pageRows)
        : [{ category: { id: 'variants', label: 'Variants', order: 0 }, variants: pageRows }];

    return (
        <div className="mt-6">
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
                            {group.variants.map(variant => {
                                const symbol = normalizeOptionalText(variant.displaySymbol);
                                const fallbackSymbol = symbol || formatCompactAddress(variant.mint);
                                const name = (variant.displayName ?? '').trim() || fallbackSymbol;
                                const href = `/${encodeURIComponent(canonicalAssetId)}?solana=${encodeURIComponent(variant.mint)}`;
                                const logoURI = normalizeLogoSrc(
                                    normalizeOptionalText(variant.market?.logoURI) || undefined,
                                );
                                const textureLogoURI = logoURI ?? null;
                                const showTradeCount = typeof variant.market?.trade24h === 'number';
                                const executionQuality = variant.executionQuality ?? null;
                                const hasExecutionQuality =
                                    executionQuality !== null && Number.isFinite(executionQuality.executionScore);

                                return (
                                    <Link
                                        key={variant.mint}
                                        href={href}
                                        onClick={() =>
                                            trackEvent('variant_clicked', {
                                                ...(canonicalAssetId ? { asset_id: canonicalAssetId } : {}),
                                                variant_mint: variant.mint,
                                                ...(symbol ? { variant_symbol: symbol } : {}),
                                                surface: 'asset_variants_list',
                                            })
                                        }
                                        className="group relative flex h-[144px] flex-col overflow-hidden rounded-2xl border border-border-light bg-white p-3 shadow-[0_8px_40px_rgba(0,0,0,0.03)] transition-[border-color,background-color] hover:border-border-medium hover:shadow-[0_12px_48px_rgba(0,0,0,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-medium"
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
                                                    tier={variant.liquidityTier ?? variant.trustTier}
                                                />

                                                <div className="min-w-0 flex-1 pr-8">
                                                    <div className="flex min-w-0 items-baseline gap-1">
                                                        <span className="truncate text-[13px] font-semibold text-text-extra-high">
                                                            {name}
                                                        </span>
                                                        {symbol ? (
                                                            <span className="shrink-0 text-[11px] text-text-low tabular-nums">
                                                                {symbol}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    <div className="mt-1 flex flex-wrap items-center gap-1">
                                                        <span className="rounded-full border border-border-light bg-gray-50 px-2 py-0.5 text-[10px] text-text-medium">
                                                            {kindLabel(variant.kind)}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="mt-auto grid grid-cols-3 gap-2 pt-2">
                                                <div>
                                                    <div className="text-[9px] text-text-extra-low">Liquidity</div>
                                                    <div className="mt-0.5 text-[12px] text-text-extra-high tabular-nums">
                                                        {variant.market
                                                            ? formatLargeNumber(variant.market.liquidity)
                                                            : '—'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div className="text-[9px] text-text-extra-low">24h Vol</div>
                                                    <div className="mt-0.5 text-[12px] text-text-extra-high tabular-nums">
                                                        {variant.market
                                                            ? formatLargeNumber(variant.market.volume24hUSD)
                                                            : '—'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div className="text-[9px] text-text-extra-low">
                                                        {hasExecutionQuality
                                                            ? 'Exec Q'
                                                            : showTradeCount
                                                              ? 'Trades'
                                                              : '1h Vol'}
                                                    </div>
                                                    <div className="mt-0.5 text-[12px] text-text-extra-high tabular-nums">
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
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>

            {rows.length > PAGE_SIZE ? (
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
