'use client';

import { explorerTokenUrl } from '@tokens/asset-registry/chains';
import { buildVariantHref } from '@/lib/coin-href';
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import type { TokenMarket, TokenMarketToken } from '@/lib/birdeye';
import { trackEvent } from '@/lib/posthog-client';
import { formatCompactAddress, formatUsd } from '@/app/token/[address]/lib/format';
import { getPoolProtocolLogo } from '@/app/_components/markets/pool-protocol-logos';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';

export interface VariantTopMarketsResponse {
    assetId: string;
    total: number;
    offset: number;
    limit: number;
    variants: Array<{
        mint: string;
        kind: string;
        liquidityTier?: string;
        trustTier?: string;
        label?: string;
        stockVariantTier?: string;
        symbol?: string;
        name?: string;
        logoURI?: string;
        topMarket: TokenMarket | null;
        protocolToken?: TokenMarketToken;
        topMarkets?: Array<{
            market: TokenMarket;
            protocolToken?: TokenMarketToken;
        }>;
        marketsTotal: number | null;
        totalLiquidity?: number | null;
        lastFetchedAt: number | null;
    }>;
    lastUpdatedAt: number | null;
}

interface FlatMarketRow {
    key: string;
    mint: string;
    market: TokenMarket;
    protocolToken?: TokenMarketToken;
}

function normalizeOptionalText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '???') return '';
    if (trimmed === '—') return '';
    if (trimmed.toLowerCase() === 'unknown') return '';
    return trimmed;
}

function toFiniteOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function variantLabel(variant: VariantTopMarketsResponse['variants'][number]): string {
    return (
        normalizeOptionalText(variant.label) ||
        normalizeOptionalText(variant.name) ||
        normalizeOptionalText(variant.symbol) ||
        formatCompactAddress(variant.mint)
    );
}

function variantSymbol(variant: VariantTopMarketsResponse['variants'][number]): string {
    return (
        normalizeOptionalText(variant.symbol) ||
        normalizeOptionalText(variant.label) ||
        formatCompactAddress(variant.mint)
    );
}

function compareMarketRows(a: FlatMarketRow, b: FlatMarketRow) {
    const volumeDelta = toFiniteOrZero(b.market.volume24h) - toFiniteOrZero(a.market.volume24h);
    if (volumeDelta !== 0) return volumeDelta;

    const liquidityDelta = toFiniteOrZero(b.market.liquidity) - toFiniteOrZero(a.market.liquidity);
    if (liquidityDelta !== 0) return liquidityDelta;

    return a.key.localeCompare(b.key);
}

function flattenRows(variants: VariantTopMarketsResponse['variants']): FlatMarketRow[] {
    return variants.flatMap(variant => {
        const markets =
            variant.topMarkets && variant.topMarkets.length > 0
                ? variant.topMarkets
                : variant.topMarket
                  ? [{ market: variant.topMarket, protocolToken: variant.protocolToken }]
                  : [];

        return markets.map(row => ({
            key: `${variant.mint}:${row.market.address}`,
            mint: variant.mint,
            market: row.market,
            ...(row.protocolToken ? { protocolToken: row.protocolToken } : {}),
        }));
    });
}

function variantHref(assetId: string, mint: string): string {
    return buildVariantHref(assetId, { chain: 'solana', address: mint });
}

function VariantSymbolPill({ logoURI, symbol }: { logoURI?: string; symbol: string }) {
    const [hasLogoError, setHasLogoError] = React.useState(false);
    const showLogo = Boolean(logoURI) && !hasLogoError;
    const initials = (symbol || '??').slice(0, 2).toUpperCase();

    return (
        <span className="inline-flex max-w-36 shrink-0 items-center gap-1.5 rounded-full border border-border-light bg-white/70 px-2 py-1 align-middle text-[12px] font-semibold text-text-extra-high shadow-[0_1px_2px_rgba(20,20,21,0.04)]">
            {showLogo ? (
                <Image
                    src={normalizeLogoSrc(logoURI!)}
                    alt=""
                    width={16}
                    height={16}
                    className="size-4 shrink-0 rounded-full bg-gray-50 object-cover"
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setHasLogoError(true)}
                />
            ) : (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-gray-50 font-sans text-[8px] font-semibold text-text-medium">
                    {initials}
                </span>
            )}
            <span className="truncate">{symbol}</span>
        </span>
    );
}

function VariantHeaderBackdrop({ logoURI }: { logoURI?: string }) {
    const [hasLogoError, setHasLogoError] = React.useState(false);
    if (!logoURI || hasLogoError) return null;

    return (
        <Image
            src={normalizeLogoSrc(logoURI)}
            alt=""
            aria-hidden="true"
            width={112}
            height={112}
            className="pointer-events-none absolute -left-8 top-1/2 size-28 -translate-y-1/2 rounded-full object-cover opacity-20 blur-2xl saturate-150"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setHasLogoError(true)}
        />
    );
}

function MarketTokenAvatar({
    token,
    className,
    preferPoolLogo = false,
}: {
    token: TokenMarketToken | undefined;
    className?: string;
    preferPoolLogo?: boolean;
}) {
    const label =
        normalizeOptionalText(token?.symbol) ||
        normalizeOptionalText(token?.name) ||
        formatCompactAddress(token?.address);
    const initials = (label || '??').slice(0, 2).toUpperCase();
    const iconUrl = normalizeLogoSrc(
        preferPoolLogo ? getPoolProtocolLogo(token) : normalizeOptionalText(token?.icon) || undefined,
    );

    if (!iconUrl) {
        return (
            <div
                className={cn(
                    'flex size-6.5 items-center justify-center rounded-full border border-border-light bg-gray-50 text-[11px] font-sans text-text-medium',
                    className,
                )}
            >
                {initials}
            </div>
        );
    }

    return (
        <Image
            src={iconUrl}
            alt={label || 'Token'}
            width={26}
            height={26}
            className={cn('size-6.5 rounded-full border border-border-light bg-gray-50 object-cover', className)}
            loading="lazy"
            decoding="async"
            unoptimized={/\.(svg|ico)(\?|#|$)/i.test(iconUrl)}
        />
    );
}

function MarketPairAvatars({
    base,
    quote,
    protocol,
}: {
    base?: TokenMarketToken;
    quote?: TokenMarketToken;
    protocol?: TokenMarketToken;
}) {
    const hasBase = Boolean(base?.address || base?.symbol || base?.name || base?.icon);
    const hasQuote = Boolean(quote?.address || quote?.symbol || quote?.name || quote?.icon);
    const hasProtocol = Boolean(protocol?.address || protocol?.symbol || protocol?.name || protocol?.icon);

    if (!hasBase && !hasQuote && !hasProtocol) return null;

    return (
        <div className="flex shrink-0 items-center">
            {hasBase && (
                <MarketTokenAvatar
                    token={base}
                    className={cn((hasQuote || hasProtocol) && 'relative z-30 ring-2 ring-white')}
                />
            )}
            {hasQuote && (
                <MarketTokenAvatar
                    token={quote}
                    className={cn(hasBase && '-ml-2', 'relative z-20', hasProtocol && 'ring-2 ring-white')}
                />
            )}
            {hasProtocol && (
                <MarketTokenAvatar
                    token={protocol}
                    preferPoolLogo
                    className={cn((hasBase || hasQuote) && '-ml-2', 'relative z-10')}
                />
            )}
        </div>
    );
}

function PairCell({ row }: { row: FlatMarketRow }) {
    const market = row.market;
    const protocolToken =
        row.protocolToken ??
        (market.source
            ? {
                  address: market.address,
                  symbol: market.source,
                  name: market.source,
              }
            : undefined);
    const baseSymbol = normalizeOptionalText(market.base?.symbol) || formatCompactAddress(market.base?.address);
    const quoteSymbol = normalizeOptionalText(market.quote?.symbol) || formatCompactAddress(market.quote?.address);

    return (
        <div className="min-w-0">
            <div className="flex items-center gap-3">
                <MarketPairAvatars base={market.base} quote={market.quote} protocol={protocolToken} />
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                        <span className="min-w-0 max-w-[5.5rem] truncate text-[13px] font-medium text-text-extra-high sm:max-w-none sm:text-[14px]">
                            {baseSymbol}
                        </span>
                        <span className="text-[12px] font-sans text-text-extra-low">/</span>
                        <span className="min-w-0 max-w-[4.5rem] truncate text-[13px] font-medium text-text-extra-high sm:max-w-none sm:text-[14px]">
                            {quoteSymbol}
                        </span>
                    </div>
                    <a
                        href={explorerTokenUrl('solana', market.address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group mt-0.5 inline-flex max-w-full items-center gap-1 font-sans text-[11px] text-text-extra-low transition-colors hover:text-text-extra-high"
                        onClick={event => {
                            event.stopPropagation();
                            trackEvent('external_link_clicked', {
                                link_type: 'explorer',
                                link_url: explorerTokenUrl('solana', market.address),
                                source: 'asset_markets_overview',
                            });
                        }}
                    >
                        <span className="truncate">{formatCompactAddress(market.address)}</span>
                        <ArrowUpRight className="size-3 text-text-extra-low transition-colors group-hover:text-text-low" />
                    </a>
                </div>
            </div>
        </div>
    );
}

function MarketCells({ row }: { row: FlatMarketRow }) {
    const market = row.market;
    return (
        <>
            <td className="px-2 py-3 text-right sm:px-4">
                <span className="block text-nowrap font-sans text-[12px] text-text-extra-high tabular-nums sm:text-[14px]">
                    {formatUsd(market.volume24h)}
                </span>
            </td>
            <td className="px-2 py-3 text-right sm:px-4">
                <span className="block text-nowrap font-sans text-[12px] text-text-extra-high tabular-nums sm:text-[14px]">
                    {formatUsd(market.liquidity)}
                </span>
            </td>
        </>
    );
}

function openMarket(row: FlatMarketRow, assetId: string) {
    trackEvent('market_clicked', {
        token_address: row.mint,
        market_address: row.market.address,
        market_source: row.market.source,
        market_liquidity: row.market.liquidity,
        market_volume_24h: row.market.volume24h,
        base_symbol: row.market.base?.symbol,
        quote_symbol: row.market.quote?.symbol,
        source: 'asset_markets_overview',
        ...(assetId ? { asset_id: assetId } : {}),
    });
    window.open(explorerTokenUrl('solana', row.market.address), '_blank', 'noopener,noreferrer');
}

export function AssetMarketsOverviewTable({
    assetId,
    initial,
}: {
    assetId: string;
    initial: VariantTopMarketsResponse;
}) {
    const groupedRows = React.useMemo(() => {
        return (initial.variants ?? []).flatMap(variant => {
            const rows = flattenRows([variant]).sort(compareMarketRows).slice(0, 2);
            if (rows.length === 0) return [];
            return [
                {
                    mint: variant.mint,
                    label: variantLabel(variant),
                    symbol: variantSymbol(variant),
                    logoURI: normalizeOptionalText(variant.logoURI) || undefined,
                    count: variant.marketsTotal ?? rows.length,
                    remainingCount: Math.max((variant.marketsTotal ?? rows.length) - rows.length, 0),
                    totalLiquidity:
                        typeof variant.totalLiquidity === 'number' && Number.isFinite(variant.totalLiquidity)
                            ? variant.totalLiquidity
                            : null,
                    href: variantHref(assetId, variant.mint),
                    rows,
                },
            ];
        });
    }, [assetId, initial.variants]);

    return (
        <div className="rounded-[28px] bg-border-light/30 p-2 sm:p-3">
            <div className="space-y-3">
                {groupedRows.map(group => (
                    <article
                        key={group.mint}
                        className="overflow-hidden rounded-[22px] border border-border-medium bg-white"
                    >
                        <div className="relative overflow-hidden border-b border-border-extra-light px-4 py-3">
                            <VariantHeaderBackdrop logoURI={group.logoURI} />
                            <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <VariantSymbolPill logoURI={group.logoURI} symbol={group.symbol} />
                                    <span className="text-[12px] text-text-extra-low">
                                        <span className="font-medium text-text-high">{group.count}</span>{' '}
                                        {group.count === 1 ? 'market' : 'markets'}
                                        {typeof group.totalLiquidity === 'number' && group.totalLiquidity > 0 ? (
                                            <>
                                                {' '}
                                                |{' '}
                                                <span className="font-medium text-text-high">
                                                    {formatUsd(group.totalLiquidity)}
                                                </span>{' '}
                                                liquidity
                                            </>
                                        ) : null}
                                    </span>
                                </div>
                                <Link
                                    href={group.href}
                                    className="inline-flex shrink-0 items-center gap-1 self-start font-sans text-[12px] font-medium text-text-low transition-colors hover:text-text-extra-high sm:self-auto"
                                    aria-label={`View all ${group.label} markets`}
                                    onClick={() =>
                                        trackEvent('nav_link_clicked', {
                                            destination: 'variant_markets',
                                            link_url: group.href,
                                            source: 'asset_markets_overview',
                                            ...(assetId ? { asset_id: assetId } : {}),
                                        })
                                    }
                                >
                                    {group.remainingCount > 0 ? `View ${group.remainingCount} more` : 'View markets'}
                                    <ArrowUpRight className="size-3" aria-hidden="true" />
                                </Link>
                            </div>
                        </div>
                        <div className="overflow-hidden">
                            <table className="w-full table-fixed border-collapse text-left">
                                <colgroup>
                                    <col className="w-[52%]" />
                                    <col className="w-[24%]" />
                                    <col className="w-[24%]" />
                                </colgroup>
                                <thead>
                                    <tr className="border-b border-border-extra-light bg-gray-50/50">
                                        <th className="py-2.5 pl-4 pr-2 text-left text-[11px] font-medium text-text-extra-low">
                                            Pair
                                        </th>
                                        <th className="px-2 py-2.5 text-right text-[11px] font-medium text-text-extra-low sm:px-4">
                                            24h Vol
                                        </th>
                                        <th className="px-2 py-2.5 text-right text-[11px] font-medium text-text-extra-low sm:px-4">
                                            Liquidity
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border-extra-light">
                                    {group.rows.map(row => (
                                        <tr
                                            key={row.key}
                                            role="button"
                                            tabIndex={0}
                                            className="cursor-pointer transition-colors hover:bg-gray-50/50"
                                            onClick={() => openMarket(row, assetId)}
                                            onKeyDown={event => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    openMarket(row, assetId);
                                                }
                                            }}
                                        >
                                            <td className="py-3 pl-4 pr-2">
                                                <PairCell row={row} />
                                            </td>
                                            <MarketCells row={row} />
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </article>
                ))}
            </div>
        </div>
    );
}
