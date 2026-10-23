'use client';

import * as React from 'react';
import Image from 'next/image';
import { IconTriangleFill } from 'symbols-react';

import { cn } from '@tokens/ui/cn';
import { useInlineLatestClose } from '@/hooks/queries/use-inline-latest-close';
import { formatSmallPriceDecimal } from '@/lib/format';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import type { Token, TrendingWindow } from '@/lib/types';

/** Formatters and cell renderers shared by the home table and its phone list. */

export const INLINE_CHART_FALLBACK_DAYS = 7;

export const TRENDING_WINDOW_LABELS: Record<TrendingWindow, string> = {
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '6h': '6h',
    '24h': '24h',
};

export function formatPrice(price: number | null | undefined): string {
    if (price == null || isNaN(price)) return '$0.00';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${formatSmallPriceDecimal(price)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function TokenTablePriceCell({ token }: { token: Token }) {
    const shouldUseCanonicalAssetChart = token.canonicalMarketSource === 'clickhouse_stock';
    const latestClose = useInlineLatestClose({
        assetId: token.assetId,
        address: token.address,
        useCanonicalAssetChart: shouldUseCanonicalAssetChart,
        fallbackDays: INLINE_CHART_FALLBACK_DAYS,
    });
    const displayPrice = token.coingeckoId || shouldUseCanonicalAssetChart ? token.price : (latestClose ?? token.price);

    return (
        <span className="block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums">
            {formatPrice(displayPrice)}
        </span>
    );
}

export function formatVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '$0.00';
    if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(2)}B`;
    if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(2)}M`;
    if (volume >= 1_000) return `$${(volume / 1_000).toFixed(2)}K`;
    return `$${volume.toFixed(2)}`;
}

export function formatOptionalVolume(volume: number | null | undefined): string {
    if (volume == null || isNaN(volume)) return '—';
    return formatVolume(volume);
}

export function formatInteger(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString();
}

export function getVolumeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.volume5mUSD;
        case '15m':
            return token.volume15mUSD;
        case '1h':
            return token.volume1hUSD;
        case '6h':
            return token.volume6hUSD;
        case '24h':
            return token.volume24hUSD;
    }
}

export function getTradeForWindow(token: Token, window: TrendingWindow): number | undefined {
    switch (window) {
        case '5m':
            return token.trade5m;
        case '15m':
            return token.trade15m;
        case '1h':
            return token.trade1h;
        case '6h':
            return token.trade6h;
        case '24h':
            return token.trade24h;
    }
}

export function PercentChangeCell({ value }: { value: number }) {
    const isPositive = value >= 0;
    return (
        <span
            className={cn(
                'inline-flex w-full items-center justify-end gap-1 text-[14px] font-medium tabular-nums',
                isPositive ? 'text-green-800' : 'text-red-800',
            )}
        >
            <IconTriangleFill className={cn('size-2 shrink-0 fill-current', !isPositive && 'rotate-180')} aria-hidden />
            {`${Math.abs(value).toFixed(2)}%`}
        </span>
    );
}

export function TokenLogo({ token }: { token: Token }) {
    const [hasError, setHasError] = React.useState(false);

    const symbol = token.symbol || token.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const resolvedLogoURI = normalizeLogoSrc(
        token.trendingRank != null && token.logoURI
            ? token.logoURI
            : getTokenLogoURLWithSecondarySymbol(token.symbol, token.name, token.logoURI),
    );

    if (!resolvedLogoURI || hasError) {
        return (
            <div className="size-[26px] rounded-full bg-gray-1400 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={26}
            height={26}
            className="size-[26px] rounded-full bg-gray-50 object-cover flex-shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}
