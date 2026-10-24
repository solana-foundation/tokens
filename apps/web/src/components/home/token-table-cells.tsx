'use client';

import * as React from 'react';
import Image from 'next/image';
import { IconTriangleFill } from 'symbols-react';

import { cn } from '@tokens/ui/cn';
import { useInlineLatestClose } from '@/hooks/queries/use-inline-latest-close';
import { getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import type { Token } from '@/lib/types';
import { INLINE_CHART_FALLBACK_DAYS, formatPrice } from './token-table-format';

/** Cell renderers shared by the home table and its phone list; formatters live in token-table-format.ts. */

export function TokenTablePriceCell({ token, className }: { token: Token; className?: string }) {
    const shouldUseCanonicalAssetChart = token.canonicalMarketSource === 'clickhouse_stock';
    const latestClose = useInlineLatestClose({
        assetId: token.assetId,
        address: token.address,
        useCanonicalAssetChart: shouldUseCanonicalAssetChart,
        fallbackDays: INLINE_CHART_FALLBACK_DAYS,
    });
    const displayPrice = token.coingeckoId || shouldUseCanonicalAssetChart ? token.price : (latestClose ?? token.price);

    return (
        <span className={cn('block w-full text-right text-[14px] text-[#2D2D2D] font-medium tabular-nums', className)}>
            {formatPrice(displayPrice)}
        </span>
    );
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

export function TokenLogo({ token, size = 26 }: { token: Token; size?: number }) {
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
            <div
                className="rounded-full bg-gray-1400 flex items-center justify-center shrink-0"
                style={{ width: size, height: size }}
            >
                <span className={cn('font-bold text-white', size >= 40 ? 'text-[14px]' : 'text-[10px]')}>
                    {initials}
                </span>
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className="rounded-full bg-gray-50 object-cover shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}
